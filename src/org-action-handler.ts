/**
 * Drain-time org-action gate + approval round-trip (D2.4).
 *
 * The host drains an `org_action` IPC request, re-classifies it host-side
 * (never trusting the container's `stakes_hint`), and either executes it now
 * (safe), holds it pending a distinct approver's approval (gated), or refuses
 * it (red line / out of allowlist / malformed id).
 *
 * The approval reply path is the fail-closed sibling of `parseAbortIntent`:
 * it parses `approve <token>` / `reject <token>`, rejects any non-allowlisted
 * approver, any bot/self message, and `requester === approver`, then runs the
 * atomic single-use consume so a gated action executes exactly once.
 *
 * Pure orchestration over injected dependencies (DB accessors are imported;
 * the approver set, the channel send, the host write client, the clock, the
 * TTL, and the token mint are injected) so it is unit-testable without
 * `index.ts`'s startup.
 */

import crypto from 'crypto';

import {
  approvePendingAction,
  consumePendingAction,
  createPendingAction,
  denyPendingAction,
  getApprovedUnconsumed,
  getPendingAction,
} from './db.js';
import { logger } from './logger.js';
import { parseApprovalIntent } from './approval-trigger.js';
import { isApprover } from './approver-allowlist.js';
import {
  classifyOrgAction,
  renderApprovalSummary,
  type OrgActionRecord,
} from './org-action-gate.js';
import type { OrgActionExecRequest } from './org-action-clients.js';
import type { NewMessage, PendingActionRow } from './types.js';

export interface OrgActionGateDeps {
  // The fail-closed approver set, re-read per call so an operator edit takes
  // effect without a restart.
  approvers: () => Set<string>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  executeAction: (request: OrgActionExecRequest) => Promise<void>;
  now: () => string;
  ttlMs: number;
  // Token mint seam (overridable in tests). Default is a 43-char base64url
  // string from 32 random bytes (>=256 bits of entropy).
  mintToken?: () => string;
}

export interface OrgActionRequestInput {
  action: string;
  target_ref: string;
  reversibility: 'reversible' | 'draft';
  stakes_hint: 'safe' | 'gated';
  citation_refs: string[];
  canonical_args: Record<string, unknown>;
}

export interface OrgActionRequestContext {
  sourceGroup: string;
  chatJid: string;
  requester: string;
}

function defaultMintToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function toClassifierRecord(
  input: OrgActionRequestInput,
  originChannel: string,
): OrgActionRecord {
  return {
    action: input.action,
    target_ref: input.target_ref,
    reversibility: input.reversibility,
    stakes_hint: input.stakes_hint,
    citation_refs: input.citation_refs,
    canonical_args: input.canonical_args,
    origin_channel: originChannel,
  };
}

function rowToClassifierRecord(row: PendingActionRow): OrgActionRecord {
  return {
    action: row.action,
    target_ref: row.target_ref,
    reversibility: row.reversibility,
    stakes_hint: row.stakes_hint,
    citation_refs: JSON.parse(row.citation_refs) as string[],
    canonical_args: JSON.parse(row.canonical_args) as Record<string, unknown>,
    origin_channel: row.chat_jid,
  };
}

function rowToExecRequest(row: PendingActionRow): OrgActionExecRequest {
  return {
    action: row.action,
    target_ref: row.target_ref,
    canonical_args: JSON.parse(row.canonical_args) as Record<string, unknown>,
  };
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * Drain one `org_action` request. Re-classifies host-side; executes a safe
 * action immediately, holds a gated one (row + Slack prompt, no effect), or
 * refuses a red-line / out-of-allowlist / malformed one (no row, no effect).
 */
export async function driveOrgActionRequest(
  input: OrgActionRequestInput,
  ctx: OrgActionRequestContext,
  deps: OrgActionGateDeps,
): Promise<void> {
  const record = toClassifierRecord(input, ctx.chatJid);
  const verdict = classifyOrgAction(record);

  if (verdict === 'refuse') {
    logger.warn(
      { action: input.action, target_ref: input.target_ref, sourceGroup: ctx.sourceGroup },
      'org-action refused host-side (red line / allowlist / id shape)',
    );
    return;
  }

  if (verdict === 'execute') {
    await deps.executeAction({
      action: input.action,
      target_ref: input.target_ref,
      canonical_args: input.canonical_args,
    });
    logger.info(
      { action: input.action, target_ref: input.target_ref },
      'org-action executed host-side (safe)',
    );
    return;
  }

  // hold
  const token = (deps.mintToken ?? defaultMintToken)();
  const createdAt = deps.now();
  const summary = renderApprovalSummary(record);
  const row: PendingActionRow = {
    token,
    source_group: ctx.sourceGroup,
    chat_jid: ctx.chatJid,
    action: input.action,
    target_ref: input.target_ref,
    reversibility: input.reversibility,
    stakes_hint: input.stakes_hint,
    citation_refs: JSON.stringify(input.citation_refs),
    canonical_args: JSON.stringify(input.canonical_args),
    summary,
    requester: ctx.requester,
    state: 'pending',
    created_at: createdAt,
    expires_at: addMs(createdAt, deps.ttlMs),
    approved_by: null,
    consumed_at: null,
  };
  createPendingAction(row);
  await deps.sendMessage(ctx.chatJid, renderApprovalPrompt(token, summary));
  logger.info(
    { token, action: input.action, target_ref: input.target_ref },
    'org-action held pending approval',
  );
}

function renderApprovalPrompt(token: string, summary: string): string {
  return [
    'Approval required for a held internal action.',
    '',
    summary,
    '',
    `Reply \`approve ${token}\` to authorize or \`reject ${token}\` to drop it.`,
    'A different person than the requester must approve.',
  ].join('\n');
}

/**
 * Process an inbound message as a possible approval reply. Returns true if the
 * message was an approval/reject keyword (and was handled — whether it
 * authorized execution, was rejected, or was denied by a fail-closed check),
 * false if it was ordinary text the caller should keep processing.
 *
 * Every reject path is fail-closed: a non-allowlisted approver, a bot/self
 * message, or `requester === approver` leaves the row untouched.
 */
export async function handleApprovalReply(
  chatJid: string,
  msg: NewMessage,
  deps: OrgActionGateDeps,
): Promise<boolean> {
  const intent = parseApprovalIntent(msg.content);
  if (!intent) return false;

  // Fail-closed: never accept an approval from our own bot or any bot/webhook.
  if (msg.is_from_me || msg.is_bot_message) {
    logger.warn(
      { chatJid, token: intent.token },
      'org-action approval rejected: bot/self sender',
    );
    return true;
  }

  const approvers = deps.approvers();
  if (!isApprover(msg.sender, approvers)) {
    logger.warn(
      { chatJid, sender: msg.sender, token: intent.token },
      'org-action approval rejected: sender not in approver allowlist',
    );
    return true;
  }

  const row = getPendingAction(intent.token);
  if (!row) {
    logger.warn(
      { chatJid, token: intent.token },
      'org-action approval for unknown token',
    );
    return true;
  }

  if (row.requester === msg.sender) {
    logger.warn(
      { chatJid, sender: msg.sender, token: intent.token },
      'org-action approval rejected: requester cannot self-approve',
    );
    return true;
  }

  if (intent.kind === 'reject') {
    const denied = denyPendingAction(intent.token);
    await deps.sendMessage(
      chatJid,
      denied
        ? `Rejected and dropped the held action (${intent.token}).`
        : `Cannot reject ${intent.token}: not in a pending state.`,
    );
    return true;
  }

  // approve
  const approved = approvePendingAction(intent.token, msg.sender);
  if (!approved) {
    await deps.sendMessage(
      chatJid,
      `Cannot approve ${intent.token}: already resolved, denied, or expired.`,
    );
    return true;
  }

  await executeApproved(chatJid, intent.token, deps);
  return true;
}

/**
 * Re-classify host-side, atomically consume, then execute. The consume guarded
 * by `WHERE state='approved'` (`.changes === 1`) is the exactly-once gate even
 * under a double-approve or a boot re-drive race. The read-then-consume here is
 * safe because the host is single-threaded JS and there is no `await` between
 * the `getPendingAction` read and the `consumePendingAction` write, so no other
 * caller can interleave and observe a stale `approved` state. The re-classify
 * runs before the consume so a row that re-classifies to refuse is left
 * `approved` for operator inspection rather than consumed-and-discarded.
 */
async function executeApproved(
  chatJid: string,
  token: string,
  deps: OrgActionGateDeps,
): Promise<void> {
  const row = getPendingAction(token);
  if (!row || row.state !== 'approved') return;

  // Never trust the original classification: re-run it on the persisted record.
  const verdict = classifyOrgAction(rowToClassifierRecord(row));
  if (verdict === 'refuse') {
    logger.error(
      { token, action: row.action, target_ref: row.target_ref },
      'org-action re-classified as refuse at approve time — not executing',
    );
    await deps.sendMessage(
      chatJid,
      `Refused ${token}: the action re-classified as a red line on execution.`,
    );
    return;
  }

  const consumed = consumePendingAction(token, deps.now());
  if (!consumed) {
    logger.warn({ token }, 'org-action consume lost the race — not executing');
    return;
  }

  await deps.executeAction(rowToExecRequest(row));
  logger.info(
    { token, action: row.action, target_ref: row.target_ref },
    'org-action executed after approval (exactly-once)',
  );
  await deps.sendMessage(chatJid, `Approved and executed ${token}.`);
}

/**
 * Boot re-drive: replay every approved-but-unconsumed row exactly once. Each
 * goes through the same atomic consume, so a row already consumed by a live
 * approval that landed concurrently is skipped.
 */
export async function reDriveApprovedActions(
  deps: OrgActionGateDeps,
): Promise<void> {
  const rows = getApprovedUnconsumed();
  for (const row of rows) {
    const verdict = classifyOrgAction(rowToClassifierRecord(row));
    if (verdict === 'refuse') {
      logger.error(
        { token: row.token },
        'org-action boot re-drive: re-classified as refuse — skipping',
      );
      continue;
    }
    const consumed = consumePendingAction(row.token, deps.now());
    if (!consumed) continue;
    await deps.executeAction(rowToExecRequest(row));
    logger.info(
      { token: row.token, action: row.action },
      'org-action boot re-drive executed (exactly-once)',
    );
  }
}

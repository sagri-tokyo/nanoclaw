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
 * approver and any bot/self message, then runs the atomic single-use consume so
 * a gated action executes exactly once.
 *
 * SEPARATION-OF-DUTY SCOPE (read before relying on the guard):
 * The dual-control property enforced here is the approver-allowlist gate plus
 * the bot/self reject. It is NOT user-level "the requesting human cannot
 * self-approve". The originating Slack user id is not available at the
 * `org_action` IPC drain: the container is launched per group on a BATCH of
 * laundered messages (potentially several distinct senders), the MCP tool that
 * emits the request runs inside the container with only the group folder as
 * identity, and the triggering user's id is never forwarded into the container
 * or the IPC request. So the persisted `requester_group` is the requesting
 * GROUP FOLDER, not a user. The `requesterGroup !== approver` check below can
 * never be a user-level self-approval guard (a group folder string and a Slack
 * user id never collide); it only excludes the degenerate case where the
 * approver allowlist itself names a group-folder string. Wiring real user-level
 * dual control would require new plumbing to carry the triggering sender id
 * through container launch into the org_action request (tracked separately).
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
  reArmConsumedAction,
} from './db.js';
import { logger } from './logger.js';
import { parseApprovalIntent } from './approval-trigger.js';
import { isApprover } from './approver-allowlist.js';
import {
  classifyOrgAction,
  isNotionPageId,
  isPlainObject,
  isReversibility,
  isStakesHint,
  isStringArray,
  renderApprovalSummary,
  stringContainsRedLine,
  type OrgActionRecord,
  type Reversibility,
  type StakesHint,
} from './org-action-gate.js';
import type {
  NotionTargetResolution,
  OrgActionExecRequest,
} from './org-action-clients.js';
import type { NewMessage, PendingActionRow } from './types.js';

export interface OrgActionGateDeps {
  // The fail-closed approver set, re-read per call so an operator edit takes
  // effect without a restart.
  approvers: () => Set<string>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  executeAction: (request: OrgActionExecRequest) => Promise<void>;
  // Resolve a Notion page NAME to a page id host-side. The operator container
  // has no NOTION_API_KEY after sagri-ai#312, so it cannot resolve the name
  // in-container; the host (which holds the token) does it before classifying.
  resolveNotionTarget: (query: string) => Promise<NotionTargetResolution>;
  now: () => string;
  ttlMs: number;
  // Token mint seam (overridable in tests). Default is a 43-char base64url
  // string from 32 random bytes (>=256 bits of entropy).
  mintToken?: () => string;
}

export interface OrgActionRequestInput {
  action: string;
  target_ref: string;
  // Optional page NAME for a notion.* action whose target_ref is not already a
  // valid id. The host resolves it to an id before classification. Ignored for
  // non-notion actions and when target_ref is already a valid id.
  target_query?: string;
  reversibility: Reversibility;
  stakes_hint: StakesHint;
  citation_refs: string[];
  canonical_args: Record<string, unknown>;
}

export interface OrgActionRequestContext {
  sourceGroup: string;
  chatJid: string;
  // The requesting GROUP FOLDER, not a user id. See the separation-of-duty
  // scope note in the module docstring: user-level dual control is not enforced
  // here because the triggering Slack user id is not available at this drain.
  requesterGroup: string;
}

function defaultMintToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function toClassifierRecord(
  input: OrgActionRequestInput,
  originChannel: string,
  targetTitle?: string,
): OrgActionRecord {
  return {
    action: input.action,
    target_ref: input.target_ref,
    reversibility: input.reversibility,
    stakes_hint: input.stakes_hint,
    citation_refs: input.citation_refs,
    canonical_args: input.canonical_args,
    origin_channel: originChannel,
    target_title: targetTitle,
  };
}

function actionUsesNotionTarget(action: string): boolean {
  return action.startsWith('notion.') || action === 'doc.draft';
}

interface ResolvedTarget {
  input: OrgActionRequestInput;
  targetTitle?: string;
}

/**
 * Resolve a Notion page NAME to a page id host-side, before classification.
 * Returns the (possibly rewritten) input plus the resolved title, or null when
 * resolution refuses. Fail-closed: a red-line query, a zero/multi-match search,
 * or any resolver error returns null (refuse), never a best guess.
 *
 * target_query is honored only for a notion-class action whose target_ref is
 * not already a valid id; it is ignored for github and slack actions and when
 * target_ref is already a valid 32-hex id (existing behavior is unchanged).
 */
async function resolveTargetIfNeeded(
  input: OrgActionRequestInput,
  ctx: OrgActionRequestContext,
  deps: OrgActionGateDeps,
): Promise<ResolvedTarget | null> {
  if (!actionUsesNotionTarget(input.action)) return { input };
  if (isNotionPageId(input.target_ref)) return { input };

  const query = input.target_query;
  if (query === undefined || query.length === 0) return { input };

  // Red line the query BEFORE any Notion call so a name referencing
  // mrv/carbon/jichitai/自治体/prod refuses without touching the API.
  if (stringContainsRedLine(query)) {
    logger.warn(
      { action: input.action, sourceGroup: ctx.sourceGroup },
      'org-action refused host-side: target_query is a red line (no Notion call)',
    );
    return null;
  }

  let resolution: NotionTargetResolution;
  try {
    resolution = await deps.resolveNotionTarget(query);
  } catch (err) {
    logger.warn(
      { action: input.action, sourceGroup: ctx.sourceGroup, err },
      'org-action refused host-side: Notion target resolution errored',
    );
    return null;
  }

  if (resolution.kind === 'unresolved') {
    logger.warn(
      {
        action: input.action,
        reason: resolution.reason,
        sourceGroup: ctx.sourceGroup,
      },
      'org-action refused host-side: Notion target unresolved (zero or many matches)',
    );
    return null;
  }

  return {
    input: { ...input, target_ref: resolution.id },
    targetTitle: resolution.title ?? undefined,
  };
}

interface ParsedPendingRow {
  record: OrgActionRecord;
  execRequest: OrgActionExecRequest;
}

/**
 * Validate a persisted pending row back into typed records on the security
 * path. The DB stores `citation_refs`/`canonical_args` as JSON text and
 * `reversibility`/`stakes_hint` as plain columns; this is the only place that
 * turns those strings back into the shapes the classifier and the exec client
 * trust, so it validates rather than casts. A row that fails any check throws
 * (fail-closed) — a malformed persisted row must never reach `classifyOrgAction`
 * or the write client with an unchecked shape.
 */
function parsePendingRow(row: PendingActionRow): ParsedPendingRow {
  const citationRefs: unknown = JSON.parse(row.citation_refs);
  if (!isStringArray(citationRefs)) {
    throw new Error(
      `org-action: pending row ${row.token} has a non-string[] citation_refs`,
    );
  }

  const canonicalArgs: unknown = JSON.parse(row.canonical_args);
  if (!isPlainObject(canonicalArgs)) {
    throw new Error(
      `org-action: pending row ${row.token} has a non-object canonical_args`,
    );
  }

  if (!isReversibility(row.reversibility)) {
    throw new Error(
      `org-action: pending row ${row.token} has an invalid reversibility "${row.reversibility}"`,
    );
  }
  if (!isStakesHint(row.stakes_hint)) {
    throw new Error(
      `org-action: pending row ${row.token} has an invalid stakes_hint "${row.stakes_hint}"`,
    );
  }

  return {
    record: {
      action: row.action,
      target_ref: row.target_ref,
      reversibility: row.reversibility,
      stakes_hint: row.stakes_hint,
      citation_refs: citationRefs,
      canonical_args: canonicalArgs,
      origin_channel: row.chat_jid,
    },
    execRequest: {
      action: row.action,
      target_ref: row.target_ref,
      canonical_args: canonicalArgs,
    },
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
  // Resolve a Notion page NAME to an id host-side (fail-closed) before the
  // authoritative classify re-validates the resolved id's shape + red line.
  const resolved = await resolveTargetIfNeeded(input, ctx, deps);
  if (!resolved) return;
  const resolvedInput = resolved.input;

  const record = toClassifierRecord(
    resolvedInput,
    ctx.chatJid,
    resolved.targetTitle,
  );
  const verdict = classifyOrgAction(record);

  if (verdict === 'refuse') {
    logger.warn(
      {
        action: resolvedInput.action,
        target_ref: resolvedInput.target_ref,
        sourceGroup: ctx.sourceGroup,
      },
      'org-action refused host-side (red line / allowlist / id shape)',
    );
    return;
  }

  if (verdict === 'execute') {
    await deps.executeAction({
      action: resolvedInput.action,
      target_ref: resolvedInput.target_ref,
      canonical_args: resolvedInput.canonical_args,
    });
    logger.info(
      { action: resolvedInput.action, target_ref: resolvedInput.target_ref },
      'org-action executed host-side (safe)',
    );
    return;
  }

  const token = (deps.mintToken ?? defaultMintToken)();
  const createdAt = deps.now();
  const summary = renderApprovalSummary(record);
  const row: PendingActionRow = {
    token,
    source_group: ctx.sourceGroup,
    chat_jid: ctx.chatJid,
    action: resolvedInput.action,
    target_ref: resolvedInput.target_ref,
    reversibility: resolvedInput.reversibility,
    stakes_hint: resolvedInput.stakes_hint,
    citation_refs: JSON.stringify(resolvedInput.citation_refs),
    canonical_args: JSON.stringify(resolvedInput.canonical_args),
    summary,
    requester: ctx.requesterGroup,
    state: 'pending',
    created_at: createdAt,
    expires_at: addMs(createdAt, deps.ttlMs),
    approved_by: null,
    consumed_at: null,
  };
  createPendingAction(row);
  await deps.sendMessage(ctx.chatJid, renderApprovalPrompt(token, summary));
  logger.info(
    {
      token,
      action: resolvedInput.action,
      target_ref: resolvedInput.target_ref,
    },
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
    'An allow-listed approver must authorize this.',
  ].join('\n');
}

/**
 * Process an inbound message as a possible approval reply. Returns true if the
 * message was an approval/reject keyword (and was handled — whether it
 * authorized execution, was rejected, or was denied by a fail-closed check),
 * false if it was ordinary text the caller should keep processing.
 *
 * Every reject path is fail-closed: a non-allowlisted approver or a bot/self
 * message leaves the row untouched. The `row.requester === msg.sender` check is
 * a group-level guard only (row.requester holds the requesting GROUP FOLDER, not
 * the triggering user id — see the module docstring's separation-of-duty scope),
 * so it does NOT enforce user-level "the requester cannot self-approve".
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

  // Bind the approval to the channel that holds the row. A token leaked into
  // another channel must not be approvable there, and the status reply must
  // never post to a channel other than the one the action was raised in.
  if (row.chat_jid !== chatJid) {
    logger.warn(
      {
        chatJid,
        rowChatJid: row.chat_jid,
        sender: msg.sender,
        token: intent.token,
      },
      'org-action approval rejected: token does not belong to this channel',
    );
    return true;
  }

  // Group-level guard only: row.requester is the requesting group folder, never
  // a user id, so this excludes the degenerate case where the approver allowlist
  // names a group-folder string. It is NOT user-level self-approval prevention.
  if (row.requester === msg.sender) {
    logger.warn(
      { chatJid, sender: msg.sender, token: intent.token },
      'org-action approval rejected: approver matches the requesting group',
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

  const approved = approvePendingAction(intent.token, msg.sender, deps.now());
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
  if (!row || row.state !== 'approved') {
    logger.error(
      { token, state: row?.state ?? 'missing' },
      'org-action executeApproved: row not in approved state — not executing',
    );
    return;
  }

  const parsed = parsePendingRow(row);

  // Never trust the original classification: re-run it on the persisted record.
  const verdict = classifyOrgAction(parsed.record);
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

  // Consume-before-execute is the exactly-once gate, but a thrown executeAction
  // would otherwise strand the row in `consumed` where boot re-drive never sees
  // it. Re-arm to `approved` so the next restart retries, then propagate.
  try {
    await deps.executeAction(parsed.execRequest);
  } catch (err) {
    const rearmed = reArmConsumedAction(token);
    logger.error(
      { token, action: row.action, target_ref: row.target_ref, rearmed, err },
      rearmed
        ? 'org-action execution failed after consume — re-armed for boot re-drive'
        : 'org-action execution failed after consume — re-arm FAILED, row stranded in consumed',
    );
    throw err;
  }
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
    // A corrupt persisted row can never succeed on retry, so it must not strand
    // the healthy rows behind it in the loop (and must not crash the boot). This
    // catch is scoped to the parse only: a write-client failure below is re-armed
    // (consumed -> approved) and then propagated (fail-fast), so the abandoned row
    // is retried on the next restart; rows behind it stay approved for that pass.
    let parsed: ParsedPendingRow;
    try {
      parsed = parsePendingRow(row);
    } catch (err) {
      logger.error(
        { token: row.token, err },
        'org-action boot re-drive: unparseable row — skipping (left approved for inspection)',
      );
      continue;
    }
    const verdict = classifyOrgAction(parsed.record);
    if (verdict === 'refuse') {
      logger.error(
        { token: row.token },
        'org-action boot re-drive: re-classified as refuse — skipping',
      );
      continue;
    }
    const consumed = consumePendingAction(row.token, deps.now());
    if (!consumed) continue;
    try {
      await deps.executeAction(parsed.execRequest);
    } catch (err) {
      const rearmed = reArmConsumedAction(row.token);
      logger.error(
        { token: row.token, action: row.action, rearmed, err },
        rearmed
          ? 'org-action boot re-drive execution failed — re-armed for next restart'
          : 'org-action boot re-drive execution failed — re-arm FAILED, row stranded in consumed',
      );
      throw err;
    }
    logger.info(
      { token: row.token, action: row.action },
      'org-action boot re-drive executed (exactly-once)',
    );
    await deps.sendMessage(
      row.chat_jid,
      `Executed a previously approved action (${row.token}) on restart.`,
    );
  }
}

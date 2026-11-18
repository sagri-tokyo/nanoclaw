/**
 * HMAC integrity for `pending_actions` rows (sagri-ai#708, defense in depth).
 *
 * The approval gate trusts whatever `messages.db` says: boot re-drive executes
 * every `approved` row. If anything other than the host can write the DB (the
 * main container used to mount `store/` rw), a forged `approved` row runs with
 * the host's write clients. The store is no longer mounted, but the gate should
 * not depend on that alone.
 *
 * Two MACs, both keyed by a host-held secret that never enters a container:
 *   - `row_mac`: over the row's immutable content (what will execute, where,
 *     for whom, and the summary the approver was shown). Set at create.
 *   - `approval_mac`: over `row_mac` + the approver id. Set at approve.
 *
 * Both are verified before execute and boot re-drive; `row_mac` is also
 * verified before an approval is accepted. A mismatch (including a missing
 * MAC on a legacy row) fails closed: the row is never executed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PENDING_ACTION_HMAC_KEY_PATH } from './config.js';
import type { PendingActionRow } from './types.js';

const KEY_BYTES = 32;
const ROW_DOMAIN = 'nanoclaw.pending_action.row.v1';
const APPROVAL_DOMAIN = 'nanoclaw.pending_action.approval.v1';

let cachedKey: Buffer | null = null;

/**
 * Read the key, creating it (0600, exclusive) when absent. Any other failure
 * throws, so a caller that cannot obtain the key cannot mint or verify a MAC.
 */
function loadOrCreateKey(keyPath: string): Buffer {
  try {
    const raw = fs.readFileSync(keyPath, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length < KEY_BYTES || key.toString('hex') !== raw.toLowerCase()) {
      throw new Error(
        `pending-action HMAC key at ${keyPath} is malformed (need >= ${KEY_BYTES} bytes hex)`,
      );
    }
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const hex = crypto.randomBytes(KEY_BYTES).toString('hex');
  try {
    fs.writeFileSync(keyPath, hex + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    // Lost a create race: use the file that won.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return loadOrCreateKey(keyPath);
    }
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

function getKey(): Buffer {
  if (!cachedKey) cachedKey = loadOrCreateKey(PENDING_ACTION_HMAC_KEY_PATH);
  return cachedKey;
}

/** @internal - tests only: pin the key so nothing touches ~/.config. */
export function _setPendingActionMacKeyForTests(key: Buffer | null): void {
  cachedKey = key;
}

/** @internal - tests only. */
export function _loadOrCreateKeyForTests(keyPath: string): Buffer {
  return loadOrCreateKey(keyPath);
}

function hmac(domain: string, fields: string[]): string {
  // JSON-encoding the field array makes the serialization unambiguous (no
  // delimiter-injection between adjacent fields).
  return crypto
    .createHmac('sha256', getKey())
    .update(JSON.stringify([domain, ...fields]))
    .digest('hex');
}

type MacInput = Omit<
  PendingActionRow,
  'state' | 'approved_by' | 'consumed_at' | 'row_mac' | 'approval_mac'
>;

export function computeRowMac(row: MacInput): string {
  return hmac(ROW_DOMAIN, [
    row.token,
    row.source_group,
    row.chat_jid,
    row.action,
    row.target_ref,
    row.reversibility,
    row.stakes_hint,
    row.citation_refs,
    row.canonical_args,
    row.summary,
    row.requester,
    row.created_at,
    row.expires_at,
  ]);
}

export function computeApprovalMac(
  token: string,
  rowMac: string,
  approverId: string,
): string {
  return hmac(APPROVAL_DOMAIN, [token, rowMac, approverId]);
}

function safeEqualHex(a: string | null | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** True only when the row's content MAC is present and valid. */
export function verifyRowMac(row: PendingActionRow): boolean {
  return safeEqualHex(row.row_mac, computeRowMac(row));
}

/**
 * True only when both the content MAC and the approval MAC (binding the
 * recorded `approved_by`) are present and valid.
 */
export function verifyApprovedRow(row: PendingActionRow): boolean {
  if (!verifyRowMac(row) || !row.approved_by || !row.row_mac) return false;
  return safeEqualHex(
    row.approval_mac,
    computeApprovalMac(row.token, row.row_mac, row.approved_by),
  );
}

/**
 * Approval reply parser (D2.4), modelled on `abort-trigger.ts`.
 *
 * Pure textual classifier: whole-message anchored, so a human quoting the
 * approval-prompt prose does not trip it. Recognizes exactly:
 *
 *   approve <token>
 *   reject  <token>
 *
 * where <token> is the 43-character base64url host-minted approval token. The
 * verb is case-insensitive; the token is matched exactly (base64url is
 * case-sensitive). Anything before or after is a rejection.
 *
 * This module knows nothing about the DB, the allowlist, or the channel. The
 * intercept point in `inbound.ts` / the handler in `index.ts` turn a positive
 * parse into the approve/deny effect, after the fail-closed approver check.
 */

const TOKEN_PATTERN = '[A-Za-z0-9_-]{43}';
const APPROVE_PATTERN = new RegExp(`^approve\\s+(${TOKEN_PATTERN})$`, 'i');
const REJECT_PATTERN = new RegExp(`^reject\\s+(${TOKEN_PATTERN})$`, 'i');

export interface ApprovalIntent {
  kind: 'approve' | 'reject';
  token: string;
}

export function parseApprovalIntent(content: string): ApprovalIntent | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  const approveMatch = APPROVE_PATTERN.exec(trimmed);
  if (approveMatch) return { kind: 'approve', token: approveMatch[1] };

  const rejectMatch = REJECT_PATTERN.exec(trimmed);
  if (rejectMatch) return { kind: 'reject', token: rejectMatch[1] };

  return null;
}

/**
 * Tool-result copy for the `org_action` MCP tool, extracted so it can be
 * asserted without importing the stdio server module (which connects a
 * transport at import time).
 *
 * The host classifies an org-action authoritatively and now returns its verdict
 * synchronously (nanoclaw#541), so the tool tells the agent exactly what
 * happened: executed, held for approval, or refused. A refusal MUST read as
 * "did not happen" — the whole point of the fix is that the agent can no longer
 * mistake a dropped write for a success.
 */
import type { OrgActionResult } from './org-action-response.js';

export function renderOrgActionResult(result: OrgActionResult): string {
  switch (result.kind) {
    case 'execute':
      return 'Executed by the host. The action is done.';
    case 'hold':
      return 'Held pending human approval — this is a BLOCKER. Do NOT start any dependent work on the assumption it succeeded; the host posts the result asynchronously once an approver acts.';
    case 'refuse':
      return `REFUSED by the host (${result.reason}). The action did NOT happen. Do not record it as done and do not proceed with any work that assumed it succeeded.`;
    case 'unknown':
      return 'Outcome UNKNOWN: the host errored while applying this action, so it may or may not have landed. Verify the target state before retrying. Do not assume either success or failure, and do not blindly retry a non-idempotent write.';
  }
}

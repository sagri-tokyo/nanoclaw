/**
 * Read the host's verdict for an `org_action` request back out of the group's
 * IPC namespace (nanoclaw#541). The host classifies asynchronously and writes
 * the result to `<responsesDir>/<requestId>.json`; this polls for that file so
 * the MCP tool can return the verdict to the agent instead of a neutral
 * "submitted" acknowledgement the agent could mistake for success.
 *
 * Extracted from the stdio server module (which connects a transport at import
 * time) so the poll and parse logic is unit-testable.
 *
 * Fail-closed: a malformed verdict or a timeout throws. A thrown tool call
 * surfaces to the agent as an error — never as a silent success — so a refused
 * or lost write can never be recorded as done.
 */
import fs from 'fs';
import path from 'path';

// Wire contract with the host's OrgActionResult (src/org-action-gate.ts). The
// two live in separate build roots and cannot share a module; keep them in
// sync. reason is widened to string here because the host owns the reason enum
// and the container only relays it.
export type OrgActionResult =
  | { kind: 'execute' }
  | { kind: 'hold'; token: string }
  | { kind: 'refuse'; reason: string }
  | { kind: 'unknown' };

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('org_action response is not a JSON object');
  }
  return value as Record<string, unknown>;
}

export function parseOrgActionResult(raw: string): OrgActionResult {
  const parsed = asObject(JSON.parse(raw));
  const { kind } = parsed;
  if (kind === 'execute') return { kind: 'execute' };
  if (kind === 'hold') {
    const { token } = parsed;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('org_action hold response is missing a token');
    }
    return { kind: 'hold', token };
  }
  if (kind === 'refuse') {
    const { reason } = parsed;
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error('org_action refuse response is missing a reason');
    }
    return { kind: 'refuse', reason };
  }
  if (kind === 'unknown') return { kind: 'unknown' };
  throw new Error(`org_action response has an unknown kind: ${String(kind)}`);
}

export interface AwaitOrgActionResultOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Ceiling: this must exceed the slowest thing the host does inside onOrgAction
// (classify plus one Notion/GitHub write). If a host op runs past this, the
// tool throws "not done" while the host may still complete the write, the
// inverse of the nanoclaw#541 bug. 120s is well above the single-write budget;
// raise it if the host adds a slower synchronous step.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitOrgActionResult(
  responsesDir: string,
  requestId: string,
  options: AwaitOrgActionResultOptions = {},
): Promise<OrgActionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const file = path.join(responsesDir, `${requestId}.json`);
  const deadline = now() + timeoutMs;

  for (;;) {
    // Written atomically by the host (see writeOrgActionResponse); an existing
    // path is always complete.
    if (fs.existsSync(file)) {
      const result = parseOrgActionResult(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
      return result;
    }
    if (now() >= deadline) {
      throw new Error(
        `org_action: host returned no verdict within ${timeoutMs}ms — treat as NOT done`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

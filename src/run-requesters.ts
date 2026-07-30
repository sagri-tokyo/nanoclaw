/**
 * Per-group requester attribution for the org-action approval gate (sagri-ai#296).
 *
 * The `org_action` IPC request carries no sender identity: the MCP tool runs
 * inside the container, which knows only its group folder. The host knows which
 * humans' messages it fed that container, so attribution is recorded here at
 * launch and read back at the drain. It is deliberately NOT carried in the
 * request: the group's IPC directory is mounted writable, so a container that
 * could name its own requester could name an empty set and self-approve.
 *
 * Keyed by group folder, the identity the IPC directory proves. Three values,
 * and the difference between the last two is the whole gate:
 *
 *   - a non-empty set: those humans may not approve.
 *   - `[]`: a scheduled task. Nobody asked, so there is nothing to exclude.
 *   - absent: the host cannot say who asked. `getRunRequesters` returns
 *     `undefined` and the gate refuses to hold rather than offering the action
 *     to an approver who might be the requester.
 *
 * The drain is a 1s poll decoupled from container lifetime, so it can pick up a
 * request after that container exited and the next run already started. While
 * the group has an undrained IPC file, a launch therefore unions into the
 * existing set instead of replacing it, and refuses to attribute at all when
 * there is no existing set to union into (the post-restart case). Attribution
 * can only ever widen, never shift to the wrong humans.
 *
 * KNOWN LIMIT (sagri-ai#629): attribution is per run, but the container resumes
 * the group's Claude session, so run N+1's agent still has run N's messages in
 * context and could act on an instruction whose author is not in run N+1's
 * requester set. Closing that needs session-scoped attribution, which would
 * accumulate every speaker for the session's life and make the gate
 * unsatisfiable; it is a design question, not a patch.
 */

import { logger } from './logger.js';

const requestersByGroupFolder = new Map<string, Set<string>>();

/**
 * Record the requesters of a run being launched. See the module docstring for
 * why `hasUndrainedRequests` unions, and why it declines to attribute rather
 * than attributing the launching run's senders to somebody else's request.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[],
  hasUndrainedRequests: boolean,
): void {
  const existing = requestersByGroupFolder.get(groupFolder);
  if (hasUndrainedRequests && !existing) {
    logger.warn(
      { groupFolder, requesterCount: requesterIds.length },
      'run-requesters: undrained IPC request with no attribution on record (restart?) — leaving the group unattributed so the gate refuses rather than blaming this run',
    );
    return;
  }
  const base = hasUndrainedRequests ? existing : undefined;
  requestersByGroupFolder.set(
    groupFolder,
    new Set([...(base ?? []), ...requesterIds]),
  );
}

/**
 * Add senders of a follow-up batch piped into an already-running container
 * (`GroupQueue.sendMessage`), which does not go through a fresh launch. Without
 * this, a second person's message could drive a gated write while only the
 * original launch's senders were on record.
 */
export function addRunRequesters(
  groupFolder: string,
  requesterIds: string[],
): void {
  const existing = requestersByGroupFolder.get(groupFolder);
  if (!existing) {
    // Never create the entry here: it would miss the launch's own senders and so
    // read as a complete attribution when it is a partial one. Staying absent
    // makes the gate refuse instead.
    logger.warn(
      { groupFolder, requesterCount: requesterIds.length },
      'run-requesters: piped batch for an unattributed group — senders not recorded, gated actions will refuse',
    );
    return;
  }
  for (const id of requesterIds) existing.add(id);
}

/** See the module docstring for what a set, `[]`, and `undefined` each mean. */
export function getRunRequesters(groupFolder: string): string[] | undefined {
  const ids = requestersByGroupFolder.get(groupFolder);
  return ids ? [...ids] : undefined;
}

/** @internal - for tests only. */
export function clearRunRequesters(): void {
  requestersByGroupFolder.clear();
}

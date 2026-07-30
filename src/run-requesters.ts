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
 * KNOWN LIMIT (sagri-ai#629): an interactive run resumes the group's session, so
 * it can act on an instruction from an earlier run whose author this run's set
 * does not name. The scheduled-task path avoids this by claiming `undefined` for
 * a session-resuming run; doing the same for interactive runs would refuse
 * almost everything, so #629 holds the design question.
 */

import { logger } from './logger.js';

const requestersByGroupFolder = new Map<string, Set<string>>();

/**
 * Record the requesters of a run being launched. See the module docstring for
 * the three states and why an undrained request makes this union.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[] | undefined,
  hasUndrainedRequests: boolean,
): void {
  if (requesterIds === undefined) {
    requestersByGroupFolder.delete(groupFolder);
    logger.warn(
      { groupFolder },
      'run-requesters: run launched with unenumerable context — group left unattributed, gated actions will refuse',
    );
    return;
  }

  if (!hasUndrainedRequests) {
    requestersByGroupFolder.set(groupFolder, new Set(requesterIds));
    return;
  }

  const existing = requestersByGroupFolder.get(groupFolder);
  if (!existing) {
    // Nothing to union into means the pending request predates the attribution
    // we hold (a restart). Naming this run's senders would blame them for a
    // request they never made, and clear whoever did make it to approve it.
    logger.warn(
      { groupFolder, requesterCount: requesterIds.length },
      'run-requesters: undrained IPC request with no attribution on record (restart?) — group left unattributed, gated actions will refuse',
    );
    return;
  }
  for (const id of requesterIds) existing.add(id);
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
    // Creating the entry here would miss the launch's own senders, so a partial
    // attribution would read as a complete one.
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

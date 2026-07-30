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
 * request after that container exited and the next run already started. There is
 * one slot per group, shared by a pending request's exclusions and the next run's
 * attribution, so while the group has an undrained IPC file a launch never
 * narrows that slot: it unions its own senders in, declines to attribute when
 * there is nothing to union into (the post-restart case), and clears outright
 * when it cannot enumerate its own context. A pending request can therefore be
 * over-excluded or refused, never handed a set that omits its real requester.
 *
 * Making a pending request keep exactly the set it was raised under would need
 * per-request correlation the drain does not have (it sees a file, not the run
 * that wrote it) or no launch overlap at all. sagri-ai#630 holds that.
 *
 * KNOWN LIMIT (sagri-ai#629), and it is a live bypass, not a theoretical one:
 * an interactive run resumes the group's session, and a launch REPLACES the set.
 * So if Alice asks for a gated write, the run ends without raising it, anyone
 * else then posts, the next run raises it from Alice's resumed instruction and
 * records only that person. Alice approves her own request.
 *
 * The scheduled-task path dodges this by claiming `undefined` for a
 * session-resuming run. Interactive runs cannot: a session outlives many runs,
 * so unioning over it (or claiming `undefined` per run) would refuse nearly
 * every gated action once the approvers had spoken in the channel. Which
 * tradeoff to take is the design question #629 holds.
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
    // Clear unconditionally, including when a request is still undrained. One
    // slot per group serves both that request's exclusions and this run's own
    // attribution, so keeping the set to spare the old request would hand it to
    // this run, whose context the host cannot enumerate — and an inherited `[]`
    // from a preceding isolated task would then exclude nobody at all. The cost
    // is that the undrained request refuses too.
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

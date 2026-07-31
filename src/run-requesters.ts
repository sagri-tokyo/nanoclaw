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
 * one slot per group, shared by a pending request's exclusions, every session the
 * group has open, and the next run's attribution. A launch therefore either
 * widens the slot (unioning its own senders in) or empties it, and never trims it
 * to a smaller non-empty set. That is the invariant: a pending request can be
 * over-excluded, or refused outright, but is never handed a set that omits one of
 * its real requesters.
 *
 * Making a pending request keep exactly the set it was raised under would need
 * per-request correlation the drain does not have (it sees a file, not the run
 * that wrote it) or no launch overlap at all. sagri-ai#630 holds that.
 *
 * The set is scoped to the SESSION, not the run (sagri-ai#629). A run that
 * resumes the group's session still holds the prior runs' messages in the
 * agent's context, so it can act on an instruction nobody repeated this run; a
 * launch that resumes therefore widens the slot instead of replacing it. Only a
 * launch that starts a fresh session replaces, because a fresh session carries
 * no prior context to be attributed.
 *
 * What keeps that from accumulating every human who ever spoke in the channel is
 * the gate itself. When it refuses a gated action because every allow-listed
 * approver is a requester, it drops the session and the slot together
 * (`dropSession` in index.ts), so the re-send starts from its own senders.
 *
 * The trigger is the jam, not a clock and not a proactive coverage check. A time
 * cap bounds the wrong quantity: an hour of a twenty-person channel still names
 * everyone, and a quiet channel it resets was never at risk. Checking coverage on
 * every message bounds the right quantity but pays for it constantly, resetting
 * whenever the approvers happen to have spoken. Resetting at the refusal costs
 * the conversation only when the gate has actually stopped working, and the
 * request that triggered it is already drained, so the re-send does not land on
 * the unattributed path.
 *
 * Stated plainly, because the shape matters: the set is NOT bounded. It grows
 * with the session, and when it has grown enough to break the gate the host
 * throws the conversation away to recover. That is recovery, not a bound.
 *
 * And the container picks the moment. It decides when to emit a gated action, so
 * once the set covers the allowlist it can wipe the group's conversation on
 * demand, repeatedly, including under injected instructions from a page it read.
 * A one-name allowlist makes that condition permanent. What it cannot do is
 * choose the requester set, which is host-attributed, or do it quietly, since
 * every reset posts a refusal to the channel. It costs memory, not authority.
 *
 * A session also does not survive the process, since this map does not;
 * `loadState` drops what it finds rather than resuming context it could never
 * attribute.
 */

import { logger } from './logger.js';

const requestersByGroupFolder = new Map<string, Set<string>>();

/** What a launch can still be acting on beyond its own batch. */
interface LaunchScope {
  /** A request raised under the current slot has not been drained yet. */
  hasUndrainedRequests: boolean;
  /** The agent resumes a session, so earlier runs' messages are still in context. */
  resumesSession: boolean;
}

/**
 * Record the requesters of a run being launched. A run that resumes a session or
 * overlaps an undrained request may only widen the slot; an `undefined` clears
 * it whatever is pending. See the module docstring.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[] | undefined,
  { hasUndrainedRequests, resumesSession }: LaunchScope,
): void {
  if (requesterIds === undefined) {
    // Clears even mid-drain: keeping the set to spare a pending request would
    // hand it to this run instead (see the module docstring), and an inherited
    // `[]` from a preceding isolated task would exclude nobody at all. The
    // pending request pays for it by refusing too.
    requestersByGroupFolder.delete(groupFolder);
    logger.warn(
      { groupFolder },
      'run-requesters: run launched with unenumerable context — group left unattributed, gated actions will refuse',
    );
    return;
  }

  const existing = requestersByGroupFolder.get(groupFolder);

  // Two reasons a launch may not speak for the whole slot: it resumes context
  // this slot already attributes, or a request raised under the slot is still
  // undrained. Either way it may only widen.
  const mustWiden = resumesSession || hasUndrainedRequests;

  if (!existing) {
    if (mustWiden) {
      // Nothing to widen means the context or the pending request predates the
      // attribution we hold (a restart). Naming this run's senders would blame
      // them for a request they never made, and clear whoever did make it to
      // approve it.
      logger.warn(
        {
          groupFolder,
          requesterCount: requesterIds.length,
          resumesSession,
          hasUndrainedRequests,
        },
        'run-requesters: run resumes context or a request with no attribution on record (restart?) — group left unattributed, gated actions will refuse',
      );
      return;
    }
    requestersByGroupFolder.set(groupFolder, new Set(requesterIds));
    return;
  }

  // An empty set is a positive "no human is in THIS run's context" — true of an
  // isolated scheduled task, which shares the group folder but not the session
  // the slot was filled from. Replacing on it would trim a live session's
  // attribution to nobody, so it widens by nothing instead (sagri-ai#630 holds
  // the per-lane split that would let it keep its own empty set).
  if (mustWiden || requesterIds.length === 0) {
    for (const id of requesterIds) existing.add(id);
    return;
  }

  requestersByGroupFolder.set(groupFolder, new Set(requesterIds));
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

/**
 * Drop one group's slot when its session goes away. A launch only replaces the
 * slot when it has senders of its own, so without this a group driven by
 * scheduled tasks alone would hold a dead session's requesters and refuse every
 * gated action. A request still undrained at that point refuses too, the same
 * fail-closed answer an unenumerable launch gets.
 */
export function clearRunRequestersForGroup(groupFolder: string): void {
  requestersByGroupFolder.delete(groupFolder);
}

/** @internal - for tests only. */
export function _clearAllRunRequesters(): void {
  requestersByGroupFolder.clear();
}

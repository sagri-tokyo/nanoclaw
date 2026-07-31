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
 * request after that container exited and the next run already started. The slot
 * alone cannot answer for both: it holds one value, and the next run needs it to
 * mean something different from what the pending request needs.
 *
 * So a launch pins them apart (sagri-ai#630). Before it touches the slot it
 * SNAPSHOTS every request file already sitting in the group's IPC directory
 * against the slot as it stands, and the drain reads a request's snapshot in
 * preference to the slot. A request raised under run A therefore keeps A's
 * requesters however many runs start before it drains, and run B is free to
 * claim the slot for itself. First snapshot wins: the earliest launch after the
 * file appeared is the one that still holds the writing run's attribution.
 *
 * A snapshot records `undefined` too, and that case is the one carrying weight.
 * After a restart the slot is empty, so a request file that outlived the process
 * snapshots as `undefined` and refuses, instead of being handed the senders of
 * whichever run happens to start next — who did not ask for it, and one of whom
 * could otherwise approve their own request.
 *
 * Not fixed here: an isolated scheduled task shares the group folder but not the
 * session, and a request IT writes still reads the live interactive slot. That
 * needs a per-lane slot, which sagri-ai#640 holds.
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
import { requestSessionReset } from './session-reset.js';

const requestersByGroupFolder = new Map<string, Set<string>>();

/**
 * Requesters pinned to one undrained request file, keyed `<folder>/<file>`.
 * A value of `undefined` is a recorded answer ("the host could not say who asked
 * when this launch found the file"), which is why membership is tested with
 * `has` and never by truthiness.
 */
const requestersByRequestFile = new Map<string, string[] | undefined>();

function requestKey(groupFolder: string, requestFile: string): string {
  return `${groupFolder}/${requestFile}`;
}

/** What a launch can still be acting on beyond its own batch. */
interface LaunchScope {
  /** The agent resumes a session, so earlier runs' messages are still in context. */
  resumesSession: boolean;
}

/**
 * Pin the current slot to each request file the host has not drained yet, so the
 * launch that follows can claim the slot without rewriting what those requests
 * were raised under (sagri-ai#630). Call this BEFORE `setRunRequesters`, or the
 * snapshot records the incoming run rather than the one that wrote the file.
 *
 * First snapshot wins: a file that already carries one was pinned by an earlier
 * launch, which was closer to the run that wrote it.
 */
export function snapshotPendingRequests(
  groupFolder: string,
  requestFiles: string[],
): void {
  for (const file of requestFiles) {
    const key = requestKey(groupFolder, file);
    if (requestersByRequestFile.has(key)) continue;
    requestersByRequestFile.set(key, getRunRequesters(groupFolder));
  }
}

/**
 * Forget a request file's pinned requesters once the drain has removed the file.
 * Nothing else may call this: while the file is still there, the pin is the only
 * record of who its run was answering.
 */
export function clearRequestSnapshot(
  groupFolder: string,
  requestFile: string,
): void {
  requestersByRequestFile.delete(requestKey(groupFolder, requestFile));
}

/**
 * Record the requesters of a run being launched. A run that resumes a session
 * may only widen the slot; an `undefined` clears it. See the module docstring.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[] | undefined,
  { resumesSession }: LaunchScope,
): void {
  if (requesterIds === undefined) {
    // Undrained requests are unaffected: they were snapshotted before this call,
    // so they keep the set they were raised under rather than paying for a run
    // that cannot enumerate its own context.
    requestersByGroupFolder.delete(groupFolder);
    logger.warn(
      { groupFolder },
      'run-requesters: run launched with unenumerable context — group left unattributed, gated actions will refuse',
    );
    return;
  }

  const existing = requestersByGroupFolder.get(groupFolder);

  if (!existing) {
    if (resumesSession) {
      // Nothing to widen means the context predates the attribution we hold (a
      // restart). Naming this run's senders would blame them for an instruction
      // they never gave, and clear whoever did give it to approve it.
      //
      // Ask for the session to be dropped, or this is permanent: the run still
      // writes its session id back, so every later launch resumes and lands
      // here again, `addRunRequesters` refuses to create a slot, and the gate's
      // unattributed refusal returns before the branch that would reset. The
      // next launch resumes nothing instead, so it can claim the slot.
      requestSessionReset(groupFolder);
      logger.warn(
        { groupFolder, requesterCount: requesterIds.length },
        'run-requesters: run resumes context with no attribution on record (restart?) — group left unattributed, gated actions will refuse',
      );
      return;
    }
    requestersByGroupFolder.set(groupFolder, new Set(requesterIds));
    return;
  }

  // An empty set is a positive "no human is in THIS run's context" — true of an
  // isolated scheduled task, which shares the group folder but not the session
  // the slot was filled from. Replacing on it would trim a live session's
  // attribution to nobody, so it widens by nothing instead (sagri-ai#640 holds
  // the per-lane split that would let it keep its own empty set).
  if (resumesSession || requesterIds.length === 0) {
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

/**
 * The requesters a drained request answers. Pass the request's file name and it
 * resolves to that file's snapshot when one exists, so a run that started after
 * the file was written cannot rewrite the answer. Omit it, and it reads the live
 * slot, which is what a caller asking about the group rather than one request
 * wants. See the module docstring for what a set, `[]`, and `undefined` mean.
 */
export function getRunRequesters(
  groupFolder: string,
  requestFile?: string,
): string[] | undefined {
  if (requestFile !== undefined) {
    const key = requestKey(groupFolder, requestFile);
    if (requestersByRequestFile.has(key)) {
      return requestersByRequestFile.get(key);
    }
  }
  const ids = requestersByGroupFolder.get(groupFolder);
  return ids ? [...ids] : undefined;
}

/**
 * Drop one group's slot when its session goes away. A launch only replaces the
 * slot when it has senders of its own, so without this a group driven by
 * scheduled tasks alone would hold a dead session's requesters and refuse every
 * gated action. Snapshots survive: a request raised under the dead session is
 * still answering the humans who raised it, and the gate's own recovery path
 * drains it before asking for the drop.
 */
export function clearRunRequestersForGroup(groupFolder: string): void {
  requestersByGroupFolder.delete(groupFolder);
}

/** @internal - for tests only. */
export function _clearAllRunRequesters(): void {
  requestersByGroupFolder.clear();
  requestersByRequestFile.clear();
}

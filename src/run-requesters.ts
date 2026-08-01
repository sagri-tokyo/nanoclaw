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
 * pins every request file already sitting in the group's IPC directory to the
 * slot as it stands, and the drain reads a request's pin in preference to the
 * slot. A request raised under run A therefore keeps A's requesters however many
 * runs start before it drains, and run B is free to claim the slot for itself.
 *
 * A pin records `undefined` too, and that case is the one carrying weight. After
 * a restart the slot is empty, so a request file that outlived the process pins
 * as `undefined` and refuses, instead of being handed the senders of whichever
 * run happens to start next — who did not ask for it, and one of whom could
 * otherwise approve their own request.
 *
 * A pin lives exactly as long as its file, or a container could pick a stale set
 * for a request by deleting a file and reusing its name (`retainRequestPins`).
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

/** What a launch is carrying that its own message batch does not account for. */
interface LaunchScope {
  /** The agent resumes a session, so earlier runs' messages are still in context. */
  resumesSession: boolean;
  /**
   * Request files the host has not drained yet, by name. Passed in rather than
   * read off disk here, so this module stays free of `fs`.
   */
  undrainedRequests: string[];
}

/** First pin wins: an earlier launch was closer to the run that wrote the file. */
function pinPendingRequests(groupFolder: string, requestFiles: string[]): void {
  for (const file of requestFiles) {
    const key = requestKey(groupFolder, file);
    if (requestersByRequestFile.has(key)) continue;
    requestersByRequestFile.set(key, currentSlot(groupFolder));
  }
}

/**
 * Forget a request file's pinned requesters once the drain has removed the file.
 * Nothing else may call this: while the file is still there, the pin is the only
 * record of who its run was answering.
 */
export function clearRequestPin(
  groupFolder: string,
  requestFile: string,
): void {
  requestersByRequestFile.delete(requestKey(groupFolder, requestFile));
}

/**
 * Drop the group's pins for request files the drain can no longer see. The IPC
 * directory is a writable mount, so a container can delete a request file it
 * wrote before the drain reads it; the pin would then outlive its file and be
 * inherited by a later request that reuses the name — a set chosen by the
 * container rather than by the host.
 *
 * Call it with the file set the drain just listed, in the same synchronous block
 * as the listing: a launch that pinned between the two would have that pin
 * dropped here, and its request would fall back to the slot it was pinned away
 * from.
 */
export function retainRequestPins(
  groupFolder: string,
  requestFiles: string[],
): void {
  const keep = new Set(requestFiles);
  const prefix = `${groupFolder}/`;
  for (const key of requestersByRequestFile.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!keep.has(key.slice(prefix.length))) {
      requestersByRequestFile.delete(key);
    }
  }
}

/**
 * Record the requesters of a run being launched, pinning whatever it found
 * undrained first (sagri-ai#630). A run that resumes a session may only widen
 * the slot; an `undefined` clears it. See the module docstring.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[] | undefined,
  { resumesSession, undrainedRequests }: LaunchScope,
): void {
  pinPendingRequests(groupFolder, undrainedRequests);

  if (requesterIds === undefined) {
    // Undrained requests are unaffected: they were pinned above, so they keep
    // the set they were raised under rather than paying for a run that cannot
    // enumerate its own context.
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

function currentSlot(groupFolder: string): string[] | undefined {
  const ids = requestersByGroupFolder.get(groupFolder);
  return ids ? [...ids] : undefined;
}

/**
 * The requesters a drained request answers: its pin when it has one, the group's
 * live slot when it does not. `requestFile` is required, not optional, because
 * the group-wide read IS the sagri-ai#630 bug and an optional parameter leaves it
 * one forgotten argument away. See the module docstring for what a set, `[]`, and
 * `undefined` each mean.
 */
export function getRunRequesters(
  groupFolder: string,
  requestFile: string,
): string[] | undefined {
  const key = requestKey(groupFolder, requestFile);
  if (requestersByRequestFile.has(key)) {
    // Copied, like the slot read below: a caller that mutated what it got back
    // would rewrite the pin for every later read of the same request.
    const pinned = requestersByRequestFile.get(key);
    return pinned ? [...pinned] : undefined;
  }
  return currentSlot(groupFolder);
}

/**
 * Drop one group's slot when its session goes away. A launch only replaces the
 * slot when it has senders of its own, so without this a group driven by
 * scheduled tasks alone would hold a dead session's requesters and refuse every
 * gated action. Pins survive: a request raised under the dead session is still
 * answering the humans who raised it, and the gate's own recovery path drains it
 * before asking for the drop.
 */
export function clearRunRequestersForGroup(groupFolder: string): void {
  requestersByGroupFolder.delete(groupFolder);
}

/** @internal - for tests only. */
export function _clearAllRunRequesters(): void {
  requestersByGroupFolder.clear();
  requestersByRequestFile.clear();
}

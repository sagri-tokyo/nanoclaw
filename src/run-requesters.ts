/**
 * Per-group requester attribution for the org-action approval gate (sagri-ai#296).
 *
 * The `org_action` IPC request carries no sender identity: the MCP tool runs
 * inside the container, which knows only its group folder. The host, however,
 * knows which humans' messages it fed that container, so attribution is recorded
 * here at launch and read back at the drain. It is deliberately NOT carried in
 * the request: the group's IPC directory is mounted writable, so a container that
 * could name its own requester could name an empty set and self-approve.
 *
 * Keyed by group folder, the identity the IPC directory proves. Two properties
 * make that key safe despite the drain being decoupled from container lifetime
 * (a 1s poll that can pick up a request after the container has exited and the
 * next run has already started):
 *
 *   - `undefined` means unattributed, which is NOT the same as "no human asked".
 *     The host is only entitled to say "nobody" for a run it actually launched;
 *     after a restart the map is empty and every pending request is unattributed.
 *     The gate refuses to hold an unattributed action rather than holding one no
 *     requester can be excluded from.
 *   - a launch UNIONS instead of replacing while the group still has undrained
 *     IPC files, so a request raised by the previous run can only ever be
 *     attributed to a superset of its real requesters. Over-restrictive (an extra
 *     approver excluded), never permissive. The set resets on the first launch
 *     that finds the directory drained, which is the normal case, so it does not
 *     grow without bound.
 */

const requestersByGroupFolder = new Map<string, Set<string>>();

/**
 * Record the requesters of a run being launched. Unions into the group's existing
 * set when `hasPendingRequests` is true (a previous run left an undrained IPC
 * file whose attribution must survive), replaces it otherwise.
 */
export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[],
  hasPendingRequests: boolean,
): void {
  const existing = hasPendingRequests
    ? requestersByGroupFolder.get(groupFolder)
    : undefined;
  requestersByGroupFolder.set(
    groupFolder,
    new Set([...(existing ?? []), ...requesterIds]),
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
  if (!existing) return;
  for (const id of requesterIds) existing.add(id);
}

/**
 * The humans attributed to the group's current run, or `undefined` when the host
 * has no record of launching it. An empty array is a positive statement that no
 * human requested the run (a scheduled task); `undefined` is an absence of
 * knowledge and the gate must not treat the two alike.
 */
export function getRunRequesters(groupFolder: string): string[] | undefined {
  const ids = requestersByGroupFolder.get(groupFolder);
  return ids ? [...ids] : undefined;
}

/** @internal - for tests only. */
export function clearRunRequesters(): void {
  requestersByGroupFolder.clear();
}

/**
 * Deferred session resets for the org-action approval gate (sagri-ai#629).
 *
 * The gate asks for a group's session to be forgotten when it refuses a gated
 * action for want of an eligible approver. It cannot do it there and then: the
 * gate runs on the IPC drain, a 1s poll decoupled from container lifetime, so it
 * usually fires while the run is still going. That run then ends and writes its
 * session id back, restoring the session while leaving the requester slot
 * cleared, which is the one state that refuses every gated action with no way
 * out (the unattributed refusal never reaches the branch that would reset).
 *
 * So the request is parked here and taken at the next launch for THAT group,
 * which is after the write-back. Per group, not a global flush: groups run
 * concurrently in their own queue lanes, so draining another group's pending
 * reset on this group's launch would fire it mid-run and land in exactly the
 * state the deferral exists to avoid.
 */

const pending = new Set<string>();

/** Ask for `groupFolder`'s session to be dropped before its next run. */
export function requestSessionReset(groupFolder: string): void {
  pending.add(groupFolder);
}

/**
 * Whether a reset is owed to `groupFolder`, clearing it. Touches no other group.
 */
export function takeSessionReset(groupFolder: string): boolean {
  return pending.delete(groupFolder);
}

/** @internal - for tests only. */
export function _clearSessionResets(): void {
  pending.clear();
}

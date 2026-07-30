/**
 * Per-group requester attribution for the org-action approval gate (sagri-ai#296).
 *
 * The `org_action` IPC request carries no sender identity: the MCP tool runs
 * inside the container, which knows only its group folder. The host, however,
 * knows exactly which humans' messages it fed into that container. This module
 * is the seam between the two — `runContainerAgent` records the attribution at
 * launch, and the IPC drain reads it back when it persists a gated action's
 * `requester`.
 *
 * Keyed by group folder because that is the identity the IPC directory proves.
 * A group's entry is overwritten by its next run and never cleared: an
 * org_action file drained after the container exits must not silently lose its
 * attribution, and a stale entry is over-restrictive (an extra approver is
 * excluded), never permissive.
 */

const requestersByGroupFolder = new Map<string, string[]>();

export function setRunRequesters(
  groupFolder: string,
  requesterIds: string[],
): void {
  requestersByGroupFolder.set(groupFolder, requesterIds);
}

/**
 * The human sender ids attributed to the group's most recent run. Empty for a
 * scheduled task (no human triggered it) and for a group that has not run since
 * boot, which leaves the approver allowlist as the only gate — the pre-#296
 * behavior.
 */
export function getRunRequesters(groupFolder: string): string[] {
  return requestersByGroupFolder.get(groupFolder) ?? [];
}

/** @internal - for tests only. */
export function clearRunRequesters(): void {
  requestersByGroupFolder.clear();
}

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Digest of the repo's agent-runner source tree: every entry's path, size and
 * mtime. A digest rather than a newest-mtime, so a deletion and a revert to an
 * older file both register.
 *
 * Recurses, because a change confined to a subdirectory has to invalidate the
 * copy too.
 */
function relativeEntries(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .sort();
}

export function agentRunnerFingerprint(sourceDir: string): string {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`agent-runner source missing: ${sourceDir}`);
  }
  const entries = relativeEntries(sourceDir);
  const digest = createHash('sha256');
  for (const entry of entries) {
    const stat = fs.statSync(path.join(sourceDir, entry));
    digest.update(`${entry}\0${stat.isFile() ? stat.size : 'dir'}\0`);
    digest.update(`${stat.mtimeMs}\n`);
  }
  return digest.digest('hex');
}

/**
 * Whether a group's cached agent-runner copy is behind the repo source.
 *
 * Compares the repo against a host-owned stamp, never against the cached copy
 * itself. The copy is bind-mounted into the container read-write so agents can
 * customize it, which means container-side code can set any mtime it likes
 * there. Comparing against the copy would let a container pin itself to its own
 * `tool-allowlist.ts` forever by touching a file, so a tightened capability
 * profile would never reach it again. The stamp lives outside the mount.
 *
 * Whole-tree compare, not `index.ts` alone: the tool allowlist lives in
 * `tool-allowlist.ts`, so a profile-only change has to invalidate the copy too.
 *
 * A copy missing any file the source has refreshes whatever the stamp says. The
 * stamp describes the source, so on its own it cannot tell the copy was
 * gutted, and the container can gut it: `/app/src` is mounted read-write. It
 * cannot unlink the mount root, so the usual shape is a directory that still
 * exists and is empty, which is why bare existence is not enough to test.
 *
 * Comparing paths only, never contents or mtimes. A copy that differs forces a
 * refresh, so this direction cannot be used to pin an old policy, only to ask
 * for the current one back. Contents would also refuse to settle, since the
 * copy does not carry the source's mtimes.
 */
export function needsAgentRunnerRefresh(
  sourceDir: string,
  cachedDir: string,
  stampFile: string,
): boolean {
  const fingerprint = agentRunnerFingerprint(sourceDir);
  if (!fs.existsSync(cachedDir) || !fs.existsSync(stampFile)) {
    return true;
  }
  if (fs.readFileSync(stampFile, 'utf-8') !== fingerprint) {
    return true;
  }
  const missing = new Set(relativeEntries(cachedDir));
  return relativeEntries(sourceDir).some((entry) => !missing.has(entry));
}

/**
 * Replace a group's cached copy with the repo source and stamp it.
 *
 * The cached tree is removed first because `fs.cpSync` overlays rather than
 * synchronizes: without the removal a file deleted or renamed in the repo would
 * survive in the copy, and the stamp written afterwards would then mark that
 * divergence current forever. Removing it also means a group customization of a
 * file the repo no longer ships does not outlive the repo, which is the point
 * of the host owning this directory.
 */
export function refreshAgentRunnerCopy(
  sourceDir: string,
  cachedDir: string,
  stampFile: string,
): void {
  // Fingerprint before copying, never after. Stamping afterwards certifies a
  // revision this copy may never have contained, and the next start would then
  // skip the refresh and keep the looser policy. Taken first, the stamp
  // describes at most what was copied, so a source that moved under us fails
  // the next comparison and gets copied again.
  //
  // That closes the certification half only. The remove and copy pair is not
  // atomic, so a deploy landing mid-copy can still leave this run's tree
  // mixing two revisions. The next refresh repairs it; this one does not.
  const fingerprint = agentRunnerFingerprint(sourceDir);
  // Drop the stamp before touching the copy, so it only ever exists over a copy
  // that finished. Anything interrupting the two calls below, a throw or the
  // process dying, leaves no stamp, and the next start refreshes rather than
  // inheriting a current marker over a directory that was emptied and never
  // refilled.
  fs.rmSync(stampFile, { force: true });
  fs.rmSync(cachedDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, cachedDir, { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(stampFile, fingerprint);
}

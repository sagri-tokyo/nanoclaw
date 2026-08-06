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
export function agentRunnerFingerprint(sourceDir: string): string {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`agent-runner source missing: ${sourceDir}`);
  }
  const entries = fs
    .readdirSync(sourceDir, { recursive: true })
    .map((entry) => String(entry))
    .sort();
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
 */
export function needsAgentRunnerRefresh(
  sourceDir: string,
  stampFile: string,
): boolean {
  const fingerprint = agentRunnerFingerprint(sourceDir);
  if (!fs.existsSync(stampFile)) {
    return true;
  }
  return fs.readFileSync(stampFile, 'utf-8') !== fingerprint;
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
  fs.rmSync(cachedDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, cachedDir, { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(stampFile, agentRunnerFingerprint(sourceDir));
}

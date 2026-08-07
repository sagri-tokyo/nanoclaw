import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/** How many times to re-copy when a deploy lands mid-copy before giving up. */
const COPY_ATTEMPTS = 3;

/** Sorted relative paths under `dir`, recursive, files and directories alike. */
function relativeEntries(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .sort();
}

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
 * Asked one source path at a time, never by listing the copy. Listing it would
 * hand the container an availability lever over the host: the directory is
 * theirs to write, `readdirSync` follows symlinks, and one `ln -s . loop`
 * expands into a tree deep enough to stall the single host process that spawns
 * every group's container. Statting the paths the source names caps how many
 * calls a container can provoke at the source's own file count, which the host
 * owns. It does not make any one call instant: a link onto a slow mount still
 * costs whatever that mount costs, as it did before this was a list.
 *
 * Presence only. A file still at its path reads as fine here whether its
 * contents were rewritten or it was swapped for a symlink onto something else,
 * and that is deliberate: customizing this tree is the feature the read-write
 * mount exists for. What forces a refresh is a source-side change, or a path
 * the copy no longer resolves. A symlink loop or a dangling one resolves to
 * nothing, so those refresh rather than throwing.
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
  return relativeEntries(sourceDir).some(
    (entry) => !fs.existsSync(path.join(cachedDir, entry)),
  );
}

/**
 * Replace a group's cached copy with the repo source and stamp it.
 *
 * Staged and renamed into place rather than written over the live copy. That
 * also settles what `fs.cpSync` would otherwise get wrong on its own, since it
 * overlays rather than synchronizes: a file the repo deleted or renamed would
 * survive in an overlaid copy, and the stamp written afterwards would mark that
 * divergence current forever. A group customization of a file the repo no
 * longer ships does not outlive the repo either, which is the point of the host
 * owning this directory.
 */
export function refreshAgentRunnerCopy(
  sourceDir: string,
  cachedDir: string,
  stampFile: string,
): void {
  const staging = `${cachedDir}.staging`;

  // Drop the stamp first, so it only ever exists over a copy that finished.
  // Anything interrupting the work below, a throw or the process dying, leaves
  // no stamp and the next start refreshes instead of inheriting a current
  // marker over a copy that was never completed.
  fs.rmSync(stampFile, { force: true });

  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt++) {
    const before = agentRunnerFingerprint(sourceDir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(sourceDir, staging, { recursive: true });

    // Renaming alone would not be enough: a deploy landing during the copy
    // makes the staged tree itself a mix of two revisions, and promoting that
    // atomically still runs the container on a new entrypoint with the old
    // allowlist. So re-read the source and only promote if it held still.
    if (agentRunnerFingerprint(sourceDir) !== before) {
      continue;
    }

    fs.rmSync(cachedDir, { recursive: true, force: true });
    fs.renameSync(staging, cachedDir);
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, before);
    return;
  }

  // Out of attempts. Throwing fails this spawn, which is the point: the copy
  // still on disk is a revision we have now watched the source move away from,
  // so mounting it would start the container on a policy known to be
  // superseded. No stamp was written, so the next start copies again.
  fs.rmSync(staging, { recursive: true, force: true });
  throw new Error(
    `agent-runner source kept changing during copy: ${sourceDir}`,
  );
}

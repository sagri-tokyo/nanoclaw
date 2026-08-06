import fs from 'fs';
import path from 'path';

function newestMtime(dir: string): number {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (newest, entry) =>
        Math.max(newest, fs.statSync(path.join(dir, entry.name)).mtimeMs),
      0,
    );
}

/**
 * Whether a group's cached agent-runner copy is behind the repo source.
 *
 * Whole-directory compare, not `index.ts` alone: the tool allowlist lives in
 * `tool-allowlist.ts`, so a profile-only change has to invalidate the copy too.
 *
 * Throws if `sourceDir` is missing; the caller checks that first.
 */
export function needsAgentRunnerRefresh(
  sourceDir: string,
  cachedDir: string,
): boolean {
  return (
    !fs.existsSync(cachedDir) || newestMtime(sourceDir) > newestMtime(cachedDir)
  );
}

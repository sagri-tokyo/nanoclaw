import fs from 'fs';
import path from 'path';

function newestMtime(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }
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
 * Compares the whole directory rather than `index.ts` alone: the tool allowlist
 * lives in `tool-allowlist.ts`, so a commit that tightens a capability profile
 * and touches nothing else would otherwise leave every existing group compiling
 * the old list.
 */
export function needsAgentRunnerRefresh(
  sourceDir: string,
  cachedDir: string,
): boolean {
  return (
    !fs.existsSync(cachedDir) || newestMtime(sourceDir) > newestMtime(cachedDir)
  );
}

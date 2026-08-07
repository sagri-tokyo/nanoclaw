import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  needsAgentRunnerRefresh,
  refreshAgentRunnerCopy,
} from './agent-runner-refresh.js';

let root: string;
let source: string;
let cached: string;
let stamp: string;

function write(file: string, body: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function syncFromRepo(): void {
  refreshAgentRunnerCopy(source, cached, stamp);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-refresh-'));
  source = path.join(root, 'source');
  cached = path.join(root, 'cached');
  stamp = path.join(root, 'agent-runner-src.stamp');
  fs.mkdirSync(source);
  write(path.join(source, 'index.ts'), 'a', 1_000_000);
  write(path.join(source, 'tool-allowlist.ts'), 'old', 1_000_000);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent-runner copy staleness', () => {
  it('refreshes a group that has never been stamped', () => {
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('leaves an up-to-date copy alone', () => {
    syncFromRepo();
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(false);
  });

  it('refreshes when only the allowlist changed and index.ts did not', () => {
    syncFromRepo();
    write(path.join(source, 'tool-allowlist.ts'), 'tightened', 2_000_000);

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('refreshes when the change is confined to a subdirectory', () => {
    syncFromRepo();
    write(path.join(source, 'tools', 'nested.ts'), 'new', 2_000_000);

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('refreshes when a source file is deleted', () => {
    syncFromRepo();
    fs.rmSync(path.join(source, 'tool-allowlist.ts'));

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('drops a file the repo deleted instead of leaving it cached', () => {
    syncFromRepo();
    fs.rmSync(path.join(source, 'tool-allowlist.ts'));

    syncFromRepo();

    expect(fs.existsSync(path.join(cached, 'tool-allowlist.ts'))).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(false);
  });

  it('drops the old name after the repo renames a file', () => {
    syncFromRepo();
    fs.renameSync(
      path.join(source, 'index.ts'),
      path.join(source, 'entrypoint.ts'),
    );

    syncFromRepo();

    expect(fs.readdirSync(cached).sort()).toEqual([
      'entrypoint.ts',
      'tool-allowlist.ts',
    ]);
  });

  it('gives a first-time group nothing when the source moves mid-copy', () => {
    const realCopy = fs.cpSync;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      write(path.join(source, 'tool-allowlist.ts'), 'tightened', 5_000_000);
      return result;
    }) as typeof fs.cpSync);

    try {
      refreshAgentRunnerCopy(source, cached, stamp);
    } finally {
      spy.mockRestore();
    }

    // No previous revision to fall back to, so this group gets nothing rather
    // than a half-known policy. Its container fails to build against an empty
    // /app/src, and the next start retries.
    expect(fs.existsSync(cached)).toBe(false);
    expect(fs.existsSync(`${cached}.staging`)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('leaves the old copy whole when the source moves during the copy', () => {
    syncFromRepo();

    const realCopy = fs.cpSync;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      // Stands in for a deploy landing while the copy runs. In-process, so it
      // fires once the real cpSync returns, which is the same observable state
      // the staged tree would be in had the source moved partway.
      write(path.join(source, 'tool-allowlist.ts'), 'tightened', 5_000_000);
      return result;
    }) as typeof fs.cpSync);

    try {
      refreshAgentRunnerCopy(source, cached, stamp);
    } finally {
      spy.mockRestore();
    }

    // Not promoted: the copy this start mounts is the previous revision whole,
    // never a mix of the two, and no staging directory is left behind.
    expect(fs.readdirSync(cached).sort()).toEqual([
      'index.ts',
      'tool-allowlist.ts',
    ]);
    expect(
      fs.readFileSync(path.join(cached, 'tool-allowlist.ts'), 'utf-8'),
    ).toBe('old');
    expect(fs.existsSync(`${cached}.staging`)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('retries after a part-written copy rather than inheriting a stamp', () => {
    syncFromRepo();
    write(path.join(source, 'tool-allowlist.ts'), 'tightened', 2_000_000);

    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      _from: string,
      to: string,
    ) => {
      // Half a copy: the directory lands, the contents never do. The
      // directory surviving is what makes this different from a copy that
      // fails outright, since an absent one is already caught.
      fs.mkdirSync(to, { recursive: true });
      throw new Error('ENOSPC: no space left on device');
    }) as unknown as typeof fs.cpSync);
    try {
      expect(() => refreshAgentRunnerCopy(source, cached, stamp)).toThrow(
        /ENOSPC/,
      );
    } finally {
      spy.mockRestore();
    }

    // The source goes back to exactly what the old stamp described, so only a
    // cleared stamp keeps this from reading as current.
    write(path.join(source, 'tool-allowlist.ts'), 'old', 1_000_000);

    // The failure happened in staging, so the mounted copy is still the whole
    // previous revision rather than a gutted one.
    expect(fs.readdirSync(cached).sort()).toEqual([
      'index.ts',
      'tool-allowlist.ts',
    ]);
    expect(fs.existsSync(stamp)).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('refreshes when the copy is gone but the stamp still matches', () => {
    syncFromRepo();
    fs.rmSync(cached, { recursive: true, force: true });

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('refreshes when the copy is emptied but the directory survives', () => {
    syncFromRepo();
    // What a container can actually do to its own mount: unlink the contents,
    // not the mount root. The directory is still there and still matches the
    // stamp, so existence alone would read this as current.
    for (const entry of fs.readdirSync(cached)) {
      fs.rmSync(path.join(cached, entry), { recursive: true, force: true });
    }

    expect(fs.existsSync(cached)).toBe(true);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('leaves a copy alone that has extra files the source lacks', () => {
    syncFromRepo();
    write(path.join(cached, 'scratch.ts'), 'agent wrote this', 9_000_000);

    // The check is one-directional on purpose: source not in cache. Making it
    // symmetric would wipe a group's own additions on every start.
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(false);
  });

  it('refreshes when the copy is missing a single source file', () => {
    syncFromRepo();
    fs.rmSync(path.join(cached, 'tool-allowlist.ts'));

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('re-copies when the stamp is unreadable rather than skipping', () => {
    syncFromRepo();
    fs.writeFileSync(stamp, '');

    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('names the missing directory rather than failing deep in fs', () => {
    expect(() =>
      needsAgentRunnerRefresh(path.join(root, 'absent'), cached, stamp),
    ).toThrow(/agent-runner source missing/);
  });
});

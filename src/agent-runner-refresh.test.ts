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

  it('refreshes on an edit that keeps the byte length and the mtime', () => {
    syncFromRepo();
    // Same length and same mtime, which is what a deploy copying with
    // timestamps preserved produces. Only hashing the contents catches it.
    write(path.join(source, 'tool-allowlist.ts'), 'new', 1_000_000);

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

  it('gives a first-time group nothing when the source keeps moving', () => {
    const realCopy = fs.cpSync;
    let copies = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      // Fresh contents every attempt, so the source never settles.
      copies += 1;
      write(
        path.join(source, 'tool-allowlist.ts'),
        `tightened ${copies}`,
        5_000_000 + copies * 1_000,
      );
      return result;
    }) as typeof fs.cpSync);

    try {
      expect(() => refreshAgentRunnerCopy(source, cached, stamp)).toThrow(
        /kept changing during copy/,
      );
    } finally {
      spy.mockRestore();
    }

    // No previous revision and nothing promoted, so this group gets nothing.
    // The throw fails the spawn; the next start copies again.
    expect(fs.existsSync(cached)).toBe(false);
    expect(fs.existsSync(`${cached}.staging`)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('refuses to promote while the source keeps moving', () => {
    syncFromRepo();

    const realCopy = fs.cpSync;
    let copies = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      // Stands in for deploys landing while the copy runs. In-process, so each
      // fires once the real cpSync returns, with fresh contents every time so
      // the source never settles and the attempts run out.
      copies += 1;
      write(
        path.join(source, 'tool-allowlist.ts'),
        `tightened ${copies}`,
        5_000_000 + copies * 1_000,
      );
      return result;
    }) as typeof fs.cpSync);

    try {
      expect(() => refreshAgentRunnerCopy(source, cached, stamp)).toThrow(
        /kept changing during copy/,
      );
    } finally {
      spy.mockRestore();
    }

    // Nothing was promoted and no staging tree is left behind. The old copy is
    // still on disk, but the throw stops this spawn from mounting it: we have
    // now watched the source move away from that revision, so launching on it
    // would run a policy we know is superseded.
    expect(fs.existsSync(`${cached}.staging`)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('promotes once the source stops moving', () => {
    syncFromRepo();
    const realCopy = fs.cpSync;
    let copies = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      // Moves during the first copy only, so the retry finds it settled.
      if (++copies === 1) {
        write(path.join(source, 'tool-allowlist.ts'), 'tightened', 5_000_000);
      }
      return result;
    }) as typeof fs.cpSync);

    try {
      refreshAgentRunnerCopy(source, cached, stamp);
    } finally {
      spy.mockRestore();
    }

    expect(copies).toBe(2);
    expect(
      fs.readFileSync(path.join(cached, 'tool-allowlist.ts'), 'utf-8'),
    ).toBe('tightened');
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(false);
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

  it('never lists the copy, so a symlink cycle in it costs nothing', () => {
    syncFromRepo();
    fs.symlinkSync('.', path.join(cached, 'loop'));

    const spy = vi.spyOn(fs, 'readdirSync');
    let listed: string[];
    try {
      expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(false);
      // Read before restoring: mockRestore drops the recorded calls.
      listed = spy.mock.calls.map((call) => String(call[0]));
    } finally {
      spy.mockRestore();
    }

    // The returned value alone does not separate this from listing the copy,
    // since every source path is still present under the loop. Listing is what
    // readdirSync would follow, so assert on that directly.
    expect(listed).not.toContain(cached);
  });

  it('refreshes when a cached path resolves to nothing', () => {
    syncFromRepo();
    fs.rmSync(path.join(cached, 'tool-allowlist.ts'));
    fs.symlinkSync(
      path.join(cached, 'gone.ts'),
      path.join(cached, 'tool-allowlist.ts'),
    );

    // Dangling, so it resolves to nothing and refreshes rather than throwing.
    expect(needsAgentRunnerRefresh(source, cached, stamp)).toBe(true);
  });

  it('does not refresh when a cached file was edited in place', () => {
    syncFromRepo();
    fs.writeFileSync(path.join(cached, 'tool-allowlist.ts'), 'agent edited me');

    // Accepted: the read-write mount exists so groups can customize this tree.
    // Pinned so a later tightening does not break that by accident.
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

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
    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('leaves an up-to-date copy alone', () => {
    syncFromRepo();
    expect(needsAgentRunnerRefresh(source, stamp)).toBe(false);
  });

  it('refreshes when only the allowlist changed and index.ts did not', () => {
    syncFromRepo();
    write(path.join(source, 'tool-allowlist.ts'), 'tightened', 2_000_000);

    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('refreshes when the change is confined to a subdirectory', () => {
    syncFromRepo();
    write(path.join(source, 'tools', 'nested.ts'), 'new', 2_000_000);

    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('refreshes when a source file is deleted', () => {
    syncFromRepo();
    fs.rmSync(path.join(source, 'tool-allowlist.ts'));

    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('drops a file the repo deleted instead of leaving it cached', () => {
    syncFromRepo();
    fs.rmSync(path.join(source, 'tool-allowlist.ts'));

    syncFromRepo();

    expect(fs.existsSync(path.join(cached, 'tool-allowlist.ts'))).toBe(false);
    expect(needsAgentRunnerRefresh(source, stamp)).toBe(false);
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

  it('does not certify a revision that landed mid-copy', () => {
    syncFromRepo();

    const realCopy = fs.cpSync;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((
      ...args: Parameters<typeof fs.cpSync>
    ) => {
      const result = realCopy(...args);
      // a deploy rewrites the allowlist while the copy is in flight
      write(path.join(source, 'tool-allowlist.ts'), 'tightened', 5_000_000);
      return result;
    }) as typeof fs.cpSync);

    try {
      refreshAgentRunnerCopy(source, cached, stamp);
    } finally {
      spy.mockRestore();
    }

    expect(
      fs.readFileSync(path.join(cached, 'tool-allowlist.ts'), 'utf-8'),
    ).toBe('old');
    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('re-copies when the stamp is unreadable rather than skipping', () => {
    syncFromRepo();
    fs.writeFileSync(stamp, '');

    expect(needsAgentRunnerRefresh(source, stamp)).toBe(true);
  });

  it('names the missing directory rather than failing deep in fs', () => {
    expect(() =>
      needsAgentRunnerRefresh(path.join(root, 'absent'), stamp),
    ).toThrow(/agent-runner source missing/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { needsAgentRunnerRefresh } from './agent-runner-refresh.js';

let root: string;
let source: string;
let cached: string;

function write(dir: string, name: string, body: string, mtimeMs: number): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-refresh-'));
  source = path.join(root, 'source');
  cached = path.join(root, 'cached');
  fs.mkdirSync(source);
  fs.mkdirSync(cached);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent-runner copy staleness', () => {
  it('refreshes a group that has no copy yet', () => {
    write(source, 'index.ts', 'a', 1_000_000);
    expect(needsAgentRunnerRefresh(source, path.join(root, 'absent'))).toBe(
      true,
    );
  });

  it('leaves an up-to-date copy alone', () => {
    write(source, 'index.ts', 'a', 1_000_000);
    write(cached, 'index.ts', 'a', 1_000_000);
    expect(needsAgentRunnerRefresh(source, cached)).toBe(false);
  });

  it('refreshes when only the allowlist changed and index.ts did not', () => {
    write(source, 'index.ts', 'a', 1_000_000);
    write(source, 'tool-allowlist.ts', 'new', 2_000_000);
    write(cached, 'index.ts', 'a', 1_000_000);
    write(cached, 'tool-allowlist.ts', 'old', 1_000_000);

    expect(needsAgentRunnerRefresh(source, cached)).toBe(true);
  });

  it('refreshes when the repo adds a file the copy has never seen', () => {
    write(source, 'index.ts', 'a', 1_000_000);
    write(source, 'tool-allowlist.ts', 'new', 1_500_000);
    write(cached, 'index.ts', 'a', 1_000_000);

    expect(needsAgentRunnerRefresh(source, cached)).toBe(true);
  });

  it('refreshes a missing copy even when the repo source is empty', () => {
    expect(needsAgentRunnerRefresh(source, path.join(root, 'absent'))).toBe(
      true,
    );
  });

  it('keeps a group customization newer than the repo', () => {
    write(source, 'index.ts', 'a', 1_000_000);
    write(cached, 'index.ts', 'customized', 3_000_000);
    expect(needsAgentRunnerRefresh(source, cached)).toBe(false);
  });
});

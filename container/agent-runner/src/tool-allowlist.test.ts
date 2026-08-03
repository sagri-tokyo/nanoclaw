import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TOOL_ALLOWLIST_MANIFEST_PATH,
  allowedToolsFor,
  toolAllowlistByProfile,
} from './tool-allowlist.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function readManifest(): Record<string, string[]> {
  return JSON.parse(fs.readFileSync(TOOL_ALLOWLIST_MANIFEST_PATH, 'utf-8'));
}

function registeredMcpTools(): string[] {
  const source = fs.readFileSync(path.join(here, 'ipc-mcp-stdio.ts'), 'utf-8');
  return [...source.matchAll(/^server\.tool\(\n\s+'([a-z_]+)',/gm)].map(
    (match) => `mcp__nanoclaw__${match[1]}`,
  );
}

describe('capability profiles resolve to separate tool lists', () => {
  it('gives trusted-writer a strict subset of the operator surface', () => {
    const operator = allowedToolsFor('operator');
    const trustedWriter = allowedToolsFor('trusted-writer');

    expect(trustedWriter).not.toEqual(operator);
    expect(operator).toEqual(expect.arrayContaining(trustedWriter));
    expect(trustedWriter.length).toBeLessThan(operator.length);
  });

  it('denies the token-holding profile the scheduler and team surface', () => {
    expect(allowedToolsFor('trusted-writer')).toEqual([
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'mcp__nanoclaw__send_message',
      'mcp__nanoclaw__fetch_untrusted',
      'mcp__nanoclaw__fetch_untrusted_list',
      'mcp__nanoclaw__org_action',
      'mcp__nanoclaw__report_outcome',
    ]);
  });

  it('resolves an absent profile to operator, matching the host mount plan', () => {
    expect(allowedToolsFor(undefined)).toEqual(allowedToolsFor('operator'));
  });

  it('throws on a profile it does not know', () => {
    expect(() => allowedToolsFor('root' as 'operator')).toThrow(
      /unknown capability profile: root/,
    );
  });
});

describe('the checked-in manifest matches the runtime surface', () => {
  it('enumerates the same tools the runtime allows, per profile', () => {
    expect(readManifest()).toEqual(toolAllowlistByProfile);
  });

  it('is the only place index.ts gets its allowedTools from', () => {
    const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf-8');
    expect(source).toContain('allowedTools: allowedToolsFor(');
    expect(source).not.toMatch(/allowedTools: \[/);
  });

  it('names every MCP tool the server registers, and no others', () => {
    const manifested = new Set(
      Object.values(readManifest())
        .flat()
        .filter((tool) => tool.startsWith('mcp__nanoclaw__')),
    );
    expect([...manifested].sort()).toEqual(registeredMcpTools().sort());
  });
});

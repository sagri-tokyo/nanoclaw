import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { allowedToolsFor, toolAllowlistByProfile } from './tool-allowlist.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function readManifest(): Record<string, string[]> {
  return JSON.parse(
    fs.readFileSync(path.join(here, '..', 'tool-allowlist.json'), 'utf-8'),
  );
}

function registeredMcpTools(): string[] {
  const source = fs.readFileSync(path.join(here, 'ipc-mcp-stdio.ts'), 'utf-8');
  return [...source.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map(
    (match) => `mcp__nanoclaw__${match[1]}`,
  );
}

function hostProfiles(): string[] {
  const source = fs.readFileSync(
    path.join(here, '..', '..', '..', 'src', 'types.ts'),
    'utf-8',
  );
  const union = source.match(/export type CapabilityProfile =([^;]+);/);
  if (!union) {
    throw new Error('no CapabilityProfile union found in src/types.ts');
  }
  return [...union[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

describe('capability profiles resolve to separate tool lists', () => {
  it('gives trusted-writer a strict subset of the operator surface', () => {
    const operator = allowedToolsFor('operator');
    const trustedWriter = allowedToolsFor('trusted-writer');

    expect(operator).toEqual(expect.arrayContaining(trustedWriter));
    expect(trustedWriter.length).toBeLessThan(operator.length);
  });

  it('denies the token-holding profile the scheduler and team surface', () => {
    const trustedWriter = allowedToolsFor('trusted-writer');
    const denied = allowedToolsFor('operator').filter(
      (tool) => !trustedWriter.includes(tool),
    );

    expect(denied).toEqual([
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'NotebookEdit',
      'mcp__nanoclaw__schedule_task',
      'mcp__nanoclaw__list_tasks',
      'mcp__nanoclaw__pause_task',
      'mcp__nanoclaw__resume_task',
      'mcp__nanoclaw__cancel_task',
      'mcp__nanoclaw__update_task',
      'mcp__nanoclaw__register_group',
    ]);
  });

  it('resolves an absent profile to operator, matching the host mount plan', () => {
    expect(allowedToolsFor(undefined)).toEqual(allowedToolsFor('operator'));
  });

  it('throws on a profile it does not know', () => {
    expect(() => allowedToolsFor('root')).toThrow(
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
    expect(source).toContain(
      'allowedTools: allowedToolsFor(containerInput.capabilityProfile)',
    );
    expect(source).not.toMatch(/allowedTools: \[/);
  });

  it('grants the same profiles the host will send', () => {
    expect(Object.keys(readManifest()).sort()).toEqual(hostProfiles().sort());
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

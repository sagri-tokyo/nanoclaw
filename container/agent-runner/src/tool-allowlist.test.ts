import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  allowedToolsFor,
  deniedToolsFor,
  toolAllowlistByProfile,
} from './tool-allowlist.js';

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

  it('denies operator nothing, since it is the widest profile', () => {
    expect(deniedToolsFor('operator')).toEqual([]);
  });

  it('denies the token-holding profile the scheduler and team surface', () => {
    const denied = deniedToolsFor('trusted-writer');

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

  it('is the only place index.ts gets its base tool set from', () => {
    const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf-8');
    expect(source).toContain(
      'tools: allowedToolsFor(containerInput.capabilityProfile)',
    );
    expect(source).not.toMatch(/tools: \[/);
  });

  // `allowedTools` only auto-approves, and the runner runs under
  // `bypassPermissions`, so feeding the grant to it restricts nothing
  // (sagri-ai#668). Fails if the positive base set is swapped back for it.
  it('does not route the grant through the option that only auto-approves', () => {
    const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf-8');
    expect(source).not.toMatch(/\ballowedTools:/);
  });

  it('hands the denied set to the option that gates MCP tools', () => {
    const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf-8');
    expect(source).toContain(
      'disallowedTools: deniedToolsFor(containerInput.capabilityProfile)',
    );
  });
});

// Measured against SDK 0.2.92 (Claude Code 2.1.92) from a real `query()`
// session's `system/init` message, with `tools` unset. Every one of these was
// available to both profiles under the complement-of-two-lists denial, because
// no profile names them (sagri-ai#668). Under the positive `tools` base set they
// are off by omission, and this list is the pin: adding one to a profile turns
// it back on, which is a decision that should be argued for, not typed.
const BUILT_INS_NO_PROFILE_GRANTS = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'RemoteTrigger',
];

describe('built-ins outside the manifest reach no profile', () => {
  it.each(Object.keys(toolAllowlistByProfile))(
    'grants %s none of them',
    (profile) => {
      const granted = allowedToolsFor(profile);
      expect(
        BUILT_INS_NO_PROFILE_GRANTS.filter((tool) => granted.includes(tool)),
      ).toEqual([]);
    },
  );

  it('leaves them off the denied list too, which is why `tools` has to carry the grant', () => {
    const denied = deniedToolsFor('trusted-writer');
    expect(
      BUILT_INS_NO_PROFILE_GRANTS.filter((tool) => denied.includes(tool)),
    ).toEqual([]);
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

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

function readRunnerSource(): string {
  return fs.readFileSync(path.join(here, 'index.ts'), 'utf-8');
}

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
    const source = readRunnerSource();
    expect(source).toContain(
      'tools: allowedToolsFor(containerInput.capabilityProfile)',
    );
    expect(source).not.toMatch(/(?<!dis|\ballowed)Tools: \[/);
  });

  it('does not route the grant through the option that only auto-approves', () => {
    expect(readRunnerSource()).not.toMatch(/\ballowedTools:/);
  });

  it('hands the denied set to the option that gates MCP tools', () => {
    expect(readRunnerSource()).toContain(
      'disallowedTools: deniedToolsFor(containerInput.capabilityProfile)',
    );
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

/**
 * The built-ins SDK 0.2.92 (Claude Code 2.1.92) reports in a session's
 * `system/init` message with `tools` unset. Captured from a live `query()` run
 * because the SDK ships no enumeration to import (sagri-ai#668).
 *
 * Re-capture this on an SDK bump. The two tests below derive from it in both
 * directions, so a stale copy makes them assert against a surface that no longer
 * exists rather than failing honestly.
 */
const SDK_BUILT_INS = [
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'RemoteTrigger',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];

/**
 * Named by a profile but absent from the surface above: the agent-team tools,
 * which 0.2.92 does not expose. `tools` ignores a name it does not know, so
 * these grant nothing today and stay as the record of what `operator` intends.
 */
const GRANTED_BUT_ABSENT_IN_SDK = ['SendMessage', 'TeamCreate', 'TeamDelete'];

const builtInsGranted = (profile: string) =>
  allowedToolsFor(profile).filter((tool) => !tool.startsWith('mcp__'));

describe('the built-in grant is closed in both directions', () => {
  // `tools` silently drops a name the SDK does not have, so a typo or an
  // upstream rename disables a tool with no error anywhere. Before the grant
  // moved off `allowedTools` that was harmless, because nothing read it.
  it.each(Object.keys(toolAllowlistByProfile))(
    'grants %s no built-in that does not exist',
    (profile) => {
      const unknown = builtInsGranted(profile).filter(
        (tool) =>
          !SDK_BUILT_INS.includes(tool) &&
          !GRANTED_BUT_ABSENT_IN_SDK.includes(tool),
      );
      expect(unknown).toEqual([]);
    },
  );

  // The nine the complement denial left reaching both profiles. They are off by
  // omission now, and pinning the derived list means an SDK that adds a tenth
  // fails here until someone decides which profile should hold it.
  it('leaves every unenumerated built-in outside the widest profile', () => {
    const operatorBuiltIns = builtInsGranted('operator');
    expect(
      SDK_BUILT_INS.filter((tool) => !operatorBuiltIns.includes(tool)),
    ).toEqual([
      'AskUserQuestion',
      'CronCreate',
      'CronDelete',
      'CronList',
      'EnterPlanMode',
      'EnterWorktree',
      'ExitPlanMode',
      'ExitWorktree',
      'RemoteTrigger',
    ]);
  });
});

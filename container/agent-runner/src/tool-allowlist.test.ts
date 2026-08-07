import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  grantedToolsFor,
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

function installedSdkVersion(): string {
  const lockfile = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'package-lock.json'), 'utf-8'),
  );
  return lockfile.packages['node_modules/@anthropic-ai/claude-agent-sdk']
    .version;
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
    const operator = grantedToolsFor('operator');
    const trustedWriter = grantedToolsFor('trusted-writer');

    expect(operator).toEqual(expect.arrayContaining(trustedWriter));
    expect(trustedWriter.length).toBeLessThan(operator.length);
  });

  it('denies operator nothing, since it is the widest profile', () => {
    expect(deniedToolsFor('operator')).toEqual([]);
  });

  it('denies the token-holding profile the scheduler surface', () => {
    const denied = deniedToolsFor('trusted-writer');

    expect(denied).toEqual([
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
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
    expect(grantedToolsFor(undefined)).toEqual(grantedToolsFor('operator'));
  });

  it('throws on a profile it does not know', () => {
    expect(() => grantedToolsFor('root')).toThrow(
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
      'tools: grantedToolsFor(containerInput.capabilityProfile)',
    );
    // Lowercase `t` is load-bearing: `disallowedTools: [` and `allowedTools: [`
    // both carry a capital T, so this targets an inlined base set and nothing
    // else. Anchored to line start so a subagent's `agents` option, which
    // legitimately nests `tools: [...]`, cannot trip it.
    expect(source).not.toMatch(/^\s*tools: \[/m);
    // Same source read: the grant must not route through `allowedTools`,
    // which only auto-approves and restricts nothing under bypassPermissions.
    expect(source).not.toMatch(/\ballowedTools:/);
  });

  it('hands the denied set to the option that gates MCP tools', () => {
    expect(readRunnerSource()).toContain(
      'disallowedTools: deniedToolsFor(containerInput.capabilityProfile)',
    );
  });

  it('ignores MCP servers discovered from project and user settings', () => {
    // The denial list only names servers we know about, so a `.mcp.json`
    // planted in the group folder would otherwise reach a token-bearing
    // profile through `settingSources`.
    expect(readRunnerSource()).toContain('strictMcpConfig: true');
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
const CAPTURED_SDK_VERSION = '0.2.92';

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

const builtInsGranted = (profile: string) =>
  grantedToolsFor(profile).filter((tool) => !tool.startsWith('mcp__'));

describe('the built-in grant is closed in both directions', () => {
  // The dep range is `^0.2.92`, so any 0.2.x installs silently. Without this,
  // the two tests below would keep passing against a surface that has moved
  // out from under SDK_BUILT_INS.
  it('installs the SDK version SDK_BUILT_INS was captured from', () => {
    expect(installedSdkVersion()).toBe(CAPTURED_SDK_VERSION);
  });

  // `tools` silently drops a name the SDK does not have, so a typo or an
  // upstream rename disables a tool with no error anywhere. Before the grant
  // moved off `allowedTools` that was harmless, because nothing read it.
  it.each(Object.keys(toolAllowlistByProfile))(
    'grants %s no built-in that does not exist',
    (profile) => {
      const unknown = builtInsGranted(profile).filter(
        (tool) => !SDK_BUILT_INS.includes(tool),
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
      SDK_BUILT_INS.filter((tool) => !operatorBuiltIns.includes(tool)).sort(),
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

import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const HEX32 = 'a'.repeat(32);

const SOURCE_GROUP: RegisteredGroup = {
  name: 'Dev',
  folder: 'slack_sagri-ai-dev',
  trigger: '@Sagri-AI',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let orgActionCalls: { record: unknown; sourceGroup: string; chatJid: string }[];
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  groups = { 'slack:C0AAA1111': SOURCE_GROUP };
  setRegisteredGroup('slack:C0AAA1111', SOURCE_GROUP);
  orgActionCalls = [];
  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    onOrgAction: async (record, sourceGroup, chatJid) => {
      orgActionCalls.push({ record, sourceGroup, chatJid });
    },
  };
});

describe('org_action IPC drain', () => {
  it('forwards a well-formed record to the handler with the resolved chat jid', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.write_property',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: ['wiki/x.md'],
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    expect(orgActionCalls).toHaveLength(1);
    expect(orgActionCalls[0].sourceGroup).toBe('slack_sagri-ai-dev');
    expect(orgActionCalls[0].chatJid).toBe('slack:C0AAA1111');
  });

  it('rejects a record missing required fields without calling the handler', async () => {
    await processTaskIpc(
      { type: 'org_action', action: 'notion.write_property' },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    expect(orgActionCalls).toHaveLength(0);
  });

  it('rejects a record whose canonical_args is not a non-array object', async () => {
    for (const bad of ['a string', 42, ['array'], null]) {
      orgActionCalls.length = 0;
      await processTaskIpc(
        {
          type: 'org_action',
          action: 'notion.write_property',
          target_ref: HEX32,
          reversibility: 'reversible',
          stakes_hint: 'gated',
          canonical_args: bad,
        },
        'slack_sagri-ai-dev',
        false,
        deps,
      );
      expect(orgActionCalls).toHaveLength(0);
    }
  });

  it('rejects when no handler is wired', async () => {
    const noHandler = { ...deps, onOrgAction: undefined };
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
      },
      'slack_sagri-ai-dev',
      false,
      noHandler,
    );
    expect(orgActionCalls).toHaveLength(0);
  });
});

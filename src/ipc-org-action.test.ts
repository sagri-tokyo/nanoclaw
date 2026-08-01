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

interface OrgActionRecordArg {
  action: string;
  target_ref: string;
  target_query?: string;
  reversibility: string;
  stakes_hint: string;
  citation_refs: string[];
  canonical_args: Record<string, unknown>;
}

let groups: Record<string, RegisteredGroup>;
let orgActionCalls: {
  record: OrgActionRecordArg;
  sourceGroup: string;
  chatJid: string;
  requestFile: string;
}[];
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
    onOrgAction: async (record, sourceGroup, chatJid, requestFile) => {
      orgActionCalls.push({
        record: record as OrgActionRecordArg,
        sourceGroup,
        chatJid,
        requestFile,
      });
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
      'req.json',
    );
    expect(orgActionCalls).toEqual([
      {
        record: {
          action: 'notion.write_property',
          target_ref: HEX32,
          reversibility: 'reversible',
          stakes_hint: 'gated',
          citation_refs: ['wiki/x.md'],
          canonical_args: { property: 'Status', value: 'Ready for AI' },
        },
        sourceGroup: 'slack_sagri-ai-dev',
        chatJid: 'slack:C0AAA1111',
        // The name the host pinned this request's requesters under; without it
        // reaching the handler the gate falls back to the group slot
        // (sagri-ai#630).
        requestFile: 'req.json',
      },
    ]);
  });

  it('forwards a string target_query through to the handler record', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'Soil Model Task',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(1);
    expect(orgActionCalls[0].record.target_query).toBe('Soil Model Task');
  });

  it('rejects a non-string target_query without calling the handler', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.write_property',
        target_ref: '',
        target_query: 42,
        reversibility: 'reversible',
        stakes_hint: 'gated',
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(0);
  });

  it('defaults a missing citation_refs to an empty array (typed, not undefined)', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
        canonical_args: { text: 'hi' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(1);
    expect(orgActionCalls[0].record.citation_refs).toEqual([]);
  });

  it('rejects a citation_refs with non-string elements', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
        citation_refs: ['ok', 42],
        canonical_args: { text: 'hi' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(0);
  });

  it('rejects a record missing required fields without calling the handler', async () => {
    await processTaskIpc(
      { type: 'org_action', action: 'notion.write_property' },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(0);
  });

  it('rejects a record whose reversibility is outside the allowed set', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.write_property',
        target_ref: HEX32,
        reversibility: 'irreversible',
        stakes_hint: 'gated',
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(0);
  });

  it('rejects a record whose stakes_hint is outside the allowed set', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        action: 'notion.write_property',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'red_line',
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
      'req.json',
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
        'req.json',
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
      'req.json',
    );
    expect(orgActionCalls).toHaveLength(0);
  });
});

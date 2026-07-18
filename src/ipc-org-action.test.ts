import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { ActionRecord } from './logger.js';
import type { OrgActionResult } from './org-action-gate.js';
import type { RegisteredGroup } from './types.js';

const HEX32 = 'a'.repeat(32);
const UUID = '11111111-2222-4333-8444-555555555555';

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
}[];
let orgActionResult: OrgActionResult;
let actions: ActionRecord[];
let deps: IpcDeps;

function responsePath(folder: string, requestId: string): string {
  return path.join(
    resolveGroupIpcPath(folder),
    'org-action-responses',
    `${requestId}.json`,
  );
}

beforeEach(() => {
  _initTestDatabase();
  groups = { 'slack:C0AAA1111': SOURCE_GROUP };
  setRegisteredGroup('slack:C0AAA1111', SOURCE_GROUP);
  orgActionCalls = [];
  orgActionResult = { kind: 'execute' };
  actions = [];
  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    actionSink: (record) => {
      actions.push(record);
    },
    onOrgAction: async (record, sourceGroup, chatJid) => {
      orgActionCalls.push({
        record: record as OrgActionRecordArg,
        sourceGroup,
        chatJid,
      });
      return orgActionResult;
    },
  };
});

afterEach(() => {
  fs.rmSync(path.join(DATA_DIR, 'ipc', SOURCE_GROUP.folder), {
    recursive: true,
    force: true,
  });
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
    );
    expect(orgActionCalls).toHaveLength(0);
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

describe('org_action outcome record (nanoclaw#541)', () => {
  const base = {
    type: 'org_action' as const,
    action: 'notion.append_progress',
    target_ref: HEX32,
    reversibility: 'reversible' as const,
    stakes_hint: 'safe' as const,
    canonical_args: { text: 'progress' },
  };

  it('records a refused action as rejected, never ok', async () => {
    orgActionResult = { kind: 'refuse', reason: 'classified_refuse' };
    await processTaskIpc(base, 'slack_sagri-ai-dev', false, deps);
    const record = actions.find((a) => a.tool === 'ipc_org_action');
    expect(record?.outcome).toBe('rejected');
    expect(record?.error_class).toBe('OrgActionRefused');
    expect(record?.level).toBe('warn');
  });

  it('records an executed action as ok with a null error_class', async () => {
    orgActionResult = { kind: 'execute' };
    await processTaskIpc(base, 'slack_sagri-ai-dev', false, deps);
    const record = actions.find((a) => a.tool === 'ipc_org_action');
    expect(record?.outcome).toBe('ok');
    expect(record?.error_class).toBe(null);
  });
});

describe('org_action verdict response file (nanoclaw#541)', () => {
  it('writes the handler verdict to the group response dir keyed by request_id', async () => {
    orgActionResult = { kind: 'refuse', reason: 'classified_refuse' };
    await processTaskIpc(
      {
        type: 'org_action',
        request_id: UUID,
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
        canonical_args: { text: 'progress' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    const written = JSON.parse(
      fs.readFileSync(responsePath(SOURCE_GROUP.folder, UUID), 'utf8'),
    );
    expect(written).toEqual({ kind: 'refuse', reason: 'classified_refuse' });
  });

  it('writes a hold verdict to the response dir', async () => {
    orgActionResult = { kind: 'hold', token: 'T'.repeat(43) };
    await processTaskIpc(
      {
        type: 'org_action',
        request_id: UUID,
        action: 'notion.write_property',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'gated',
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    const written = JSON.parse(
      fs.readFileSync(responsePath(SOURCE_GROUP.folder, UUID), 'utf8'),
    );
    expect(written).toEqual({ kind: 'hold', token: 'T'.repeat(43) });
  });

  it('relays unknown (not refuse) and audits an error when the handler throws', async () => {
    deps.onOrgAction = async () => {
      throw new Error('db down');
    };
    await expect(
      processTaskIpc(
        {
          type: 'org_action',
          request_id: UUID,
          action: 'notion.append_progress',
          target_ref: HEX32,
          reversibility: 'reversible',
          stakes_hint: 'safe',
          canonical_args: { text: 'progress' },
        },
        'slack_sagri-ai-dev',
        false,
        deps,
      ),
    ).rejects.toThrow('db down');
    const written = JSON.parse(
      fs.readFileSync(responsePath(SOURCE_GROUP.folder, UUID), 'utf8'),
    );
    expect(written).toEqual({ kind: 'unknown' });
    const record = actions.find((a) => a.tool === 'ipc_org_action');
    expect(record?.outcome).toBe('error');
    expect(record?.error_class).toBe('Error');
  });

  it('writes a refuse response on a validation reject so the caller never hangs', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        request_id: UUID,
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'irreversible',
        stakes_hint: 'safe',
        canonical_args: { text: 'progress' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    expect(orgActionCalls).toHaveLength(0);
    const written = JSON.parse(
      fs.readFileSync(responsePath(SOURCE_GROUP.folder, UUID), 'utf8'),
    );
    expect(written).toEqual({ kind: 'refuse', reason: 'invalid_request' });
  });

  it('ignores a non-uuid request_id (no response file, no traversal)', async () => {
    await processTaskIpc(
      {
        type: 'org_action',
        request_id: '../escape',
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
        canonical_args: { text: 'progress' },
      },
      'slack_sagri-ai-dev',
      false,
      deps,
    );
    expect(
      fs.existsSync(
        path.join(
          resolveGroupIpcPath(SOURCE_GROUP.folder),
          'org-action-responses',
        ),
      ),
    ).toBe(false);
  });
});

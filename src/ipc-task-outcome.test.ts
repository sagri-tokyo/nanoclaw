import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskOutcomesSince,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { RegisteredGroup, SendOptions } from './types.js';

const SOURCE_GROUP: RegisteredGroup = {
  name: 'Dev',
  folder: 'slack_sagri-ai-dev',
  trigger: '@Sagri-AI',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sent: Array<{ jid: string; text: string; options?: SendOptions }>;
let deps: IpcDeps;

function registerTask(id: string, groupFolder: string): void {
  createTask({
    id,
    group_folder: groupFolder,
    chat_jid: 'slack:C0AAA1111',
    prompt: 'Poll and report.',
    script: null,
    schedule_type: 'cron',
    schedule_value: '*/15 * * * *',
    context_mode: 'isolated',
    next_run: '2026-07-24T01:00:00.000Z',
    status: 'active',
    created_at: '2026-07-24T00:00:00.000Z',
    reply_mode: 'structured',
  });
}

const RECORD = {
  type: 'task_outcome',
  task_id: 'dsm-experiment-submitter',
  entity_id: 'exp-001',
  status: 'submitted',
  groupFolder: 'slack_sagri-ai-dev',
  timestamp: '2026-07-24T01:00:00.000Z',
};

// The malformed cases are the point of this suite, so records are handed in
// as plain objects and cast at the boundary the host validates.
type IpcTaskRecord = Parameters<typeof processTaskIpc>[0];

async function drain(record: object): Promise<void> {
  await processTaskIpc(
    record as IpcTaskRecord,
    'slack_sagri-ai-dev',
    false,
    deps,
    'req.json',
  );
}

beforeEach(() => {
  _initTestDatabase();
  groups = { 'slack:C0AAA1111': SOURCE_GROUP };
  setRegisteredGroup('slack:C0AAA1111', SOURCE_GROUP);
  registerTask('dsm-experiment-submitter', 'slack_sagri-ai-dev');
  sent = [];
  deps = {
    sendMessage: async (jid: string, text: string, options?: SendOptions) => {
      sent.push({ jid, text, options });
    },
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

describe('task_outcome IPC drain', () => {
  it('posts the host-rendered line to the source group chat', async () => {
    await drain(RECORD);
    expect(sent).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: 'exp-001 — submitted',
        options: { target: { kind: 'topLevel' } },
      },
    ]);
  });

  it('renders a failure with its error_class', async () => {
    await drain({
      ...RECORD,
      status: 'failed',
      error_class: 'skill_failed_transient',
    });
    expect(sent).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: 'exp-001 — failed [skill_failed_transient]',
        options: { target: { kind: 'topLevel' } },
      },
    ]);
  });

  it('drops a repeat of an already-posted status', async () => {
    await drain(RECORD);
    await drain({ ...RECORD, timestamp: '2026-07-24T02:00:00.000Z' });
    expect(sent).toHaveLength(1);
  });

  it('retries the post on the next tick when the first post throws', async () => {
    let attempts = 0;
    deps.sendMessage = async (
      jid: string,
      text: string,
      options?: SendOptions,
    ) => {
      attempts += 1;
      if (attempts === 1) throw new Error('slack down');
      sent.push({ jid, text, options });
    };
    await expect(drain(RECORD)).rejects.toThrow('slack down');
    expect(sent).toEqual([]);
    // The failed post committed no dedupe row, so the next tick sees the
    // outcome as still-new and posts it rather than dropping it as a repeat.
    await drain({ ...RECORD, timestamp: '2026-07-24T02:00:00.000Z' });
    expect(sent).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: 'exp-001 — submitted',
        options: { target: { kind: 'topLevel' } },
      },
    ]);
  });

  it('refreshes a deduped repeat into the run window without reposting', async () => {
    await drain({
      ...RECORD,
      status: 'failed',
      error_class: 'skill_failed_transient',
    });
    await drain({
      ...RECORD,
      status: 'failed',
      error_class: 'skill_failed',
      timestamp: '2026-07-24T05:00:00.000Z',
    });
    expect(sent).toHaveLength(1);
    expect(
      getTaskOutcomesSince(
        'dsm-experiment-submitter',
        '2026-07-24T00:00:00.000Z',
      ),
    ).toEqual([{ status: 'failed', error_class: 'skill_failed' }]);
  });

  it('posts again when the status changes for the same entity', async () => {
    await drain(RECORD);
    await drain({ ...RECORD, status: 'complete' });
    expect(sent.map((message) => message.text)).toEqual([
      'exp-001 — submitted',
      'exp-001 — complete',
    ]);
  });

  it('posts each entity separately within one tick', async () => {
    await drain(RECORD);
    await drain({ ...RECORD, entity_id: 'exp-002' });
    expect(sent.map((message) => message.text)).toEqual([
      'exp-001 — submitted',
      'exp-002 — submitted',
    ]);
  });

  it('rejects a status outside the closed set without posting', async () => {
    await drain({ ...RECORD, status: 'orphan_recovered' });
    expect(sent).toEqual([]);
  });

  it('rejects a free-text error_class without posting', async () => {
    await drain({
      ...RECORD,
      status: 'failed',
      error_class: 'the batch submit blew up',
    });
    expect(sent).toEqual([]);
  });

  it('rejects an entity_id carrying prose without posting', async () => {
    await drain({ ...RECORD, entity_id: 'Both writes succeeded.' });
    expect(sent).toEqual([]);
  });

  it('rejects a record missing task_id without posting', async () => {
    const { task_id: _dropped, ...withoutTaskId } = RECORD;
    await drain(withoutTaskId);
    expect(sent).toEqual([]);
  });

  it('rejects a record from a group with no registered chat jid', async () => {
    groups = {};
    await drain(RECORD);
    expect(sent).toEqual([]);
  });

  it('rejects a task_id that matches no registered task', async () => {
    await drain({ ...RECORD, task_id: 'no-such-task' });
    expect(sent).toEqual([]);
  });

  it('rejects a task_id owned by another group', async () => {
    registerTask('other-groups-task', 'slack_other');
    await drain({ ...RECORD, task_id: 'other-groups-task' });
    expect(sent).toEqual([]);
  });
});

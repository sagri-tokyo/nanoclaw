import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { validateActionRecord, type ActionRecord } from './logger.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
      'req.json',
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
      'req.json',
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
      'req.json',
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
      'req.json',
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
      'req.json',
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// Capture emitted action records via the deps.actionSink hook on a fresh
// `deps` clone — no process.stdout/stderr spying (that's the logger's own
// I/O channel; mocking it tests the logger, not the IPC code).
//
// The captured records still go through `validateActionRecord` so any
// schema drift the IPC handlers introduce fails the test loudly, same as
// the real `logger.action` would.
function withCapturedIpcActions(): {
  deps: IpcDeps;
  records: ActionRecord[];
} {
  const captured: ActionRecord[] = [];
  const captureDeps: IpcDeps = {
    ...deps,
    actionSink: (record: ActionRecord) => {
      validateActionRecord(record);
      captured.push(record);
    },
  };
  return { deps: captureDeps, records: captured };
}

function findIpcAction(
  records: ActionRecord[],
  tool: string,
): ActionRecord | undefined {
  return records.find((r) => r.tool === tool);
}

// BLOCKER 1 regression guard: action records emitted on rejected IPC paths
// must produce distinct outputs_hash values for distinct error_class
// values. The pre-fix implementation hashed the empty string at every
// error site, which collapsed every error row to the same SHA-256 digest
// and broke `WHERE outputs_hash = ?` correlation queries.
describe('rejected IPC paths emit distinct outputs_hash per error_class', () => {
  it('TargetGroupNotRegistered vs Unauthorized produce different outputs_hash', async () => {
    const capture = withCapturedIpcActions();

    // schedule_task with unknown targetJid → TargetGroupNotRegistered
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'p',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      capture.deps,
      'req.json',
    );

    // pause_task with no matching task and non-main source → Unauthorized
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-does-not-exist' },
      'other-group',
      false,
      capture.deps,
      'req.json',
    );

    const targetMissing = capture.records.find(
      (r) => r.error_class === 'TargetGroupNotRegistered',
    );
    const unauthorized = capture.records.find(
      (r) => r.error_class === 'Unauthorized',
    );
    expect(targetMissing).toBeDefined();
    expect(unauthorized).toBeDefined();
    expect(targetMissing!.outcome).toBe('rejected');
    expect(unauthorized!.outcome).toBe('rejected');
    // The crux: distinct error classes hash distinctly, never to the
    // empty-string sentinel.
    const EMPTY_STRING_HASH =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(targetMissing!.outputs_hash).not.toBe(EMPTY_STRING_HASH);
    expect(unauthorized!.outputs_hash).not.toBe(EMPTY_STRING_HASH);
    expect(targetMissing!.outputs_hash).not.toBe(unauthorized!.outputs_hash);
  });
});

// sagri-ai#156: previously-silent reject branches in processTaskIpc must
// emit an ipcAction record so CloudWatch sees every drop with a meaningful
// error_class.

// One canonical case asserted against the full record shape so any
// drift in fields, extra keys, or renames trips this test (vs. the
// table-driven cases below which only check outcome/error_class/tool).
describe('silent-drop reject record full shape', () => {
  it('schedule_task missing prompt emits a fully populated rejected ActionRecord', async () => {
    const capture = withCapturedIpcActions();
    await processTaskIpc(
      {
        type: 'schedule_task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      capture.deps,
      'req.json',
    );

    expect(capture.records).toHaveLength(1);
    const record = capture.records[0];
    // Strict structural equality — extra keys, missing keys, or renames
    // all fail this assertion. `ts`, `inputs_hash`, `outputs_hash`, and
    // `duration_ms` are derived (timestamps/hashes) so they're matched
    // by predicate via `expect.stringMatching` / `expect.any(Number)`.
    expect(record).toEqual({
      ts: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
      ),
      level: 'warn',
      session_id: 'whatsapp_main',
      trigger: 'ipc',
      trigger_source: 'whatsapp_main',
      tool: 'ipc_schedule_task',
      inputs_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputs_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      duration_ms: expect.any(Number),
      outcome: 'rejected',
      error_class: 'MissingRequiredField',
      group: 'whatsapp_main',
    });
  });
});

// Table-driven reject-branch coverage. Every row exercises one
// previously-silent drop path and asserts the rejection surfaces as an
// ActionRecord with the expected tool + error_class. The canonical
// shape test above pins the rest of the schema; here we only vary the
// dimensions that differ across cases.
interface RejectCase {
  name: string;
  payload: Parameters<typeof processTaskIpc>[0];
  sourceGroup: string;
  isMain: boolean;
  tool: string;
  errorClass: string;
}

const REJECT_CASES: RejectCase[] = [
  {
    name: 'schedule_task missing prompt',
    payload: {
      type: 'schedule_task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      targetJid: 'other@g.us',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'schedule_task missing targetJid',
    payload: {
      type: 'schedule_task',
      prompt: 'do it',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'schedule_task invalid cron expression',
    payload: {
      type: 'schedule_task',
      prompt: 'bad cron',
      schedule_type: 'cron',
      schedule_value: 'not a cron',
      targetJid: 'other@g.us',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'InvalidPayload',
  },
  {
    name: 'schedule_task non-numeric interval',
    payload: {
      type: 'schedule_task',
      prompt: 'bad interval',
      schedule_type: 'interval',
      schedule_value: 'abc',
      targetJid: 'other@g.us',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'InvalidPayload',
  },
  {
    name: 'schedule_task zero interval',
    payload: {
      type: 'schedule_task',
      prompt: 'zero interval',
      schedule_type: 'interval',
      schedule_value: '0',
      targetJid: 'other@g.us',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'InvalidPayload',
  },
  {
    name: 'schedule_task invalid once timestamp',
    payload: {
      type: 'schedule_task',
      prompt: 'bad once',
      schedule_type: 'once',
      schedule_value: 'not-a-date',
      targetJid: 'other@g.us',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_schedule_task',
    errorClass: 'InvalidPayload',
  },
  {
    name: 'pause_task without taskId',
    payload: { type: 'pause_task' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_pause_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'resume_task without taskId',
    payload: { type: 'resume_task' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_resume_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'cancel_task without taskId',
    payload: { type: 'cancel_task' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_cancel_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'update_task without taskId',
    payload: { type: 'update_task' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_update_task',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'refresh_groups from non-main',
    payload: { type: 'refresh_groups' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_refresh_groups',
    errorClass: 'Unauthorized',
  },
  {
    name: 'register_group from non-main',
    payload: {
      type: 'register_group',
      jid: 'new@g.us',
      name: 'New Group',
      folder: 'new-group',
      trigger: '@Andy',
    },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_register_group',
    errorClass: 'Unauthorized',
  },
  {
    name: 'register_group with unsafe folder',
    payload: {
      type: 'register_group',
      jid: 'new@g.us',
      name: 'New Group',
      folder: '../../outside',
      trigger: '@Andy',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_register_group',
    errorClass: 'InvalidPayload',
  },
  {
    name: 'register_group with missing fields',
    payload: {
      type: 'register_group',
      jid: 'partial@g.us',
      name: 'Partial',
    },
    sourceGroup: 'whatsapp_main',
    isMain: true,
    tool: 'ipc_register_group',
    errorClass: 'MissingRequiredField',
  },
  {
    name: 'unknown IPC type',
    payload: { type: 'totally_unknown_type' },
    sourceGroup: 'other-group',
    isMain: false,
    tool: 'ipc_unknown',
    errorClass: 'InvalidPayload',
  },
];

describe('silent-drop reject branches emit ipcAction', () => {
  it.each(REJECT_CASES)(
    '$name emits $errorClass on $tool',
    async ({ payload, sourceGroup, isMain, tool, errorClass }) => {
      const capture = withCapturedIpcActions();
      await processTaskIpc(
        payload,
        sourceGroup,
        isMain,
        capture.deps,
        'req.json',
      );

      const record = findIpcAction(capture.records, tool);
      expect(record).toBeDefined();
      expect(record!.outcome).toBe('rejected');
      expect(record!.error_class).toBe(errorClass);
      expect(record!.tool).toBe(tool);
    },
  );
});

// update_task schedule-validation branches need a pre-existing task row
// to reach the validation logic, so they sit outside the table above.
describe('update_task schedule-validation reject branches', () => {
  it('invalid cron in update emits InvalidPayload', async () => {
    createTask({
      id: 'task-to-update',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'before',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const capture = withCapturedIpcActions();
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-to-update',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
      },
      'whatsapp_main',
      true,
      capture.deps,
      'req.json',
    );

    const record = findIpcAction(capture.records, 'ipc_update_task');
    expect(record).toBeDefined();
    expect(record!.outcome).toBe('rejected');
    expect(record!.error_class).toBe('InvalidPayload');
  });

  // Regression: the interval branch used to fall through to updateTask()
  // when ms was NaN or <= 0 — silently applying an invalid schedule_value
  // with no reject record. The reject must fire AND the task must remain
  // untouched.
  it('invalid interval in update emits InvalidPayload and does not mutate task', async () => {
    createTask({
      id: 'task-interval-update',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'before',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const capture = withCapturedIpcActions();
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-interval-update',
        schedule_type: 'interval',
        schedule_value: 'abc',
      },
      'whatsapp_main',
      true,
      capture.deps,
      'req.json',
    );

    const record = findIpcAction(capture.records, 'ipc_update_task');
    expect(record).toBeDefined();
    expect(record!.outcome).toBe('rejected');
    expect(record!.error_class).toBe('InvalidPayload');
    const task = getTaskById('task-interval-update')!;
    expect(task.schedule_type).toBe('once');
    expect(task.schedule_value).toBe('2025-06-01T00:00:00');
  });
});

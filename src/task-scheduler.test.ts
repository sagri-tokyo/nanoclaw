import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  logTaskRun,
} from './db.js';
import { HTTP_STATUS_529_ERROR_CLASS } from './container-runner.js';
import type { ContainerOutput } from './container-runner.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';
import {
  _resetSchedulerLoopForTests,
  _runTaskForTests,
  classifyContainerError,
  computeNextRun,
  formatErrorWrap,
  isSilentResult,
  shouldPostFailure,
  slackTextForError,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  describe('isSilentResult', () => {
    it('treats empty string as silent', () => {
      expect(isSilentResult('')).toBe(true);
    });

    it('treats whitespace-only output as silent', () => {
      expect(isSilentResult('   \n\t ')).toBe(true);
    });

    it('treats __SILENT__ marker as silent', () => {
      expect(isSilentResult('__SILENT__')).toBe(true);
    });

    it('treats __NOOP__ marker as silent', () => {
      expect(isSilentResult('__NOOP__')).toBe(true);
    });

    it('trims surrounding whitespace before matching a marker', () => {
      expect(isSilentResult('  __SILENT__\n')).toBe(true);
    });

    it('does not silence narration that only mentions the marker inline', () => {
      expect(
        isSilentResult('Per policy, I would output __SILENT__ here.'),
      ).toBe(false);
    });

    it('does not silence a normal task summary', () => {
      expect(isSilentResult('Triage — 2026-04-20 — Complete')).toBe(false);
    });

    it('silences narration followed by the marker on its own line', () => {
      // Real observed output 2026-04-20 16:15 JST: agent narrated AND emitted
      // the sentinel in the same message. Intent was still "nothing to say".
      expect(
        isSilentResult(
          'Empty results — no pages with "Ready for AI" status.\n\n__SILENT__',
        ),
      ).toBe(true);
    });

    it('silences the marker preceded by a reasoning line', () => {
      expect(isSilentResult('No pages processed this tick.\n__SILENT__')).toBe(
        true,
      );
    });

    it('silences the marker followed by trailing narration', () => {
      expect(isSilentResult('__SILENT__\n(nothing to report)')).toBe(true);
    });

    it('does not silence a title containing underscores but not the sentinel', () => {
      expect(isSilentResult('__staging__ test — Complete')).toBe(false);
    });
  });

  describe('action emission', () => {
    it('emits a schema-valid action record on the invalid-folder rejection path', async () => {
      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk) => {
          writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        });
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk) => {
          writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        });

      try {
        createTask({
          id: 'task-action-rejected',
          group_folder: '../../outside',
          chat_jid: 'bad@g.us',
          prompt: 'run',
          schedule_type: 'once',
          schedule_value: '2026-02-22T00:00:00.000Z',
          context_mode: 'isolated',
          next_run: new Date(Date.now() - 60_000).toISOString(),
          status: 'active',
          created_at: '2026-02-22T00:00:00.000Z',
        });

        const enqueueTask = vi.fn(
          (_g: string, _t: string, fn: () => Promise<void>) => {
            void fn();
          },
        );

        startSchedulerLoop({
          registeredGroups: () => ({}),
          getSessions: () => ({}),
          queue: { enqueueTask } as any,
          onProcess: () => {},
          sendMessage: async () => {},
        });

        await vi.advanceTimersByTimeAsync(10);

        // The NDJSON line is the only line that parses as JSON with the
        // action schema fields.
        const ndjson = writes
          .map((w) => w.trim())
          .filter((w) => w.startsWith('{') && w.includes('"trigger"'))
          .map((w) => JSON.parse(w));
        expect(ndjson.length).toBeGreaterThanOrEqual(1);
        const record = ndjson[0];
        expect(record).toMatchObject({
          level: 'error',
          session_id: 'task-action-rejected',
          trigger: 'scheduled',
          tool: 'container_run',
          outcome: 'rejected',
          group: '../../outside',
        });
        expect(record.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.outputs_hash).toMatch(/^[0-9a-f]{64}$/);
        // Reflects a real Error subclass thrown by resolveGroupFolderPath
        // for the traversal-pattern input — not a synthetic 'Error' literal.
        expect(record.error_class).toBe('InvalidGroupFolderError');
        expect(typeof record.duration_ms).toBe('number');
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  describe('slackTextForError', () => {
    it('returns the rewritten error text for HttpStatus529', () => {
      const text = slackTextForError({
        status: 'error',
        error:
          'ERROR: anthropic upstream overloaded after 6 retries. will retry on the next scheduled tick.',
        error_class: 'HttpStatus529',
      });
      expect(text).toBe(
        'ERROR: anthropic upstream overloaded after 6 retries. will retry on the next scheduled tick.',
      );
    });

    it('returns null for other error classes', () => {
      expect(
        slackTextForError({
          status: 'error',
          error: 'API Error: 500',
          error_class: 'HttpStatus500',
        }),
      ).toBeNull();
    });

    it('returns null when error_class is missing', () => {
      expect(
        slackTextForError({
          status: 'error',
          error: 'some unstructured error text',
        }),
      ).toBeNull();
    });
  });

  describe('formatErrorWrap', () => {
    const fixedNow = new Date('2026-05-15T00:46:48.000Z');

    it('wraps a single-line ERROR reply with run id, timestamp, and runbook url', () => {
      const result = formatErrorWrap('ERROR: Notion database query failed', {
        runId: 'notion-poller-1778804149816',
        runbookUrl: 'https://www.notion.so/Runbook-x',
        now: fixedNow,
      });
      expect(result).toEqual(
        'ERROR: Notion database query failed\n↳ run notion-poller-1778804149816 · 2026-05-15T00:46:48.000Z · runbook → https://www.notion.so/Runbook-x',
      );
    });

    it('wraps a single-line ERROR reply with run id and timestamp when no runbook url', () => {
      const result = formatErrorWrap('ERROR: Notion database query failed', {
        runId: 'notion-poller-1778804149816',
        now: fixedNow,
      });
      expect(result).toEqual(
        'ERROR: Notion database query failed\n↳ run notion-poller-1778804149816 · 2026-05-15T00:46:48.000Z',
      );
    });

    it('passes through multi-line input starting with ERROR unchanged', () => {
      const input = 'ERROR: foo\nERROR: bar';
      expect(formatErrorWrap(input, { runId: 'r', now: fixedNow })).toEqual(
        input,
      );
    });

    it('passes through single-line non-ERROR input unchanged', () => {
      const input = 'Soil moisture brief — Complete';
      expect(formatErrorWrap(input, { runId: 'r', now: fixedNow })).toEqual(
        input,
      );
    });

    it('passes through empty string unchanged', () => {
      expect(formatErrorWrap('', { runId: 'r', now: fixedNow })).toEqual('');
    });

    it('trims trailing whitespace before classifying and emits trimmed + footer', () => {
      const result = formatErrorWrap('ERROR: x  \n', {
        runId: 'r',
        now: fixedNow,
      });
      expect(result).toEqual('ERROR: x\n↳ run r · 2026-05-15T00:46:48.000Z');
    });

    it('passes through non-matching input with trailing whitespace unchanged', () => {
      const input = 'All good  \n';
      expect(formatErrorWrap(input, { runId: 'r', now: fixedNow })).toEqual(
        input,
      );
    });

    it('omits the runbook segment when runbookUrl is null', () => {
      const result = formatErrorWrap('ERROR: x', {
        runId: 'r',
        runbookUrl: null,
        now: fixedNow,
      });
      expect(result).toEqual('ERROR: x\n↳ run r · 2026-05-15T00:46:48.000Z');
    });
  });

  describe('classifyContainerError', () => {
    it('classifies the wall-clock timeout message as ContainerTimeout', () => {
      expect(
        classifyContainerError('Container timed out after 1800000ms'),
      ).toBe('ContainerTimeout');
    });

    it('classifies an exit-137 message as ContainerKilled', () => {
      expect(
        classifyContainerError('Container exited with code 137: out of memory'),
      ).toBe('ContainerKilled');
    });

    it('classifies a non-137 non-zero exit as ContainerExitedNonZero', () => {
      expect(
        classifyContainerError('Container exited with code 1: agent crashed'),
      ).toBe('ContainerExitedNonZero');
    });

    it('classifies a spawn error as ContainerSpawnError', () => {
      expect(classifyContainerError('Container spawn error: ENOENT')).toBe(
        'ContainerSpawnError',
      );
    });

    it('classifies a stdout parse failure as ContainerOutputParseError', () => {
      expect(
        classifyContainerError(
          'Failed to parse container output: Unexpected token',
        ),
      ).toBe('ContainerOutputParseError');
    });

    it('falls back to ContainerAgentError for unrecognized messages', () => {
      expect(classifyContainerError('something else went wrong')).toBe(
        'ContainerAgentError',
      );
    });

    it('never returns an empty string', () => {
      expect(classifyContainerError('').length).toBeGreaterThan(0);
    });
  });
});

describe('shouldPostFailure', () => {
  it('returns true on every failure when threshold is 1 (opt-out)', () => {
    expect(shouldPostFailure([], 1)).toBe(true);
    expect(shouldPostFailure(['success'], 1)).toBe(true);
    expect(shouldPostFailure(['error'], 1)).toBe(true);
  });

  it('suppresses a first-ever failure with the default threshold of 2', () => {
    expect(shouldPostFailure([], 2)).toBe(false);
  });

  it('suppresses an isolated failure after a prior success (threshold 2)', () => {
    expect(shouldPostFailure(['success'], 2)).toBe(false);
  });

  it('posts on two consecutive failures with threshold 2', () => {
    expect(shouldPostFailure(['error'], 2)).toBe(true);
  });

  it('still suppresses two consecutive failures with threshold 3', () => {
    expect(shouldPostFailure(['error'], 3)).toBe(false);
  });

  it('posts on three consecutive failures with threshold 3', () => {
    expect(shouldPostFailure(['error', 'error'], 3)).toBe(true);
  });

  it('treats a recovery in the prior history as a streak break (threshold 3, [error, success, error])', () => {
    // Current failure + 1 leading error = 2; the success then breaks the streak.
    expect(shouldPostFailure(['error', 'success', 'error'], 3)).toBe(false);
  });

  it('treats a recent recovery as a streak break (threshold 3, [success, error, error])', () => {
    // Current failure + 0 leading errors (the head of prior history is success) = 1.
    expect(shouldPostFailure(['success', 'error', 'error'], 3)).toBe(false);
  });
});

describe('runTask consecutive-failure suppression', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    const base = {
      id: 'task-suppress',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Do work.',
      schedule_type: 'cron' as const,
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-05-15T00:00:00.000Z',
      ...overrides,
    };
    createTask(base);
    return getTaskById(base.id) as ScheduledTask;
  }

  function makeGroup(folder: string): RegisteredGroup {
    return {
      name: folder,
      folder,
      trigger: '@bot',
      added_at: '2026-05-15T00:00:00.000Z',
    };
  }

  function fakeRunner(errorOutput: ContainerOutput) {
    return async (
      _group: RegisteredGroup,
      _input: unknown,
      _onProcess: unknown,
      onOutput?: (output: ContainerOutput) => Promise<void>,
    ): Promise<ContainerOutput> => {
      if (onOutput) await onOutput(errorOutput);
      return errorOutput;
    };
  }

  const errorOutput: ContainerOutput = {
    status: 'error',
    result: null,
    error:
      'ERROR: anthropic upstream overloaded after 6 retries. will retry on the next scheduled tick.',
    error_class: HTTP_STATUS_529_ERROR_CLASS,
  };

  it('suppresses the Slack post on a first-ever failure (default threshold 2)', async () => {
    const task = makeTask({ id: 'first-ever', failure_post_threshold: 2 });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent).toEqual([]);
  });

  it('closes the container on an error-only result so the group queue does not wedge', async () => {
    vi.useFakeTimers();
    try {
      // failure_post_threshold high enough that the single failure is suppressed
      // from Slack; we only care about the container-close path here.
      const task = makeTask({ id: 'error-close', failure_post_threshold: 99 });
      let resolveRunner: (() => void) | null = null;
      const closeStdin = vi.fn((_jid: string) => {
        if (resolveRunner) resolveRunner();
      });
      // Mirror a real container that streams an error result and then stays
      // alive (hung in waitForIpcMessage) until the host sends _close via
      // closeStdin. Without the error-branch scheduleClose, that _close never
      // comes and the runner never resolves, wedging the group queue.
      const hangingRunner = async (
        _group: RegisteredGroup,
        _input: unknown,
        _onProcess: unknown,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ): Promise<ContainerOutput> => {
        if (onOutput) await onOutput(errorOutput);
        await new Promise<void>((resolve) => {
          resolveRunner = resolve;
        });
        return errorOutput;
      };
      const runPromise = _runTaskForTests(
        task,
        {
          registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
          getSessions: () => ({}),
          queue: {
            enqueueTask: () => {},
            closeStdin,
            notifyIdle: () => {},
          } as never,
          onProcess: () => {},
          sendMessage: async () => {},
        },
        hangingRunner,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(closeStdin).toHaveBeenCalledWith('C123@slack');
      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts on the second consecutive failure with threshold 2', async () => {
    const task = makeTask({ id: 'two-in-a-row', failure_post_threshold: 2 });
    logTaskRun({
      task_id: task.id,
      run_at: '2026-05-15T00:00:00.000Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'prior boom',
    });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent.length).toBe(1);
    expect(sent[0].startsWith('ERROR: anthropic upstream overloaded')).toBe(
      true,
    );
    // Confirm the formatErrorWrap footer landed.
    expect(sent[0]).toContain('↳ run two-in-a-row');
  });

  it('suppresses when the only prior run is a success (threshold 2)', async () => {
    const task = makeTask({ id: 'isolated', failure_post_threshold: 2 });
    logTaskRun({
      task_id: task.id,
      run_at: '2026-05-15T00:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent).toEqual([]);
  });

  it('suppresses two consecutive failures when threshold is 3', async () => {
    const task = makeTask({ id: 'thr3-two', failure_post_threshold: 3 });
    logTaskRun({
      task_id: task.id,
      run_at: '2026-05-15T00:00:00.000Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'prior boom',
    });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent).toEqual([]);
  });

  it('posts on three consecutive failures with threshold 3', async () => {
    const task = makeTask({ id: 'thr3-three', failure_post_threshold: 3 });
    logTaskRun({
      task_id: task.id,
      run_at: '2026-05-15T00:00:00.000Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'prior boom 1',
    });
    logTaskRun({
      task_id: task.id,
      run_at: '2026-05-15T00:05:00.000Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'prior boom 2',
    });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent.length).toBe(1);
  });

  it('posts on every failure when threshold is 1 (opt-out)', async () => {
    const task = makeTask({ id: 'thr1', failure_post_threshold: 1 });
    const sent: string[] = [];
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async (_jid: string, text: string) => {
          sent.push(text);
        },
      },
      fakeRunner(errorOutput),
    );
    expect(sent.length).toBe(1);
  });

  it('still writes the task_run_logs row when suppressing', async () => {
    const { getRecentTaskRunStatuses } = await import('./db.js');
    const task = makeTask({
      id: 'suppressed-still-logged',
      failure_post_threshold: 2,
    });
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async () => {},
      },
      fakeRunner(errorOutput),
    );
    const statuses = getRecentTaskRunStatuses(task.id, 5);
    expect(statuses).toEqual(['error']);
  });
});

describe('runTask capability-profile forwarding (sagri-ai#312)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    const base = {
      id: 'cap-fwd',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Do work.',
      schedule_type: 'cron' as const,
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-05-15T00:00:00.000Z',
      ...overrides,
    };
    createTask(base);
    return getTaskById(base.id) as ScheduledTask;
  }

  function makeGroup(folder: string): RegisteredGroup {
    return {
      name: folder,
      folder,
      trigger: '@bot',
      added_at: '2026-05-15T00:00:00.000Z',
    };
  }

  const successOutput: ContainerOutput = {
    status: 'success',
    result: 'done',
  };

  async function capturedProfileFor(
    task: ScheduledTask,
  ): Promise<unknown> {
    let captured: unknown;
    const capturingRunner = async (
      _group: RegisteredGroup,
      input: { capabilityProfile?: unknown },
      _onProcess: unknown,
      onOutput?: (output: ContainerOutput) => Promise<void>,
    ): Promise<ContainerOutput> => {
      captured = input.capabilityProfile;
      if (onOutput) await onOutput(successOutput);
      return successOutput;
    };
    await _runTaskForTests(
      task,
      {
        registeredGroups: () => ({ 'C123@slack': makeGroup('slack_main') }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: () => {},
          closeStdin: () => {},
          notifyIdle: () => {},
        } as never,
        onProcess: () => {},
        sendMessage: async () => {},
      },
      capturingRunner as never,
    );
    return captured;
  }

  it('forwards a trusted-writer task profile to the container input', async () => {
    const task = makeTask({
      id: 'cap-trusted',
      capability_profile: 'trusted-writer',
    });
    expect(await capturedProfileFor(task)).toBe('trusted-writer');
  });

  it('resolves a task with no capability_profile to operator (fail-closed)', async () => {
    const task = makeTask({ id: 'cap-none' });
    delete (task as { capability_profile?: unknown }).capability_profile;
    expect(await capturedProfileFor(task)).toBe('operator');
  });
});

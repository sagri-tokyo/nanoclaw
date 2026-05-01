import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  isSilentResult,
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
});

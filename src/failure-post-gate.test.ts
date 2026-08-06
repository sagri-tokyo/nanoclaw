import { beforeEach, describe, expect, it } from 'vitest';

import {
  failureClearsPostThreshold,
  shouldPostFailure,
} from './failure-post-gate.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  logTaskRun,
} from './db.js';
import type { ScheduledTask } from './types.js';

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

describe('failureClearsPostThreshold', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function task(threshold: number): ScheduledTask {
    createTask({
      id: `thr-${threshold}`,
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Do work.',
      script: null,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: '2026-05-15T00:15:00.000Z',
      status: 'active',
      created_at: '2026-05-15T00:00:00.000Z',
      failure_post_threshold: threshold,
    });
    return getTaskById(`thr-${threshold}`) as ScheduledTask;
  }

  function priorRun(taskId: string, status: 'success' | 'error', at: string) {
    logTaskRun({
      task_id: taskId,
      run_at: at,
      duration_ms: 1,
      status,
      result: null,
      error: status === 'error' ? 'boom' : null,
    });
  }

  it('holds a first-ever failure at the default threshold', () => {
    expect(failureClearsPostThreshold(task(2))).toBe(false);
  });

  it('clears once the prior run was also red', () => {
    const scheduled = task(2);
    priorRun(scheduled.id, 'error', '2026-05-15T00:00:00.000Z');
    expect(failureClearsPostThreshold(scheduled)).toBe(true);
  });

  it('holds when the streak was broken by a green run', () => {
    const scheduled = task(2);
    priorRun(scheduled.id, 'error', '2026-05-15T00:00:00.000Z');
    priorRun(scheduled.id, 'success', '2026-05-15T00:15:00.000Z');
    expect(failureClearsPostThreshold(scheduled)).toBe(false);
  });

  it('reads only as far back as the threshold needs', () => {
    // Threshold 3 counts two prior rows; a red run older than that window is
    // not what makes the current failure post.
    const scheduled = task(3);
    priorRun(scheduled.id, 'error', '2026-05-15T00:00:00.000Z');
    priorRun(scheduled.id, 'success', '2026-05-15T00:15:00.000Z');
    priorRun(scheduled.id, 'error', '2026-05-15T00:30:00.000Z');
    expect(failureClearsPostThreshold(scheduled)).toBe(false);
  });

  it('posts every failure at threshold 1', () => {
    expect(failureClearsPostThreshold(task(1))).toBe(true);
  });
});

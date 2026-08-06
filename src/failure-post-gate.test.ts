import { beforeEach, describe, expect, it } from 'vitest';

import {
  decideOutcomeDisposition,
  failureClearsPostThreshold,
  shouldPostFailure,
} from './failure-post-gate.js';
import {
  _initTestDatabase,
  commitTaskOutcome,
  createTask,
  getTaskById,
  logTaskRun,
} from './db.js';
import type { TaskOutcome } from './task-outcome.js';
import type { ScheduledTask } from './types.js';

function makeTask(id: string, threshold: number): ScheduledTask {
  createTask({
    id,
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
  return getTaskById(id) as ScheduledTask;
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

  const task = (threshold: number) => makeTask(`thr-${threshold}`, threshold);

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

describe('decideOutcomeDisposition', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const task = (threshold: number) => makeTask('poller', threshold);

  const failure: TaskOutcome = {
    task_id: 'poller',
    entity_id: 'exp-001',
    status: 'failed',
    error_class: 'skill_failed',
    detail: null,
  };

  it('holds a run-failing status that has not cleared the threshold', () => {
    expect(decideOutcomeDisposition(task(2), failure)).toBe('held');
  });

  it('posts a run-failing status once the prior run was also red', () => {
    const scheduled = task(2);
    priorRun(scheduled.id, 'error', '2026-05-15T00:00:00.000Z');
    expect(decideOutcomeDisposition(scheduled, failure)).toBe('posted');
  });

  it('never gates a status that leaves the run green', () => {
    // `rejected` never turns a run red, so gating it would suppress it forever.
    expect(
      decideOutcomeDisposition(task(2), {
        ...failure,
        status: 'rejected',
        error_class: 'rejected_injection',
      }),
    ).toBe('posted');
  });

  it('reports a repeat without consulting the threshold', () => {
    const scheduled = task(2);
    commitTaskOutcome(
      {
        ...failure,
        group_folder: 'slack_main',
        recorded_at: '2026-05-15T00:15:00.000Z',
      },
      'posted',
    );
    expect(decideOutcomeDisposition(scheduled, failure)).toBe('repeat');
  });

  it('treats a posted record older than the previous run as news again', () => {
    // The repeat rule has two halves: a stamp AND recency. The test above only
    // has one prior run, so the cutoff is empty and recency passes trivially.
    // With enough history for a real cutoff, a stamped record that predates it
    // is a later outage, not a repeat, which is what stops dedupe from
    // becoming permanent silence.
    const scheduled = task(2);
    commitTaskOutcome(
      {
        ...failure,
        group_folder: 'slack_main',
        recorded_at: '2026-05-15T00:00:00.000Z',
      },
      'posted',
    );
    priorRun(scheduled.id, 'error', '2026-05-15T01:00:00.000Z');
    priorRun(scheduled.id, 'error', '2026-05-15T02:00:00.000Z');
    expect(decideOutcomeDisposition(scheduled, failure)).toBe('posted');
  });

  it('keeps a held record eligible instead of collapsing it into a repeat', () => {
    const scheduled = task(2);
    commitTaskOutcome(
      {
        ...failure,
        group_folder: 'slack_main',
        recorded_at: '2026-05-15T00:15:00.000Z',
      },
      'held',
    );
    priorRun(scheduled.id, 'error', '2026-05-15T00:00:00.000Z');
    expect(decideOutcomeDisposition(scheduled, failure)).toBe('posted');
  });
});

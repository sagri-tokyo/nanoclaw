import { describe, expect, it } from 'vitest';

import { parseTaskOutcome, renderTaskOutcome } from './task-outcome.js';

const VALID = {
  type: 'task_outcome',
  task_id: 'dsm-experiment-submitter',
  entity_id: 'exp-2026-07-24-soc',
  status: 'submitted',
  groupFolder: 'slack_sagri-ai-dev',
  timestamp: '2026-07-24T01:00:00.000Z',
};

describe('parseTaskOutcome', () => {
  it('accepts a minimal well-formed record', () => {
    expect(parseTaskOutcome(VALID)).toEqual({
      ok: true,
      record: {
        task_id: 'dsm-experiment-submitter',
        entity_id: 'exp-2026-07-24-soc',
        status: 'submitted',
        error_class: null,
        detail: null,
      },
    });
  });

  it('accepts a failure record carrying a closed-set error_class', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        status: 'failed',
        error_class: 'skill_failed_transient',
      }),
    ).toEqual({
      ok: true,
      record: {
        task_id: 'dsm-experiment-submitter',
        entity_id: 'exp-2026-07-24-soc',
        status: 'failed',
        error_class: 'skill_failed_transient',
        detail: null,
      },
    });
  });

  it('accepts a detail map of constrained scalars', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        detail: {
          job_id: '0c9f1f7a-2b52-4d3e-9c11-9a1d1b6a77aa',
          orphan_recovered: 'true',
        },
      }),
    ).toEqual({
      ok: true,
      record: {
        task_id: 'dsm-experiment-submitter',
        entity_id: 'exp-2026-07-24-soc',
        status: 'submitted',
        error_class: null,
        detail: {
          job_id: '0c9f1f7a-2b52-4d3e-9c11-9a1d1b6a77aa',
          orphan_recovered: 'true',
        },
      },
    });
  });

  it('rejects a missing task_id', () => {
    const { task_id: _dropped, ...withoutTaskId } = VALID;
    expect(parseTaskOutcome(withoutTaskId)).toEqual({
      ok: false,
      error_class: 'MissingRequiredField',
    });
  });

  it('rejects a missing entity_id', () => {
    const { entity_id: _dropped, ...withoutEntityId } = VALID;
    expect(parseTaskOutcome(withoutEntityId)).toEqual({
      ok: false,
      error_class: 'MissingRequiredField',
    });
  });

  it('rejects a missing status', () => {
    const { status: _dropped, ...withoutStatus } = VALID;
    expect(parseTaskOutcome(withoutStatus)).toEqual({
      ok: false,
      error_class: 'MissingRequiredField',
    });
  });

  it('rejects a status outside the closed set', () => {
    expect(parseTaskOutcome({ ...VALID, status: 'orphan_recovered' })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects an error_class outside the closed set', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        status: 'failed',
        error_class: 'the batch call blew up',
      }),
    ).toEqual({ ok: false, error_class: 'InvalidPayload' });
  });

  it('rejects a failure status with no error_class', () => {
    expect(parseTaskOutcome({ ...VALID, status: 'failed' })).toEqual({
      ok: false,
      error_class: 'MissingRequiredField',
    });
  });

  it('rejects a success status that carries an error_class', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        status: 'complete',
        error_class: 'skill_failed',
      }),
    ).toEqual({ ok: false, error_class: 'InvalidPayload' });
  });

  it('rejects an entity_id containing prose', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        entity_id: 'Both writes succeeded. Returning the terminal result.',
      }),
    ).toEqual({ ok: false, error_class: 'InvalidPayload' });
  });

  it('rejects an entity_id longer than the constrained-id bound', () => {
    expect(parseTaskOutcome({ ...VALID, entity_id: 'a'.repeat(65) })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects a task_id containing prose', () => {
    expect(parseTaskOutcome({ ...VALID, task_id: 'the poller task' })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects a detail value carrying free text', () => {
    expect(
      parseTaskOutcome({
        ...VALID,
        detail: { note: 'both writes succeeded, returning' },
      }),
    ).toEqual({ ok: false, error_class: 'InvalidPayload' });
  });

  it('rejects a detail value that is not a string', () => {
    expect(parseTaskOutcome({ ...VALID, detail: { attempts: 3 } })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects a detail that is an array', () => {
    expect(parseTaskOutcome({ ...VALID, detail: ['job-1'] })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects a detail with more keys than the cap', () => {
    const detail = Object.fromEntries(
      Array.from({ length: 9 }, (_value, index) => [`k${index}`, 'v']),
    );
    expect(parseTaskOutcome({ ...VALID, detail })).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });

  it('rejects a non-object payload', () => {
    expect(parseTaskOutcome('task_outcome')).toEqual({
      ok: false,
      error_class: 'InvalidPayload',
    });
  });
});

describe('renderTaskOutcome', () => {
  it('renders a success as entity and status only', () => {
    expect(
      renderTaskOutcome({
        entity_id: 'exp-2026-07-24-soc',
        status: 'submitted',
        error_class: null,
      }),
    ).toBe('exp-2026-07-24-soc — submitted');
  });

  it('appends the error_class on a failure', () => {
    expect(
      renderTaskOutcome({
        entity_id: 'exp-2026-07-24-soc',
        status: 'failed',
        error_class: 'skill_failed',
      }),
    ).toBe('exp-2026-07-24-soc — failed [skill_failed]');
  });

  it('appends the error_class on a stall escalation', () => {
    expect(
      renderTaskOutcome({
        entity_id: 'exp-2026-07-24-soc',
        status: 'stalled',
        error_class: 'upstream_query_failed',
      }),
    ).toBe('exp-2026-07-24-soc — stalled [upstream_query_failed]');
  });
});

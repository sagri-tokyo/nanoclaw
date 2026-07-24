import { describe, expect, it } from 'vitest';

import {
  parseTaskOutcome as hostParseTaskOutcome,
  TASK_OUTCOME_ERROR_CLASSES as HOST_ERROR_CLASSES,
  TASK_OUTCOME_STATUSES as HOST_STATUSES,
} from '../../../src/task-outcome.js';
import {
  parseTaskOutcome,
  TASK_OUTCOME_ERROR_CLASSES,
  TASK_OUTCOME_STATUSES,
} from './task-outcome-contract.js';

// The container declares these sets to the model via zod and re-validates the
// assembled record before writing the IPC file; the host re-validates on drain.
// Drift between the two shows up in production as a silently rejected outcome —
// the tool answers `recorded`, the host refuses, nothing posts, and the run is
// logged as having reported nothing at all.
describe('task outcome contract', () => {
  it('declares the same statuses the host accepts', () => {
    expect([...TASK_OUTCOME_STATUSES]).toEqual([...HOST_STATUSES]);
  });

  it('declares the same error classes the host accepts', () => {
    expect([...TASK_OUTCOME_ERROR_CLASSES]).toEqual([...HOST_ERROR_CLASSES]);
  });
});

const base = {
  task_id: 'dsm-experiment-poller',
  entity_id: 'exp-2026-07-24-001',
  status: 'submitted',
};

function detail(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => [
      `key_${index}`,
      'value',
    ]),
  );
}

// Payloads the container can actually emit, plus the five divergences found by
// reconstructing both validators. Every case must get the same verdict from
// both sides, and no case may be accepted here and rejected on the host.
const CORPUS: Array<{ name: string; payload: unknown }> = [
  { name: 'minimal submitted record', payload: { ...base } },
  {
    name: 'complete with detail ids',
    payload: {
      ...base,
      status: 'complete',
      detail: { page_id: 'abc123', job_id: 'batch:job/1a2b' },
    },
  },
  {
    name: 'failed with its required error_class',
    payload: { ...base, status: 'failed', error_class: 'skill_failed' },
  },
  {
    name: 'explicit null error_class on a non-failure status',
    payload: { ...base, error_class: null, detail: null },
  },
  {
    name: 'detail value holding an s3 uri',
    payload: {
      ...base,
      detail: { artifact: 'sagri-dsm/runs/2026-07-24/metrics.json' },
    },
  },
  { name: 'exactly 8 detail entries', payload: { ...base, detail: detail(8) } },

  // (1) spaces in entity_id
  {
    name: 'entity_id containing spaces',
    payload: { ...base, entity_id: 'experiment 001' },
  },
  {
    name: 'entity_id that is a sentence',
    payload: { ...base, entity_id: 'no pages were ready this tick' },
  },

  // (2) a forbidden error_class on a non-failure status
  {
    name: 'error_class present on complete',
    payload: { ...base, status: 'complete', error_class: 'skill_failed' },
  },
  {
    name: 'error_class present on submitted',
    payload: { ...base, error_class: 'upstream_query_failed' },
  },

  // (3) prose in a detail value
  {
    name: 'detail value carrying prose',
    payload: {
      ...base,
      detail: { reason: 'the Notion query failed after 3 attempts' },
    },
  },

  // (4) too many detail entries
  { name: 'nine detail entries', payload: { ...base, detail: detail(9) } },

  // (5) a missing error_class on a failure status
  {
    name: 'failed without error_class',
    payload: { ...base, status: 'failed' },
  },
  {
    name: 'rejected without error_class',
    payload: { ...base, status: 'rejected' },
  },
  {
    name: 'stalled without error_class',
    payload: { ...base, status: 'stalled' },
  },

  // Remaining rejects, so the corpus covers the whole rule set rather than the
  // five cases that happened to be found.
  { name: 'unknown status', payload: { ...base, status: 'in_progress' } },
  {
    name: 'unknown error_class',
    payload: { ...base, status: 'failed', error_class: 'notion_timeout' },
  },
  { name: 'empty entity_id', payload: { ...base, entity_id: '' } },
  {
    name: 'entity_id over 64 characters',
    payload: { ...base, entity_id: 'e'.repeat(65) },
  },
  {
    name: 'detail key in uppercase',
    payload: { ...base, detail: { Page_Id: 'abc123' } },
  },
  {
    name: 'detail value that is not a string',
    payload: { ...base, detail: { attempts: 3 } },
  },
  { name: 'detail as an array', payload: { ...base, detail: ['abc123'] } },
  {
    name: 'missing entity_id',
    payload: { task_id: base.task_id, status: 'submitted' },
  },
  { name: 'not an object', payload: 'submitted' },
];

describe('task outcome validator parity', () => {
  for (const { name, payload } of CORPUS) {
    it(`agrees with the host on ${name}`, () => {
      const host = hostParseTaskOutcome(payload);
      const container = parseTaskOutcome(payload);
      expect(container).toEqual(host);
    });
  }

  it('never accepts a payload the host rejects', () => {
    const acceptedByContainerOnly = CORPUS.filter(
      ({ payload }) =>
        parseTaskOutcome(payload).ok && !hostParseTaskOutcome(payload).ok,
    ).map(({ name }) => name);
    expect(acceptedByContainerOnly).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  TASK_OUTCOME_ERROR_CLASSES as HOST_ERROR_CLASSES,
  TASK_OUTCOME_STATUSES as HOST_STATUSES,
} from '../../../src/task-outcome.js';
import {
  TASK_OUTCOME_ERROR_CLASSES,
  TASK_OUTCOME_STATUSES,
} from './task-outcome-contract.js';

// The container declares these sets to the model via zod; the host re-validates
// them on drain. Drift between the two shows up in production as a silently
// rejected outcome — the tick reports, the host refuses, nothing posts.
describe('task outcome contract', () => {
  it('declares the same statuses the host accepts', () => {
    expect([...TASK_OUTCOME_STATUSES]).toEqual([...HOST_STATUSES]);
  });

  it('declares the same error classes the host accepts', () => {
    expect([...TASK_OUTCOME_ERROR_CLASSES]).toEqual([...HOST_ERROR_CLASSES]);
  });
});

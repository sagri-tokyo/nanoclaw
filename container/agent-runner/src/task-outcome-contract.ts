/**
 * Closed sets the `report_outcome` tool exposes to the agent.
 *
 * Declared here rather than imported from the host `src/` tree: the container
 * image only ships `container/agent-runner/src`. The values must stay equal to
 * `src/task-outcome.ts`, and `task-outcome-contract.test.ts` fails if they
 * drift — the host re-validates every record and a drifted value is a silent
 * rejection, not a degraded post.
 */

export const TASK_OUTCOME_STATUSES = [
  'submitted',
  'complete',
  'failed',
  'rejected',
  'stalled',
] as const;

export const TASK_OUTCOME_ERROR_CLASSES = [
  'skill_failed',
  'skill_failed_transient',
  'rejected_injection',
  'rejected_extraction',
  'rejected_validation',
  'upstream_query_failed',
] as const;

export const TASK_OUTCOME_RECORDED_MESSAGE = 'recorded';

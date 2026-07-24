/**
 * The `report_outcome` contract, mirrored from the host's `src/task-outcome.ts`.
 *
 * Declared here rather than imported from the host `src/` tree because the
 * container image only ships `container/agent-runner/src`, and the host's
 * `tsconfig` pins `rootDir` to `src/` so the host cannot import this file
 * either. `parseTaskOutcome` below is a verbatim copy of the host's so the two
 * can be diffed; `task-outcome-contract.test.ts` runs both over one payload
 * corpus and fails on any disagreement.
 *
 * The host stays authoritative and re-validates every record on drain. This
 * copy exists so the tool never answers `recorded` for a payload the host will
 * drop: the agent believes it reported, moves on, and the run ends with no
 * outcome for that entity, which the run-status derivation reads as a crashed
 * tick.
 */

export const TASK_OUTCOME_STATUSES = [
  'submitted',
  'complete',
  'failed',
  'rejected',
  'stalled',
] as const;
export type TaskOutcomeStatus = (typeof TASK_OUTCOME_STATUSES)[number];

export const TASK_OUTCOME_ERROR_CLASSES = [
  'skill_failed',
  'skill_failed_transient',
  'rejected_injection',
  'rejected_extraction',
  'rejected_validation',
  'upstream_query_failed',
] as const;
export type TaskOutcomeErrorClass = (typeof TASK_OUTCOME_ERROR_CLASSES)[number];

export const TASK_OUTCOME_FAILURE_STATUSES: ReadonlySet<TaskOutcomeStatus> =
  new Set<TaskOutcomeStatus>(['failed', 'rejected', 'stalled']);

const CONSTRAINED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DETAIL_MAX_KEYS = 8;

export const TASK_OUTCOME_RECORDED_MESSAGE = 'recorded';

/**
 * Static rejection text. Names the constraint the payload broke and restates
 * the closed sets so the agent can correct the call without guessing. No part
 * of the offending payload is echoed: the reject reason is not a place to
 * reintroduce model-authored bytes.
 */
export const TASK_OUTCOME_REJECTED_MESSAGES: Record<
  'MissingRequiredField' | 'InvalidPayload',
  string
> = {
  MissingRequiredField:
    'report_outcome rejected: a required field is missing. entity_id and status are always required, and error_class is required for failed/rejected/stalled.',
  InvalidPayload:
    'report_outcome rejected: a field is outside the allowed shape. entity_id must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/ (no spaces, no prose), error_class is forbidden on submitted/complete, and detail takes at most 8 entries whose keys match /^[a-z][a-z0-9_]{0,31}$/ and whose values match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/ (ids and enum-ish tokens only, never a sentence).',
};

export interface TaskOutcome {
  task_id: string;
  entity_id: string;
  status: TaskOutcomeStatus;
  error_class: TaskOutcomeErrorClass | null;
  detail: Record<string, string> | null;
}

export type TaskOutcomeParse =
  | { ok: true; record: TaskOutcome }
  | { ok: false; error_class: 'MissingRequiredField' | 'InvalidPayload' };

const MISSING: TaskOutcomeParse = {
  ok: false,
  error_class: 'MissingRequiredField',
};
const INVALID: TaskOutcomeParse = { ok: false, error_class: 'InvalidPayload' };

function isTaskOutcomeStatus(value: unknown): value is TaskOutcomeStatus {
  return (TASK_OUTCOME_STATUSES as readonly unknown[]).includes(value);
}

function isTaskOutcomeErrorClass(
  value: unknown,
): value is TaskOutcomeErrorClass {
  return (TASK_OUTCOME_ERROR_CLASSES as readonly unknown[]).includes(value);
}

function parseDetail(
  value: unknown,
): { ok: true; detail: Record<string, string> | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, detail: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > DETAIL_MAX_KEYS) return { ok: false };
  const detail: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!DETAIL_KEY.test(key)) return { ok: false };
    if (typeof entry !== 'string' || !DETAIL_VALUE.test(entry)) {
      return { ok: false };
    }
    detail[key] = entry;
  }
  return { ok: true, detail: entries.length === 0 ? null : detail };
}

export function parseTaskOutcome(data: unknown): TaskOutcomeParse {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return INVALID;
  }
  const record = data as Record<string, unknown>;

  if (
    record.task_id === undefined ||
    record.entity_id === undefined ||
    record.status === undefined
  ) {
    return MISSING;
  }
  if (
    typeof record.task_id !== 'string' ||
    !CONSTRAINED_ID.test(record.task_id) ||
    typeof record.entity_id !== 'string' ||
    !CONSTRAINED_ID.test(record.entity_id)
  ) {
    return INVALID;
  }
  if (!isTaskOutcomeStatus(record.status)) return INVALID;

  const isFailure = TASK_OUTCOME_FAILURE_STATUSES.has(record.status);
  const rawErrorClass =
    record.error_class === null ? undefined : record.error_class;
  if (isFailure && rawErrorClass === undefined) return MISSING;
  if (!isFailure && rawErrorClass !== undefined) return INVALID;
  if (rawErrorClass !== undefined && !isTaskOutcomeErrorClass(rawErrorClass)) {
    return INVALID;
  }

  const detail = parseDetail(record.detail);
  if (!detail.ok) return INVALID;

  return {
    ok: true,
    record: {
      task_id: record.task_id,
      entity_id: record.entity_id,
      status: record.status,
      error_class: rawErrorClass ?? null,
      detail: detail.detail,
    },
  };
}

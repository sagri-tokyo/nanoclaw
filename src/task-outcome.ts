/**
 * Host-side contract for the structured task-outcome channel.
 *
 * A scheduled task's final assistant message is its Slack post, so any side
 * effect keyed on that text is at the mercy of prose the model cannot reliably
 * produce (narration, leaked sentinels, duplicated lifecycle lines). A task in
 * `structured` reply mode instead emits one typed record per entity through the
 * `report_outcome` container tool; the host validates it, renders the Slack
 * line, and decides whether to post.
 *
 * Validation discipline mirrors `org-action-gate.ts`: every field is a closed
 * enum or a constrained id, and anything outside the set is a hard reject. A
 * coerced value here would put model-authored bytes back into the rendered
 * Slack line, which is the flaw this channel exists to remove.
 */

export const TASK_OUTCOME_STATUSES = [
  'submitted',
  'complete',
  'failed',
  'rejected',
  'stalled',
] as const;
export type TaskOutcomeStatus = (typeof TASK_OUTCOME_STATUSES)[number];

/**
 * Statuses that mean the entity did not reach its intended end state. They
 * require an `error_class`; the non-failure statuses forbid one.
 */
export const TASK_OUTCOME_FAILURE_STATUSES: ReadonlySet<TaskOutcomeStatus> =
  new Set<TaskOutcomeStatus>(['failed', 'rejected', 'stalled']);

/**
 * The subset of failure statuses that turn the whole run red in
 * `task_run_logs`. `rejected` is excluded: a refusal is the tick doing its job,
 * so the run stays green and the record itself is the operator-visible signal.
 *
 * This is also the exact set the consecutive-failure post gate may hold back.
 * Gating a status that never turns a run red would suppress it forever, since
 * the gate counts red runs (sagri-tokyo/sagri-ai#659).
 */
// Typed `string` rather than `TaskOutcomeStatus` because the scheduler tests it
// against statuses read back out of SQLite, where the column is untyped text.
export const RUN_FAILING_OUTCOME_STATUSES: ReadonlySet<string> =
  new Set<TaskOutcomeStatus>(['failed', 'stalled']);

/**
 * Closed set covering the failure modes the dsm-experiment prompts classify.
 * Never free text: the class is rendered into Slack verbatim.
 */
export const TASK_OUTCOME_ERROR_CLASSES = [
  'skill_failed',
  'skill_failed_transient',
  'rejected_injection',
  'rejected_extraction',
  'rejected_validation',
  'upstream_query_failed',
] as const;
export type TaskOutcomeErrorClass = (typeof TASK_OUTCOME_ERROR_CLASSES)[number];

// Constrained-id shapes. No whitespace, so prose cannot pass as an id.
// Exported as the single source of truth for the `task_id` shape:
// `setup/register-task.ts` validates `--id` against the same regex so an
// unusable id is rejected at registration rather than silently failing every
// `report_outcome` call at runtime.
export const CONSTRAINED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,31}$/;
// Detail values additionally allow `/` so an S3 URI or a Batch job ARN fits.
const DETAIL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DETAIL_MAX_KEYS = 8;

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

export function renderTaskOutcome(record: {
  entity_id: string;
  status: TaskOutcomeStatus;
  error_class: TaskOutcomeErrorClass | null;
}): string {
  const line = `${record.entity_id} — ${record.status}`;
  return record.error_class ? `${line} [${record.error_class}]` : line;
}

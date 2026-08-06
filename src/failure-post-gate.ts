/**
 * The per-task consecutive-failure post gate.
 *
 * A task reports failure three ways — a container-level error, a single-line
 * `ERROR:` reply, and a `task_outcome` record — and one per-task
 * `failure_post_threshold` covers all three. It lives here rather than in
 * `task-scheduler.ts` so the IPC drain can apply it without importing the
 * scheduler (sagri-tokyo/sagri-ai#659).
 *
 * A held failure escapes on a later tick only if four things all hold, one per
 * file: the drain commits the record anyway (`ipc.ts`), a NULL `posted_at`
 * keeps it news (`db.ts`), that refreshed record turns the run red
 * (`task-scheduler.ts`), and the next tick counts that red run (here). Break
 * any one and the failure is suppressed forever, so treat all four as one
 * mechanism.
 *
 * Known mismatch: the streak counts red runs for the whole task, while the
 * records it gates are per `(task, entity, status)`. One chronically failing
 * entity keeps every run red, so any other entity's first blip clears the
 * threshold immediately. It errs toward posting rather than silence.
 * sagri-tokyo/sagri-ai#663 decides whether to key the streak per entity.
 */
import {
  getRecentTaskRunStatuses,
  taskOutcomeIsNew,
  type TaskOutcomeDisposition,
} from './db.js';
import { logger } from './logger.js';
import { RUN_FAILING_OUTCOME_STATUSES, TaskOutcome } from './task-outcome.js';
import { ScheduledTask } from './types.js';

/**
 * Decide whether a failing scheduled-task tick should produce a Slack post.
 *
 * Single isolated transients (e.g. one-off 30s Notion timeout) generate noise
 * with no operator value when the next tick recovers. We post only once the
 * current tick PLUS enough prior consecutive failures clear the per-task
 * `failure_post_threshold`. See sagri-tokyo/sagri-ai#254.
 *
 * @param priorStatuses last (threshold - 1) `task_run_logs` rows for this
 *   task, NEWEST FIRST, NOT including the current run.
 * @param threshold per-task threshold from `scheduled_tasks.failure_post_threshold`.
 *   Must be >= 1; enforced by `register-task --post-after-fails`.
 * @returns true iff (1 current failure + leading prior errors) >= threshold.
 */
export function shouldPostFailure(
  priorStatuses: Array<'success' | 'error'>,
  threshold: number,
): boolean {
  let consecutive = 1; // the current failing tick
  for (const status of priorStatuses) {
    if (status !== 'error') break;
    consecutive += 1;
  }
  return consecutive >= threshold;
}

/**
 * {@link shouldPostFailure} against a task's own threshold and its recent run
 * log.
 *
 * Meant for a run that is still in flight: it reads `task_run_logs`, where the
 * current run's row is not yet written, so every row it sees is prior.
 *
 * A record the drain handles after the run has moved on miscounts by one tick.
 * The two landmarks are sequential, so late past `getTaskOutcomesSince` means
 * the record does not colour this run and the run can log green, resetting the
 * streak. Late past `logTaskRun` as well, a run already red for some other
 * reason counts as prior history and clears the threshold a tick early. Both
 * are bounded by one tick and neither is worth a shared clock.
 */
export function failureClearsPostThreshold(task: ScheduledTask): boolean {
  const threshold = task.failure_post_threshold ?? 2;
  const priorStatuses = getRecentTaskRunStatuses(
    task.id,
    Math.max(0, threshold - 1),
  );
  const clears = shouldPostFailure(priorStatuses, threshold);
  if (!clears) {
    // info, not debug: this is the line that says a real reported failure did
    // not reach anyone, and LOG_LEVEL defaults to info. Suppression is rare by
    // construction, so it does not add routine noise.
    logger.info(
      { taskId: task.id, threshold, priorStatuses },
      'Scheduled task failed but consecutive-failure threshold not met; suppressing Slack post',
    );
  }
  return clears;
}

/**
 * What the drain should do with one `task_outcome` record.
 *
 * Only `RUN_FAILING_OUTCOME_STATUSES` is gated: see its doc for why gating a
 * status that never turns a run red would suppress it forever. A repeat never
 * reaches the gate, which keeps `task_run_logs` out of a decision already made.
 */
export function decideOutcomeDisposition(
  task: ScheduledTask,
  outcome: TaskOutcome,
): TaskOutcomeDisposition {
  if (!taskOutcomeIsNew(outcome.task_id, outcome.entity_id, outcome.status)) {
    return 'repeat';
  }
  if (!RUN_FAILING_OUTCOME_STATUSES.has(outcome.status)) return 'posted';
  return failureClearsPostThreshold(task) ? 'posted' : 'held';
}

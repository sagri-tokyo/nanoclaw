/**
 * The per-task consecutive-failure post gate.
 *
 * A task reports failure three ways — a container-level error, a single-line
 * `ERROR:` reply, and a `task_outcome` record — and one per-task
 * `failure_post_threshold` covers all three. It lives here rather than in
 * `task-scheduler.ts` so the IPC drain can apply it without importing the
 * scheduler (sagri-tokyo/sagri-ai#659).
 */
import { getRecentTaskRunStatuses } from './db.js';
import { logger } from './logger.js';
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
 * The IPC drain has no view of the scheduler, so a record it handles late
 * miscounts in one of two directions depending on which landmark it missed.
 * Late past `logTaskRun` and the current run's own red row reads as prior,
 * clearing the threshold a failure early. Late past the `getTaskOutcomesSince`
 * read that derives the run status and the run logs green instead, resetting
 * the streak. Both are bounded by one tick, and neither is worth a shared clock.
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

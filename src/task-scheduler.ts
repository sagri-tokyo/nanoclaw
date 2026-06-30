import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  HTTP_STATUS_529_ERROR_CLASS,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getRecentTaskRunStatuses,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { GroupNotFoundError, resolveGroupFolderPath } from './group-folder.js';
import { hashFailureOutput, hashPayload, logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

// Markers a scheduled-task agent can emit to signal "no output" without
// triggering a chat post. Needed because LLMs are unreliable at producing
// a truly empty final message — they tend to narrate compliance ("Per the
// reply policy, replying with empty string") which then gets posted.
//
// We match a marker on ANY line of the trimmed result, not just the
// whole-message value, because in practice the agent often emits both a
// narration line and the sentinel in the same message (observed 2026-04-20
// 16:15 JST: "Empty results — no pages with 'Ready for AI' status.\n\n
// __SILENT__"). Treating any-line match as silent swallows the narration
// too — operator's intent was "nothing to say", so suppressing the whole
// post matches that intent better than posting the narration alone.
const SILENT_RESULT_MARKERS = new Set(['__SILENT__', '__NOOP__']);

export function isSilentResult(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed === '') return true;
  return trimmed
    .split('\n')
    .some((line) => SILENT_RESULT_MARKERS.has(line.trim()));
}

export function formatErrorWrap(
  result: string,
  opts: { runId: string; runbookUrl?: string | null; now?: Date },
): string {
  const trimmed = result.trim();
  const lines = trimmed.split('\n');
  if (lines.length !== 1 || !trimmed.startsWith('ERROR: ')) {
    return result;
  }
  const timestamp = (opts.now ?? new Date()).toISOString();
  const footer = `↳ run ${opts.runId} · ${timestamp}${opts.runbookUrl ? ` · runbook → ${opts.runbookUrl}` : ''}`;
  return `${trimmed}\n${footer}`;
}

/**
 * Map a `ContainerOutput.error` string from `runContainerAgent` to a stable
 * `error_class` value for action records. Every error path in `runTask`
 * routes through this so `logger.action` never emits an empty
 * `error_class` when `outcome === 'error'`.
 *
 * The input strings are the literal messages produced by `container-runner.ts`;
 * keep this in sync if those formats change. Refs sagri-tokyo/sagri-ai#244.
 */
export function classifyContainerError(message: string): string {
  if (message.startsWith('Container timed out after')) {
    return 'ContainerTimeout';
  }
  if (message.startsWith('Container exited with code 137')) {
    return 'ContainerKilled';
  }
  if (message.startsWith('Container exited with code ')) {
    return 'ContainerExitedNonZero';
  }
  if (message.startsWith('Container spawn error')) {
    return 'ContainerSpawnError';
  }
  if (message.startsWith('Failed to parse container output')) {
    return 'ContainerOutputParseError';
  }
  return 'ContainerAgentError';
}

/**
 * Return the Slack reply text for a container-runner error output, or null
 * when the error class should stay silent on chat. Currently only the
 * rewritten `HttpStatus529` line (the agent-runner's 529 retry-budget exit,
 * humanized by `container-runner.ts`) is surfaced.
 * sagri-tokyo/sagri-ai#247.
 */
export function slackTextForError(output: {
  status: 'error';
  error: string;
  error_class?: string;
}): string | null {
  if (output.error_class !== HTTP_STATUS_529_ERROR_CLASS) return null;
  return output.error;
}

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

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

type RunContainerAgentFn = typeof runContainerAgent;

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  runner: RunContainerAgentFn = runContainerAgent,
): Promise<void> {
  const startTime = Date.now();
  const inputsHash = hashPayload(task.prompt);
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const errorClass = err instanceof Error ? err.constructor.name : 'Error';
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    logger.action({
      ts: new Date().toISOString(),
      level: 'error',
      session_id: task.id,
      trigger: 'scheduled',
      trigger_source: task.schedule_value,
      tool: 'container_run',
      inputs_hash: inputsHash,
      outputs_hash: hashPayload(error),
      duration_ms: Date.now() - startTime,
      outcome: 'rejected',
      error_class: errorClass,
      group: task.group_folder,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.debug(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    const groupNotFound = new GroupNotFoundError(task.group_folder);
    const error = groupNotFound.message;
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    logger.action({
      ts: new Date().toISOString(),
      level: 'error',
      session_id: task.id,
      trigger: 'scheduled',
      trigger_source: task.schedule_value,
      tool: 'container_run',
      inputs_hash: inputsHash,
      outputs_hash: hashFailureOutput({
        error_class: groupNotFound.constructor.name,
        error_message_preview: error.slice(0, 200),
      }),
      duration_ms: Date.now() - startTime,
      outcome: 'rejected',
      // Reflects the real Error subclass, not a synthetic literal.
      error_class: groupNotFound.constructor.name,
      group: task.group_folder,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let errorClass: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runner(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        capabilityProfile: task.capability_profile ?? 'operator',
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        const wrap = (text: string) =>
          formatErrorWrap(text, {
            runId: task.id,
            runbookUrl: task.runbook_url,
            now: new Date(),
          });
        if (streamedOutput.result) {
          result = streamedOutput.result;
          if (isSilentResult(streamedOutput.result)) {
            logger.debug(
              { taskId: task.id },
              'Scheduled task produced silent-result marker; skipping chat post',
            );
          } else {
            await deps.sendMessage(task.chat_jid, wrap(streamedOutput.result));
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          // An error is terminal for a single-turn task. Close the container
          // like the success/result paths do — otherwise the agent-runner sits
          // in its streaming query loop awaiting a _close that never comes, and
          // the container hangs until the IDLE_TIMEOUT hard kill (~30 min),
          // wedging the whole group queue behind it (sagri-tokyo/sagri-ai#322).
          scheduleClose();
          error = streamedOutput.error;
          // Prefer the structured error_class from the agent-runner when
          // present so action records stay accurate after container-runner
          // rewrites the user-facing error text (sagri-tokyo/sagri-ai#247).
          errorClass =
            streamedOutput.error_class ??
            classifyContainerError(streamedOutput.error);
          const slackText = slackTextForError(streamedOutput);
          if (slackText !== null) {
            // Suppress single-transient failures from Slack until a per-task
            // consecutive-failure threshold is met. The `task_run_logs` row
            // and action record are still written below. sagri-tokyo/sagri-ai#254.
            const threshold = task.failure_post_threshold ?? 2;
            const priorStatuses = getRecentTaskRunStatuses(
              task.id,
              Math.max(0, threshold - 1),
            );
            if (shouldPostFailure(priorStatuses, threshold)) {
              await deps.sendMessage(task.chat_jid, wrap(slackText));
            } else {
              logger.debug(
                {
                  taskId: task.id,
                  threshold,
                  priorStatuses,
                },
                'Scheduled task failed but consecutive-failure threshold not met; suppressing Slack post',
              );
            }
          }
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error;
      errorClass = output.error_class ?? classifyContainerError(output.error);
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.debug(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    errorClass = err instanceof Error ? err.constructor.name : 'Error';
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  logger.action({
    ts: new Date().toISOString(),
    level: error ? 'error' : 'info',
    session_id: task.id,
    trigger: 'scheduled',
    trigger_source: task.schedule_value,
    tool: 'container_run',
    inputs_hash: inputsHash,
    outputs_hash: hashPayload(result ?? ''),
    duration_ms: durationMs,
    outcome: error ? 'error' : 'ok',
    error_class: error ? errorClass : null,
    group: task.group_folder,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

/** @internal - for tests only. Allows injecting a fake `runContainerAgent`. */
export function _runTaskForTests(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  runner: RunContainerAgentFn,
): Promise<void> {
  return runTask(task, deps, runner);
}

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
  getTaskOutcomesSince,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { GroupNotFoundError, resolveGroupFolderPath } from './group-folder.js';
import { hashFailureOutput, hashPayload, logger } from './logger.js';
import { createSessionTracker, SessionStore } from './session-tracker.js';
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
//
// Prompts document the marker as inline code, and the agent copies that
// formatting into its reply, so a backticked marker missed the exact-match
// check and posted to Slack (sagri-tokyo/sagri-ai#616). Wrapper markup is
// matched as "no letters either side" rather than a list of ASCII punctuation:
// any ASCII class, `\W` included, also matches CJK, so a Japanese narration
// line ending in the marker would count as bare and drop the whole post.
//
// The class admits digits, so a numbered-list marker line ("1. __SILENT__")
// silences. Safe because both ends are anchored and the marker literal is
// mandatory. `isErrorReply` is a prefix test with no such anchor, which is
// why it cannot reuse this class.
//
// Split on `\n` rather than using the `m` flag: `m` also treats a bare `\r`
// and U+2028 as line ends, which would silence narration this has always
// posted.
const SILENT_RESULT_LINE = /^[^\p{L}]*(?:__SILENT__|__NOOP__)[^\p{L}]*$/u;

export function isSilentResult(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed === '') return true;
  return trimmed.split('\n').some((line) => SILENT_RESULT_LINE.test(line));
}

// A scheduled-task agent reports failure by making its whole reply a single
// `ERROR: ` line (the closed-set literal convention from
// sagri-tokyo/sagri-ai#465). `formatErrorWrap` keys its Slack footer on this
// shape, and `runTask` keys the `task_run_logs` status on it so a reported
// failure never logs status=success (sagri-tokyo/sagri-ai#504). A multi-line
// reply that merely starts with `ERROR: ` is narration, not a reported
// failure.
export const AGENT_ERROR_REPLY_CLASS = 'AgentErrorReply';

// Same markup-wrapping bug as `isSilentResult` (sagri-tokyo/sagri-ai#616),
// applied to the ERROR: convention. Wrappers may sit in any of three slots —
// before the label, between the label and its colon, after the colon — and
// they need not balance, so `**ERROR:** x`, `**ERROR**: x` and `*ERROR:* x`
// all match; what follows the whitespace is the failure message and is not
// inspected.
//
// A wrapper has to abut the label rather than float ahead of it, because `*`
// opens both bold and a bullet: anything looser reads "* ERROR: retried,
// recovered" as a reported failure and flips a green run to status=error.
// Digits are excluded from the leading slot for the neighbouring reason — an
// ordered-list marker leads a line of narration, not a reported failure. The
// one lead that is allowed is a blockquote, which has no inline-emphasis
// meaning to collide with and is how an agent quotes its own failure.
const ERROR_REPLY_LINE = /^[>\s]*[`*_~]*ERROR[`*_~]*:[`*_~]*\s/u;

// The whole ECMAScript LineTerminator set, not `\n` alone: narration split by
// a bare `\r` or U+2028 read as one line and logged status=error on a run that
// succeeded (sagri-tokyo/sagri-ai#617). `isSilentResult` stays `\n`-only — see
// `SILENT_RESULT_LINE`.
//
// A `\r`-split reply can still render as one failure line in chat while
// counting as narration here: green status, no `formatErrorWrap` footer.
// Accepted because the set is taken whole from the language; excluding `\r`
// would leave one terminator classified by hand.
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/u;

export function isErrorReply(result: string): boolean {
  const trimmed = result.trim();
  return !LINE_TERMINATOR.test(trimmed) && ERROR_REPLY_LINE.test(trimmed);
}

// A `structured` task has no ERROR: line to key on — its reply never reaches
// chat at all — so the run's `task_run_logs` status comes from the
// `report_outcome` records the tick emitted. Silence is a failure, not a pass:
// a tick that reported nothing either crashed before reporting or skipped the
// contract, and logging it green is the exact blind spot sagri-ai#504 closed
// for text mode.
export const NO_TASK_OUTCOME_ERROR_CLASS = 'NoTaskOutcomeReported';
export const TASK_OUTCOME_FAILURE_ERROR_CLASS = 'TaskOutcomeFailure';

const RUN_FAILING_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'stalled',
]);

/**
 * Derive the run-level error for a `structured` task from the outcomes it
 * recorded during the run, or null when the run is a success. `rejected` is
 * NOT a run failure: a refusal (injection, failed extraction) is the tick
 * doing its job, and the record itself is the operator-visible signal.
 */
export function deriveStructuredRunError(
  outcomes: Array<{ status: string; error_class: string | null }>,
): { error: string; error_class: string } | null {
  if (outcomes.length === 0) {
    return {
      error: 'Structured task recorded no outcome for this run',
      error_class: NO_TASK_OUTCOME_ERROR_CLASS,
    };
  }
  const failure = outcomes.find((outcome) =>
    RUN_FAILING_OUTCOME_STATUSES.has(outcome.status),
  );
  if (!failure) return null;
  const suffix = failure.error_class ? ` [${failure.error_class}]` : '';
  return {
    error: `Structured task reported ${failure.status}${suffix}`,
    error_class: TASK_OUTCOME_FAILURE_ERROR_CLASS,
  };
}

export function formatErrorWrap(
  result: string,
  opts: { runId: string; runbookUrl?: string | null; now?: Date },
): string {
  if (!isErrorReply(result)) {
    return result;
  }
  const trimmed = result.trim();
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
  // Resolves the session a group-context run should resume, and drops it first
  // if the org-action gate asked for a reset. It WRITES; only call it for a run
  // that is actually about to resume a session, never to peek.
  sessionForNextRun: (groupFolder: string) => string | undefined;
  sessionStore: SessionStore;
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

  // The call is kept behind the branch deliberately: an isolated task resumes
  // nothing, and hoisting it would have every isolated tick eat the group's
  // pending gate reset and drop a session it never touched.
  const isGroupContext = task.context_mode === 'group';
  const sessionId = isGroupContext
    ? deps.sessionForNextRun(task.group_folder)
    : undefined;

  // Keeping the session this run established stops the next one starting fresh
  // and orphaning the transcript. Dropping a stale one matters as much: a
  // cron-only group has no human message to heal it. Isolated runs share no
  // session with the group, so they track nothing.
  const track = isGroupContext
    ? createSessionTracker(task.group_folder, sessionId, deps.sessionStore, {
        taskId: task.id,
      })
    : () => {};

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
        taskId: task.id,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        capabilityProfile: task.capability_profile ?? 'operator',
        // A task contributes no requesters of its own: nobody asked, it runs on
        // its own prompt. `[]` is honest in both modes because `sessionId` above
        // makes run-requesters widen the group's slot rather than replace it, so
        // the session-scoped humans stay excluded (sagri-ai#629).
        requesterIds: [],
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        track(streamedOutput);
        const wrap = (text: string) =>
          formatErrorWrap(text, {
            runId: task.id,
            runbookUrl: task.runbook_url,
            now: new Date(),
          });
        if (streamedOutput.result) {
          // Posting the reply is deferred until after the runner returns so
          // the decision can read the `task_outcomes` this run recorded. The
          // IPC watcher drains those records on its own 1s timer, so a record
          // the tick wrote may not be visible at stream time — only once the
          // container has closed is it guaranteed drained. See the reply-post
          // block below.
          result = streamedOutput.result;
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
    // Usually repeats the id already streamed, but a run that dies before
    // streaming anything reports only here.
    track(output);

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

  // Reads the outcomes the IPC watcher drained during this run. The watcher
  // polls every IPC_POLL_INTERVAL (1s) and the container is only closed
  // TASK_CLOSE_DELAY_MS (10s) after the agent's last tool call, so a record
  // written by the tick is drained well before this point. If that margin
  // ever shrinks, correlate on a run id written by the host instead of on
  // the drain timestamp. This single read feeds both the reply-post decision
  // and the structured run-status derivation below.
  const runOutcomes = getTaskOutcomesSince(
    task.id,
    new Date(startTime).toISOString(),
  );

  try {
    if (result !== null) {
      if (task.reply_mode === 'structured') {
        // The reply is not the transport in this mode — `report_outcome`
        // records are. Log the text so a prompt regression is still
        // debuggable, but never post it.
        logger.info(
          { taskId: task.id, reply: result },
          'Structured reply mode; agent reply not posted to chat',
        );
      } else if (runOutcomes.length > 0) {
        // This text-mode tick already routed its operator lines through the
        // `task_outcome` channel, which the host renders and posts. Posting
        // the agent's prose too would duplicate them. A record whose post was
        // collapsed as a previous-run repeat still refreshed its `recorded_at`
        // into this run's window, so it counts here — the operator already saw
        // that line, so the host still owns the reply.
        logger.debug(
          { taskId: task.id },
          'task_outcome recorded this run; not posting agent prose',
        );
      } else if (isSilentResult(result)) {
        logger.debug(
          { taskId: task.id },
          'Scheduled task produced silent-result marker; skipping chat post',
        );
      } else {
        await deps.sendMessage(
          task.chat_jid,
          formatErrorWrap(result, {
            runId: task.id,
            runbookUrl: task.runbook_url,
            now: new Date(),
          }),
        );
      }
    }
  } catch (postErr) {
    // A failed reply post must still fall through to logTaskRun /
    // updateTaskAfterRun below; otherwise a Slack outage leaves next_run
    // stale and the scheduler re-runs the task every poll. Only surface the
    // post failure when the run itself succeeded — a genuine run failure the
    // main catch already recorded keeps its own class.
    const postError =
      postErr instanceof Error ? postErr.message : String(postErr);
    logger.error(
      { taskId: task.id, error: postError },
      'Failed to post scheduled task reply',
    );
    if (error === null) {
      error = postError;
      errorClass =
        postErr instanceof Error ? postErr.constructor.name : 'Error';
    }
  }

  if (task.reply_mode === 'structured' && error === null) {
    const derived = deriveStructuredRunError(runOutcomes);
    if (derived) {
      error = derived.error;
      errorClass = derived.error_class;
    }
  } else if (error === null && result !== null && isErrorReply(result)) {
    // The container exited cleanly but the agent reported failure via the
    // single-line ERROR: reply convention. Without this, the tick logs
    // status=success / outcome=ok and every monitor built on
    // task_run_logs.status reads green (sagri-tokyo/sagri-ai#504).
    error = result.trim();
    errorClass = AGENT_ERROR_REPLY_CLASS;
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

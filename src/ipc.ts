import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  commitTaskOutcome,
  createTask,
  deleteTask,
  getTaskById,
  taskOutcomeIsNew,
  updateTask,
  type TaskOutcomeDisposition,
} from './db.js';
import { failureClearsPostThreshold } from './failure-post-gate.js';
import {
  isValidGroupFolder,
  listUndrainedIpcRequests,
  resolveGroupIpcTasksPath,
} from './group-folder.js';
import { clearRequestPin, retainRequestPins } from './run-requesters.js';
import {
  hashFailureOutput,
  hashPayload,
  logger,
  type ActionRecord,
} from './logger.js';
import {
  isPlainObject,
  isReversibility,
  isStakesHint,
  isStringArray,
  type Reversibility,
  type StakesHint,
} from './org-action-gate.js';
import {
  parseTaskOutcome,
  renderTaskOutcome,
  RUN_FAILING_OUTCOME_STATUSES,
} from './task-outcome.js';
import { RegisteredGroup, SendOptions } from './types.js';

export type ActionSink = (record: ActionRecord) => void;

function chatJidForGroupFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  folder: string,
): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === folder,
  )?.[0];
}

function emitIpcAction(
  sink: ActionSink,
  args: Pick<
    ActionRecord,
    | 'level'
    | 'session_id'
    | 'tool'
    | 'inputs_hash'
    | 'outputs_hash'
    | 'duration_ms'
    | 'outcome'
    | 'error_class'
    | 'group'
  > & { trigger_source: string },
): void {
  sink({
    ts: new Date().toISOString(),
    level: args.level,
    session_id: args.session_id,
    trigger: 'ipc',
    trigger_source: args.trigger_source,
    tool: args.tool,
    inputs_hash: args.inputs_hash,
    outputs_hash: args.outputs_hash,
    duration_ms: args.duration_ms,
    outcome: args.outcome,
    error_class: args.error_class,
    group: args.group,
  });
}

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: SendOptions,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  /**
   * Drain-time handler for a gated/safe `org_action` request (D2.4). Given the
   * record the container dropped plus the verified source-group identity and
   * the chat jid that owns the source group, the host re-classifies and either
   * executes (safe), holds (gated, posts a Slack approval prompt), or refuses
   * (red line / allowlist). Optional so non-Sagri deployments need not wire it;
   * an `org_action` request with no handler is rejected.
   *
   * `requestFile` is the name of the file this record was read from, which is
   * how the host looks up the requesters it pinned to that request rather than
   * to the group (sagri-ai#630).
   */
  onOrgAction?: (
    record: {
      action: string;
      target_ref: string;
      target_query?: string;
      reversibility: Reversibility;
      stakes_hint: StakesHint;
      citation_refs: string[];
      canonical_args: Record<string, unknown>;
    },
    sourceGroup: string,
    chatJid: string,
    requestFile: string,
  ) => Promise<void>;
  /**
   * Optional override for the action-record sink. Defaults to
   * `logger.action`. Exists so tests can observe emitted records via an
   * in-memory collector instead of spying on `process.stdout`/`process.stderr`
   * (which is the logger's own I/O channel).
   */
  actionSink?: ActionSink;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        if (!stat.isDirectory() || f === 'errors') return false;
        // Screened here, not in the loop below: resolving a path from an illegal
        // name throws, and a throw escapes before the reschedule at the end,
        // stopping the drain for every group until a restart. Logged at debug
        // because the drain re-runs every second.
        if (!isValidGroupFolder(f)) {
          logger.debug({ sourceGroup: f }, 'IPC: skipping non-group directory');
          return false;
        }
        return true;
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = resolveGroupIpcTasksPath(sourceGroup);

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      try {
        // Same helper a launch pins against, so the two cannot disagree about
        // which files are requests (sagri-ai#630).
        const requestFiles = listUndrainedIpcRequests(sourceGroup);
        // Same synchronous block as the listing, per retainRequestPins.
        retainRequestPins(sourceGroup, requestFiles);

        for (const file of requestFiles) {
          const filePath = path.join(tasksDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // Pass source group identity to processTaskIpc for authorization
            await processTaskIpc(data, sourceGroup, isMain, deps, file);
            fs.unlinkSync(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            fs.mkdirSync(errorDir, { recursive: true });
            fs.renameSync(
              filePath,
              path.join(errorDir, `${sourceGroup}-${file}`),
            );
          }
          // Not a finally: if the quarantine above also throws, the file is
          // still in tasks/ and its pin has to outlive this tick with it.
          clearRequestPin(sourceGroup, file);
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    action?: string;
    target_ref?: string;
    target_query?: unknown;
    reversibility?: string;
    stakes_hint?: string;
    citation_refs?: unknown;
    canonical_args?: unknown;
    // For task_outcome. Typed `unknown` on purpose: the shape is decided by
    // `parseTaskOutcome`, not by the caller's claim about it.
    task_id?: unknown;
    entity_id?: unknown;
    status?: unknown;
    error_class?: unknown;
    detail?: unknown;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
  requestFile: string, // The file this request was read from (sagri-ai#630)
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  const ipcStart = Date.now();
  const inputsHash = hashPayload(data);
  const sink: ActionSink = deps.actionSink ?? logger.action;

  // Reject-record emitter. Every reject path shares the same shape:
  // outcome='rejected', level='warn', session_id=sourceGroup (the failing
  // request can't be tied to a created session), group=sourceGroup. Callers
  // override session_id only when the request carried a taskId we can use to
  // correlate the rejection back to an existing task.
  const emitReject = (
    tool: string,
    errorClass: string,
    options: { sessionId?: string } = {},
  ): void => {
    emitIpcAction(sink, {
      level: 'warn',
      session_id: options.sessionId ?? sourceGroup,
      trigger_source: sourceGroup,
      tool,
      inputs_hash: inputsHash,
      outputs_hash: hashFailureOutput({ error_class: errorClass }),
      duration_ms: Date.now() - ipcStart,
      outcome: 'rejected',
      error_class: errorClass,
      group: sourceGroup,
    });
  };

  switch (data.type) {
    case 'schedule_task': {
      if (
        !data.prompt ||
        !data.schedule_type ||
        !data.schedule_value ||
        !data.targetJid
      ) {
        logger.warn(
          { data },
          'Invalid schedule_task request - missing required fields',
        );
        emitReject('ipc_schedule_task', 'MissingRequiredField');
        break;
      }
      // Resolve the target group from JID
      const targetJid = data.targetJid as string;
      const targetGroupEntry = registeredGroups[targetJid];

      if (!targetGroupEntry) {
        logger.warn(
          { targetJid },
          'Cannot schedule task: target group not registered',
        );
        emitReject('ipc_schedule_task', 'TargetGroupNotRegistered');
        break;
      }

      const targetFolder = targetGroupEntry.folder;

      // Authorization: non-main groups can only schedule for themselves
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Unauthorized schedule_task attempt blocked',
        );
        emitReject('ipc_schedule_task', 'Unauthorized');
        break;
      }

      const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.schedule_value, {
            tz: TIMEZONE,
          });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn(
            { scheduleValue: data.schedule_value },
            'Invalid cron expression',
          );
          emitReject('ipc_schedule_task', 'InvalidPayload');
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(data.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn(
            { scheduleValue: data.schedule_value },
            'Invalid interval',
          );
          emitReject('ipc_schedule_task', 'InvalidPayload');
          break;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const date = new Date(data.schedule_value);
        if (isNaN(date.getTime())) {
          logger.warn(
            { scheduleValue: data.schedule_value },
            'Invalid timestamp',
          );
          emitReject('ipc_schedule_task', 'InvalidPayload');
          break;
        }
        nextRun = date.toISOString();
      }

      const taskId =
        data.taskId ||
        `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode =
        data.context_mode === 'group' || data.context_mode === 'isolated'
          ? data.context_mode
          : 'isolated';
      createTask({
        id: taskId,
        group_folder: targetFolder,
        chat_jid: targetJid,
        prompt: data.prompt,
        script: data.script || null,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.debug(
        { taskId, sourceGroup, targetFolder, contextMode },
        'Task created via IPC',
      );
      emitIpcAction(sink, {
        level: 'info',
        session_id: taskId,
        trigger_source: sourceGroup,
        tool: 'ipc_schedule_task',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(taskId),
        duration_ms: Date.now() - ipcStart,
        outcome: 'ok',
        error_class: null,
        group: targetFolder,
      });
      deps.onTasksChanged();
      break;
    }

    case 'pause_task': {
      if (!data.taskId) {
        logger.warn({ data }, 'pause_task missing taskId');
        emitReject('ipc_pause_task', 'MissingRequiredField');
        break;
      }
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        updateTask(data.taskId, { status: 'paused' });
        logger.debug(
          { taskId: data.taskId, sourceGroup },
          'Task paused via IPC',
        );
        emitIpcAction(sink, {
          level: 'info',
          session_id: data.taskId,
          trigger_source: sourceGroup,
          tool: 'ipc_pause_task',
          inputs_hash: inputsHash,
          outputs_hash: hashPayload(data.taskId),
          duration_ms: Date.now() - ipcStart,
          outcome: 'ok',
          error_class: null,
          group: task.group_folder,
        });
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task pause attempt',
        );
        emitReject('ipc_pause_task', 'Unauthorized', {
          sessionId: data.taskId,
        });
      }
      break;
    }

    case 'resume_task': {
      if (!data.taskId) {
        logger.warn({ data }, 'resume_task missing taskId');
        emitReject('ipc_resume_task', 'MissingRequiredField');
        break;
      }
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        updateTask(data.taskId, { status: 'active' });
        logger.debug(
          { taskId: data.taskId, sourceGroup },
          'Task resumed via IPC',
        );
        emitIpcAction(sink, {
          level: 'info',
          session_id: data.taskId,
          trigger_source: sourceGroup,
          tool: 'ipc_resume_task',
          inputs_hash: inputsHash,
          outputs_hash: hashPayload(data.taskId),
          duration_ms: Date.now() - ipcStart,
          outcome: 'ok',
          error_class: null,
          group: task.group_folder,
        });
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task resume attempt',
        );
        emitReject('ipc_resume_task', 'Unauthorized', {
          sessionId: data.taskId,
        });
      }
      break;
    }

    case 'cancel_task': {
      if (!data.taskId) {
        logger.warn({ data }, 'cancel_task missing taskId');
        emitReject('ipc_cancel_task', 'MissingRequiredField');
        break;
      }
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        deleteTask(data.taskId);
        logger.debug(
          { taskId: data.taskId, sourceGroup },
          'Task cancelled via IPC',
        );
        emitIpcAction(sink, {
          level: 'info',
          session_id: data.taskId,
          trigger_source: sourceGroup,
          tool: 'ipc_cancel_task',
          inputs_hash: inputsHash,
          outputs_hash: hashPayload(data.taskId),
          duration_ms: Date.now() - ipcStart,
          outcome: 'ok',
          error_class: null,
          group: task.group_folder,
        });
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task cancel attempt',
        );
        emitReject('ipc_cancel_task', 'Unauthorized', {
          sessionId: data.taskId,
        });
      }
      break;
    }

    case 'update_task': {
      if (!data.taskId) {
        logger.warn({ data }, 'update_task missing taskId');
        emitReject('ipc_update_task', 'MissingRequiredField');
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Task not found for update',
        );
        emitReject('ipc_update_task', 'TaskNotFound', {
          sessionId: data.taskId,
        });
        break;
      }
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task update attempt',
        );
        emitReject('ipc_update_task', 'Unauthorized', {
          sessionId: data.taskId,
        });
        break;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (data.prompt !== undefined) updates.prompt = data.prompt;
      if (data.script !== undefined) updates.script = data.script || null;
      if (data.schedule_type !== undefined)
        updates.schedule_type = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once';
      if (data.schedule_value !== undefined)
        updates.schedule_value = data.schedule_value;

      // Recompute next_run if schedule changed
      if (data.schedule_type || data.schedule_value) {
        const updatedTask = {
          ...task,
          ...updates,
        };
        if (updatedTask.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(
              updatedTask.schedule_value,
              { tz: TIMEZONE },
            );
            updates.next_run = interval.next().toISOString();
          } catch {
            logger.warn(
              { taskId: data.taskId, value: updatedTask.schedule_value },
              'Invalid cron in task update',
            );
            emitReject('ipc_update_task', 'InvalidPayload', {
              sessionId: data.taskId,
            });
            break;
          }
        } else if (updatedTask.schedule_type === 'interval') {
          const ms = parseInt(updatedTask.schedule_value, 10);
          if (!isNaN(ms) && ms > 0) {
            updates.next_run = new Date(Date.now() + ms).toISOString();
          } else {
            logger.warn(
              { taskId: data.taskId, value: updatedTask.schedule_value },
              'Invalid interval in task update',
            );
            emitReject('ipc_update_task', 'InvalidPayload', {
              sessionId: data.taskId,
            });
            break;
          }
        }
      }

      updateTask(data.taskId, updates);
      logger.debug(
        { taskId: data.taskId, sourceGroup, updates },
        'Task updated via IPC',
      );
      emitIpcAction(sink, {
        level: 'info',
        session_id: data.taskId,
        trigger_source: sourceGroup,
        tool: 'ipc_update_task',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(data.taskId),
        duration_ms: Date.now() - ipcStart,
        outcome: 'ok',
        error_class: null,
        group: task.group_folder,
      });
      deps.onTasksChanged();
      break;
    }

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
        emitReject('ipc_refresh_groups', 'Unauthorized');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        emitReject('ipc_register_group', 'Unauthorized');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          emitReject('ipc_register_group', 'InvalidPayload');
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
        emitReject('ipc_register_group', 'MissingRequiredField');
      }
      break;

    case 'org_action': {
      if (!deps.onOrgAction) {
        logger.warn(
          { sourceGroup },
          'org_action received but no handler is wired',
        );
        emitReject('ipc_org_action', 'Unauthorized');
        break;
      }
      if (
        typeof data.action !== 'string' ||
        typeof data.target_ref !== 'string' ||
        typeof data.reversibility !== 'string' ||
        typeof data.stakes_hint !== 'string'
      ) {
        logger.warn({ sourceGroup }, 'Invalid org_action — missing fields');
        emitReject('ipc_org_action', 'MissingRequiredField');
        break;
      }
      // reversibility/stakes_hint are closed enums; an out-of-set value must be
      // a hard reject, never coerced. A coerced stakes_hint='safe' would route a
      // gated action through the execute path; a coerced reversibility hides the
      // true tier from the approver summary.
      if (
        !isReversibility(data.reversibility) ||
        !isStakesHint(data.stakes_hint)
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid org_action — reversibility/stakes_hint outside the allowed set',
        );
        emitReject('ipc_org_action', 'InvalidPayload');
        break;
      }
      const reversibility: Reversibility = data.reversibility;
      const stakesHint: StakesHint = data.stakes_hint;
      // canonical_args is the exact arg set the host replays. A malformed
      // value must be a hard reject, never coerced to {} — a coerced {} would
      // pass the gate, consume the approval, and then drop the write silently.
      if (!isPlainObject(data.canonical_args)) {
        logger.warn(
          { sourceGroup },
          'Invalid org_action — canonical_args must be a non-array object',
        );
        emitReject('ipc_org_action', 'InvalidPayload');
        break;
      }
      const canonicalArgs: Record<string, unknown> = data.canonical_args;
      if (
        data.citation_refs !== undefined &&
        !isStringArray(data.citation_refs)
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid org_action — citation_refs must be a string array',
        );
        emitReject('ipc_org_action', 'InvalidPayload');
        break;
      }
      const citationRefs: string[] = data.citation_refs ?? [];
      // target_query is the optional Notion page NAME the host resolves to an
      // id host-side (the operator container has no NOTION_API_KEY after
      // sagri-ai#312). A non-string is a hard reject, never coerced — a coerced
      // value would feed the resolver a malformed query.
      if (
        data.target_query !== undefined &&
        typeof data.target_query !== 'string'
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid org_action — target_query must be a string',
        );
        emitReject('ipc_org_action', 'InvalidPayload');
        break;
      }
      const targetQuery: string | undefined = data.target_query;
      // The chat jid that owns the source group is where the approval prompt
      // posts. For main, fall back to the requesting group's own jid.
      const chatJid = chatJidForGroupFolder(registeredGroups, sourceGroup);
      if (!chatJid) {
        logger.warn(
          { sourceGroup },
          'org_action: source group not resolvable to a chat jid',
        );
        emitReject('ipc_org_action', 'TargetGroupNotRegistered');
        break;
      }
      await deps.onOrgAction(
        {
          action: data.action,
          target_ref: data.target_ref,
          target_query: targetQuery,
          reversibility,
          stakes_hint: stakesHint,
          citation_refs: citationRefs,
          canonical_args: canonicalArgs,
        },
        sourceGroup,
        chatJid,
        requestFile,
      );
      emitIpcAction(sink, {
        level: 'info',
        session_id: sourceGroup,
        trigger_source: sourceGroup,
        tool: 'ipc_org_action',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(data.action),
        duration_ms: Date.now() - ipcStart,
        outcome: 'ok',
        error_class: null,
        group: sourceGroup,
      });
      break;
    }

    case 'task_outcome': {
      // Same discipline as org_action: every field is a closed enum or a
      // constrained id, and anything outside the set is a hard reject. A
      // coerced value would put model-authored bytes straight into the Slack
      // line this channel exists to keep host-rendered.
      const parsed = parseTaskOutcome(data);
      if (!parsed.ok) {
        logger.warn(
          { sourceGroup, taskId: data.task_id },
          'Invalid task_outcome — payload outside the allowed shape',
        );
        emitReject('ipc_task_outcome', parsed.error_class);
        break;
      }
      const outcome = parsed.record;
      // `task_id` reaches the container as an env var but arrives here inside a
      // file the container writes, so it is a claim, not a fact. Only the
      // directory the file was drained from is verified. Without this check a
      // group could stamp another group's task id onto a record and either turn
      // that task's next run red or burn its dedupe key so the real outcome
      // never posts.
      const task = getTaskById(outcome.task_id);
      if (!task || task.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, taskId: outcome.task_id },
          'task_outcome: task_id is unknown or belongs to another group',
        );
        emitReject('ipc_task_outcome', 'TaskNotOwnedBySourceGroup');
        break;
      }
      const chatJid = chatJidForGroupFolder(registeredGroups, sourceGroup);
      if (!chatJid) {
        logger.warn(
          { sourceGroup },
          'task_outcome: source group not resolvable to a chat jid',
        );
        emitReject('ipc_task_outcome', 'TargetGroupNotRegistered');
        break;
      }
      // An outcome line reaches Slack from here, never from the scheduler's
      // reply path, so the per-task consecutive-failure threshold has to be
      // applied here too or it covers only one of the two ways a poller reports
      // failure (sagri-tokyo/sagri-ai#659).
      //
      // Only RUN_FAILING_OUTCOME_STATUSES is gated — see its doc in
      // task-outcome.ts for why that set, and only that set, is what the gate
      // can hold back.
      //
      // The gate reads task_run_logs, so it is called only on the branch whose
      // answer it decides; a repeat is dropped either way.
      const isNew = taskOutcomeIsNew(
        outcome.task_id,
        outcome.entity_id,
        outcome.status,
      );
      const disposition: TaskOutcomeDisposition = !isNew
        ? 'repeat'
        : !RUN_FAILING_OUTCOME_STATUSES.has(outcome.status) ||
            failureClearsPostThreshold(task)
          ? 'posted'
          : 'held';
      if (disposition === 'posted') {
        // Post before committing the dedupe row. If the post throws, the outer
        // watcher moves this file to ipc/errors and no row is written, so the
        // next tick re-derives isNew and retries rather than dropping the
        // outcome as an already-reported repeat (sagri-tokyo/nanoclaw#105).
        // Cron output replies to no message, so it must not staple onto
        // whichever human last spoke in the channel (sagri-ai#371).
        await deps.sendMessage(chatJid, renderTaskOutcome(outcome), {
          target: { kind: 'topLevel' },
        });
      } else if (disposition === 'repeat') {
        logger.debug(
          {
            sourceGroup,
            taskId: outcome.task_id,
            entityId: outcome.entity_id,
            status: outcome.status,
          },
          'task_outcome already reported on the previous run; dropping the repeat',
        );
      } else {
        // The gate already logged the suppression at info with the run history
        // behind it; this adds which entity was held.
        logger.debug(
          {
            sourceGroup,
            taskId: outcome.task_id,
            entityId: outcome.entity_id,
            status: outcome.status,
            errorClass: outcome.error_class,
          },
          'task_outcome held back: consecutive-failure threshold not met',
        );
      }
      // Reached after a post or with no post at all. The unposted cases still
      // commit to refresh recorded_at into the current run's window, which is
      // where the scheduler reads the run's status from.
      commitTaskOutcome(
        {
          ...outcome,
          group_folder: sourceGroup,
          recorded_at: new Date().toISOString(),
        },
        disposition,
      );
      emitIpcAction(sink, {
        level: 'info',
        session_id: outcome.task_id,
        trigger_source: sourceGroup,
        tool: 'ipc_task_outcome',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(outcome.status),
        duration_ms: Date.now() - ipcStart,
        outcome: 'ok',
        error_class: null,
        group: sourceGroup,
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
      emitReject('ipc_unknown', 'InvalidPayload');
  }
}

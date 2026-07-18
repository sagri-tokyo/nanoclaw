import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
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
  type OrgActionRefuseReason,
  type OrgActionResult,
  type Reversibility,
  type StakesHint,
} from './org-action-gate.js';
import { RegisteredGroup } from './types.js';

export type ActionSink = (record: ActionRecord) => void;

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

const ORG_ACTION_RESPONSES_SUBDIR = 'org-action-responses';
// request_id is container-supplied and becomes a filename, so it is a
// path-traversal vector. Only a canonical UUID is accepted; anything else is
// treated as "no correlation id" and no response is written.
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Write the org-action result back into the requesting group's own IPC
 * namespace so the container's `org_action` tool can read the verdict and
 * relay it to the agent (nanoclaw#541). The group folder is the trusted
 * directory-derived identity, never container-supplied, so a container can
 * only ever receive a response addressed to itself. Idempotent per requestId;
 * atomic write (temp then rename) so the poller never reads a partial file.
 */
function writeOrgActionResponse(
  sourceGroup: string,
  requestId: string,
  result: OrgActionResult,
): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`org-action response: invalid request id "${requestId}"`);
  }
  const responsesDir = path.join(
    resolveGroupIpcPath(sourceGroup),
    ORG_ACTION_RESPONSES_SUBDIR,
  );
  fs.mkdirSync(responsesDir, { recursive: true });
  const target = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${target}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result));
  fs.renameSync(tempPath, target);
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
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
  ) => Promise<OrgActionResult>;
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
        return stat.isDirectory() && f !== 'errors';
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
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

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

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
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
          }
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
    request_id?: unknown;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
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
      // request_id lets the container correlate a synchronous verdict back to
      // this request (nanoclaw#541).
      const requestId = toRequestId(data.request_id);
      // The audit reject and the container-facing refuse response are a
      // mandatory pair: skip the response write and the awaiting tool hangs to
      // its timeout. Bind them so a branch can never emit one without the other.
      const reject = (
        errorClass: string,
        reason: OrgActionRefuseReason,
      ): void => {
        emitReject('ipc_org_action', errorClass);
        if (requestId) {
          writeOrgActionResponse(sourceGroup, requestId, {
            kind: 'refuse',
            reason,
          });
        }
      };
      if (!deps.onOrgAction) {
        logger.warn(
          { sourceGroup },
          'org_action received but no handler is wired',
        );
        reject('Unauthorized', 'no_handler');
        break;
      }
      if (
        typeof data.action !== 'string' ||
        typeof data.target_ref !== 'string' ||
        typeof data.reversibility !== 'string' ||
        typeof data.stakes_hint !== 'string'
      ) {
        logger.warn({ sourceGroup }, 'Invalid org_action — missing fields');
        reject('MissingRequiredField', 'invalid_request');
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
        reject('InvalidPayload', 'invalid_request');
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
        reject('InvalidPayload', 'invalid_request');
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
        reject('InvalidPayload', 'invalid_request');
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
        reject('InvalidPayload', 'invalid_request');
        break;
      }
      const targetQuery: string | undefined = data.target_query;
      // The chat jid that owns the source group is where the approval prompt
      // posts. For main, fall back to the requesting group's own jid.
      let chatJid: string | undefined;
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === sourceGroup) {
          chatJid = jid;
          break;
        }
      }
      if (!chatJid) {
        logger.warn(
          { sourceGroup },
          'org_action: source group not resolvable to a chat jid',
        );
        reject('TargetGroupNotRegistered', 'unresolved_channel');
        break;
      }
      let result: OrgActionResult;
      try {
        result = await deps.onOrgAction(
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
        );
      } catch (err) {
        // A host-side throw is an AMBIGUOUS outcome, not a refusal: a throw from
        // inside the execute path can happen after the write already landed
        // server-side, so telling the agent "did NOT happen" would invite a
        // duplicate write (the inverse of the nanoclaw#541 bug). Audit it as an
        // error, relay `unknown` so the agent verifies before retrying, and
        // propagate so the drain loop still quarantines the task.
        const errorClass =
          err instanceof Error ? err.constructor.name : 'Error';
        emitIpcAction(sink, {
          level: 'error',
          session_id: sourceGroup,
          trigger_source: sourceGroup,
          tool: 'ipc_org_action',
          inputs_hash: inputsHash,
          outputs_hash: hashFailureOutput({ error_class: errorClass }),
          duration_ms: Date.now() - ipcStart,
          outcome: 'error',
          error_class: errorClass,
          group: sourceGroup,
        });
        if (requestId) {
          writeOrgActionResponse(sourceGroup, requestId, { kind: 'unknown' });
        }
        throw err;
      }
      if (requestId) {
        writeOrgActionResponse(sourceGroup, requestId, result);
      }
      // `rejected` requires a non-empty error_class per the action-record schema.
      const refused = result.kind === 'refuse';
      emitIpcAction(sink, {
        level: refused ? 'warn' : 'info',
        session_id: sourceGroup,
        trigger_source: sourceGroup,
        tool: 'ipc_org_action',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(data.action),
        duration_ms: Date.now() - ipcStart,
        outcome: refused ? 'rejected' : 'ok',
        error_class: refused ? 'OrgActionRefused' : null,
        group: sourceGroup,
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
      emitReject('ipc_unknown', 'InvalidPayload');
  }
}

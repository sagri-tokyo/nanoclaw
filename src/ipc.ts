import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { hashPayload, logger, type ActionRecord } from './logger.js';
import { RegisteredGroup } from './types.js';

function ipcAction(
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
  logger.action({
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
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  const ipcStart = Date.now();
  const inputsHash = hashPayload(data);

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          ipcAction({
            level: 'warn',
            session_id: sourceGroup,
            trigger_source: sourceGroup,
            tool: 'ipc_schedule_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'TargetGroupNotRegistered',
            group: sourceGroup,
          });
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          ipcAction({
            level: 'warn',
            session_id: sourceGroup,
            trigger_source: sourceGroup,
            tool: 'ipc_schedule_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'Unauthorized',
            group: sourceGroup,
          });
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
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
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
        ipcAction({
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
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.debug(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          ipcAction({
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
          ipcAction({
            level: 'warn',
            session_id: data.taskId,
            trigger_source: sourceGroup,
            tool: 'ipc_pause_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'Unauthorized',
            group: sourceGroup,
          });
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.debug(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          ipcAction({
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
          ipcAction({
            level: 'warn',
            session_id: data.taskId,
            trigger_source: sourceGroup,
            tool: 'ipc_resume_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'Unauthorized',
            group: sourceGroup,
          });
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.debug(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          ipcAction({
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
          ipcAction({
            level: 'warn',
            session_id: data.taskId,
            trigger_source: sourceGroup,
            tool: 'ipc_cancel_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'Unauthorized',
            group: sourceGroup,
          });
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          ipcAction({
            level: 'warn',
            session_id: data.taskId,
            trigger_source: sourceGroup,
            tool: 'ipc_update_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'TaskNotFound',
            group: sourceGroup,
          });
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          ipcAction({
            level: 'warn',
            session_id: data.taskId,
            trigger_source: sourceGroup,
            tool: 'ipc_update_task',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - ipcStart,
            outcome: 'rejected',
            error_class: 'Unauthorized',
            group: sourceGroup,
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
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.debug(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        ipcAction({
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
      }
      break;

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
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
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
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Step: register-task — Create or update a ScheduledTask in the database.
 *
 * Idempotent: if a task with the given id already exists, it is updated in
 * place rather than rejected. Reads the prompt from a file (--prompt-file)
 * so multi-line content survives shell quoting.
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { STORE_DIR } from '../src/config.ts';
import { createTask, getTaskById, initDatabase, updateTask } from '../src/db.ts';
import { logger } from '../src/logger.ts';
import { ScheduledTask } from '../src/types.ts';
import { emitStatus } from './status.ts';

interface RegisterTaskArgs {
  id: string;
  groupFolder: string;
  chatJid: string;
  promptFile: string;
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  contextMode: ScheduledTask['context_mode'];
  runbookUrl?: string;
}

export interface UpsertTaskInput {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  contextMode: ScheduledTask['context_mode'];
  /**
   * When `undefined`, the runbook_url column is not touched on update and is
   * stored as `null` on create. A non-empty string is persisted as-is. An
   * empty string is rejected by `parseArgs` and never reaches this function.
   */
  runbookUrl?: string;
}

export class RegisterTaskArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegisterTaskArgError';
  }
}

function parseArgs(args: string[]): RegisterTaskArgs {
  const result: RegisterTaskArgs = {
    id: '',
    groupFolder: '',
    chatJid: '',
    promptFile: '',
    scheduleType: 'cron',
    scheduleValue: '',
    contextMode: 'isolated',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--id':
        result.id = args[++i] || '';
        break;
      case '--group-folder':
        result.groupFolder = args[++i] || '';
        break;
      case '--chat-jid':
        result.chatJid = args[++i] || '';
        break;
      case '--prompt-file':
        result.promptFile = args[++i] || '';
        break;
      case '--schedule-type': {
        const raw = (args[++i] || '') as ScheduledTask['schedule_type'];
        result.scheduleType = raw;
        break;
      }
      case '--schedule-value':
        result.scheduleValue = args[++i] || '';
        break;
      case '--context-mode': {
        const raw = (args[++i] || '') as ScheduledTask['context_mode'];
        result.contextMode = raw;
        break;
      }
      case '--runbook-url': {
        const raw = args[++i];
        if (raw === undefined || raw === '') {
          throw new RegisterTaskArgError(
            '--runbook-url requires a non-empty value',
          );
        }
        result.runbookUrl = raw;
        break;
      }
    }
  }

  return result;
}

function validateScheduleValue(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return null;
    } catch {
      return `Invalid cron expression: ${scheduleValue}`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) {
      return `Invalid interval value (must be positive integer milliseconds): ${scheduleValue}`;
    }
    return null;
  }

  if (scheduleType === 'once') {
    return null;
  }

  return `Unknown schedule_type: ${scheduleType}`;
}

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'once') {
    return new Date().toISOString();
  }

  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue);
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    return new Date(Date.now() + ms).toISOString();
  }

  return null;
}

/**
 * Create-or-update the scheduled task row. Pure with respect to argv parsing
 * and process control: callers (CLI `run`, tests) parse and validate first,
 * then hand a fully-typed input here. Returns whether a row was created or
 * an existing row was updated.
 */
export function upsertTask(input: UpsertTaskInput): 'created' | 'updated' {
  const existing = getTaskById(input.id);

  if (existing) {
    const taskUpdates: Parameters<typeof updateTask>[1] = {
      prompt: input.prompt,
      schedule_type: input.scheduleType,
      schedule_value: input.scheduleValue,
      next_run: computeInitialNextRun(input.scheduleType, input.scheduleValue),
      status: 'active',
    };
    if (input.runbookUrl !== undefined) {
      taskUpdates.runbook_url = input.runbookUrl;
    }
    updateTask(input.id, taskUpdates);
    return 'updated';
  }

  const now = new Date().toISOString();
  createTask({
    id: input.id,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    prompt: input.prompt,
    script: null,
    schedule_type: input.scheduleType,
    schedule_value: input.scheduleValue,
    context_mode: input.contextMode,
    next_run: computeInitialNextRun(input.scheduleType, input.scheduleValue),
    status: 'active',
    created_at: now,
    runbook_url: input.runbookUrl ?? null,
  });
  return 'created';
}

export async function run(args: string[]): Promise<void> {
  let parsed: RegisterTaskArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof RegisterTaskArgError) {
      emitStatus('REGISTER_TASK', {
        STATUS: 'failed',
        ERROR: error.message,
        LOG: 'logs/setup.log',
      });
      process.exit(4);
    }
    throw error;
  }

  if (
    !parsed.id ||
    !parsed.groupFolder ||
    !parsed.chatJid ||
    !parsed.promptFile ||
    !parsed.scheduleType ||
    !parsed.scheduleValue
  ) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!['cron', 'interval', 'once'].includes(parsed.scheduleType)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `invalid_schedule_type: ${parsed.scheduleType}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!['group', 'isolated'].includes(parsed.contextMode)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `invalid_context_mode: ${parsed.contextMode}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const scheduleError = validateScheduleValue(
    parsed.scheduleType,
    parsed.scheduleValue,
  );
  if (scheduleError) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: scheduleError,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const promptFilePath = path.resolve(parsed.promptFile);
  if (!fs.existsSync(promptFilePath)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `prompt_file_not_found: ${promptFilePath}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const prompt = fs.readFileSync(promptFilePath, 'utf-8').trim();
  if (!prompt) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: 'prompt_file_is_empty',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  fs.mkdirSync(STORE_DIR, { recursive: true });
  initDatabase();

  const action = upsertTask({
    id: parsed.id,
    groupFolder: parsed.groupFolder,
    chatJid: parsed.chatJid,
    prompt,
    scheduleType: parsed.scheduleType,
    scheduleValue: parsed.scheduleValue,
    contextMode: parsed.contextMode,
    runbookUrl: parsed.runbookUrl,
  });

  if (action === 'updated') {
    logger.info({ taskId: parsed.id }, 'Task already exists — updating');
  } else {
    logger.info({ taskId: parsed.id }, 'Registered scheduled task');
  }

  emitStatus('REGISTER_TASK', {
    ID: parsed.id,
    GROUP_FOLDER: parsed.groupFolder,
    CHAT_JID: parsed.chatJid,
    SCHEDULE_TYPE: parsed.scheduleType,
    SCHEDULE_VALUE: parsed.scheduleValue,
    CONTEXT_MODE: parsed.contextMode,
    ACTION: action,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// Test-only exports. Underscore prefix matches the convention in `src/db.ts`
// (`_initTestDatabase`, `_closeDatabase`) — these are not part of the
// CLI-facing API but exist so unit tests exercise the same parser and
// scheduling code the CLI runs.
export const _parseArgs = parseArgs;
export const _validateScheduleValue = validateScheduleValue;
export const _computeInitialNextRun = computeInitialNextRun;

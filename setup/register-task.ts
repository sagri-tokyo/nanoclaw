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

const EXIT_BAD_ARGS = 4;

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
   * `undefined` leaves the existing row's `runbook_url` untouched on update
   * and stores `null` on create. A non-empty string is persisted as-is.
   * The empty string is not a permitted value — callers must validate
   * before invoking.
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
 * and process control: callers parse and validate first, then hand a
 * fully-typed input here. Returns whether a row was created or an
 * existing row was updated.
 */
export function upsertTask(input: UpsertTaskInput): 'created' | 'updated' {
  const nextRun = computeInitialNextRun(input.scheduleType, input.scheduleValue);
  const existing = getTaskById(input.id);

  if (existing) {
    const taskUpdates: Parameters<typeof updateTask>[1] = {
      prompt: input.prompt,
      schedule_type: input.scheduleType,
      schedule_value: input.scheduleValue,
      next_run: nextRun,
      status: 'active',
    };
    if (input.runbookUrl !== undefined) {
      taskUpdates.runbook_url = input.runbookUrl;
    }
    updateTask(input.id, taskUpdates);
    return 'updated';
  }

  createTask({
    id: input.id,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    prompt: input.prompt,
    script: null,
    schedule_type: input.scheduleType,
    schedule_value: input.scheduleValue,
    context_mode: input.contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
    runbook_url: input.runbookUrl ?? null,
  });
  return 'created';
}

function failBadArgs(error: string): never {
  emitStatus('REGISTER_TASK', {
    STATUS: 'failed',
    ERROR: error,
    LOG: 'logs/setup.log',
  });
  process.exit(EXIT_BAD_ARGS);
}

export async function run(args: string[]): Promise<void> {
  let parsed: RegisterTaskArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof RegisterTaskArgError) {
      failBadArgs(error.message);
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
    failBadArgs('missing_required_args');
  }

  if (!['cron', 'interval', 'once'].includes(parsed.scheduleType)) {
    failBadArgs(`invalid_schedule_type: ${parsed.scheduleType}`);
  }

  if (!['group', 'isolated'].includes(parsed.contextMode)) {
    failBadArgs(`invalid_context_mode: ${parsed.contextMode}`);
  }

  const scheduleError = validateScheduleValue(
    parsed.scheduleType,
    parsed.scheduleValue,
  );
  if (scheduleError) {
    failBadArgs(scheduleError);
  }

  const promptFilePath = path.resolve(parsed.promptFile);
  if (!fs.existsSync(promptFilePath)) {
    failBadArgs(`prompt_file_not_found: ${promptFilePath}`);
  }

  const prompt = fs.readFileSync(promptFilePath, 'utf-8').trim();
  if (!prompt) {
    failBadArgs('prompt_file_is_empty');
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

  logger.info(
    { taskId: parsed.id, action },
    action === 'updated'
      ? 'Updated existing scheduled task'
      : 'Registered scheduled task',
  );

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

// Test-only re-exports. Underscore prefix matches the convention in
// `src/db.ts` (`_initTestDatabase`, `_closeDatabase`) — these are not part
// of the CLI-facing API but exist so unit tests exercise the same parser
// and scheduling code the CLI runs.
export {
  parseArgs as _parseArgs,
  validateScheduleValue as _validateScheduleValue,
  computeInitialNextRun as _computeInitialNextRun,
};

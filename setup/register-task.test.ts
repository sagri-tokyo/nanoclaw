import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase, getTaskById } from '../src/db.ts';

import {
  RegisterTaskArgError,
  _computeInitialNextRun,
  _parseArgs,
  _validateScheduleValue,
  upsertTask,
} from './register-task.ts';

/**
 * Tests for the register-task setup step.
 *
 * Uses the in-memory test database to avoid touching the filesystem database.
 * Tests import the production helpers (`upsertTask`, `_parseArgs`, etc.)
 * directly so the same code paths the CLI runs are exercised end-to-end
 * minus the `process.exit` / filesystem-db side effects.
 */

describe('schedule value validation', () => {
  it('accepts a valid cron expression', () => {
    const error = _validateScheduleValue('cron', '*/15 * * * *');
    expect(error).toBeNull();
  });

  it('rejects an invalid cron expression', () => {
    const error = _validateScheduleValue('cron', 'not-a-cron');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid cron expression');
  });

  it('accepts a positive interval value', () => {
    const error = _validateScheduleValue('interval', '300000');
    expect(error).toBeNull();
  });

  it('rejects a zero interval value', () => {
    const error = _validateScheduleValue('interval', '0');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('rejects a negative interval value', () => {
    const error = _validateScheduleValue('interval', '-1000');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('rejects a non-numeric interval value', () => {
    const error = _validateScheduleValue('interval', 'abc');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('accepts once with any schedule value', () => {
    const error = _validateScheduleValue('once', '');
    expect(error).toBeNull();
  });
});

describe('initial next_run computation', () => {
  it('returns now for once', () => {
    const beforeCall = Date.now();
    const next = _computeInitialNextRun('once', '');
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThanOrEqual(beforeCall);
  });

  it('returns a future timestamp for cron', () => {
    const next = _computeInitialNextRun('cron', '0 9 * * *');
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a future timestamp for interval', () => {
    const next = _computeInitialNextRun('interval', '60000');
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('register-task create and update', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('creates a new task when none exists', () => {
    const action = upsertTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Poll Notion for ready tasks.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });

    expect(action).toBe('created');

    const stored = getTaskById('notion-poller');
    expect(stored).toBeDefined();
    expect(stored!.id).toBe('notion-poller');
    expect(stored!.group_folder).toBe('slack_main');
    expect(stored!.chat_jid).toBe('C123456@slack');
    expect(stored!.prompt).toBe('Poll Notion for ready tasks.');
    expect(stored!.schedule_type).toBe('cron');
    expect(stored!.schedule_value).toBe('*/15 * * * *');
    expect(stored!.context_mode).toBe('isolated');
    expect(stored!.status).toBe('active');
    expect(stored!.next_run).not.toBeNull();
  });

  it('updates an existing task instead of throwing', () => {
    upsertTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Original prompt.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });

    const action = upsertTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Updated prompt.',
      scheduleType: 'cron',
      scheduleValue: '0 * * * *',
      contextMode: 'isolated',
    });

    expect(action).toBe('updated');

    const stored = getTaskById('notion-poller');
    expect(stored).toBeDefined();
    expect(stored!.prompt).toBe('Updated prompt.');
    expect(stored!.schedule_value).toBe('0 * * * *');
    expect(stored!.status).toBe('active');
  });

  it('stores the task with a future next_run for cron type', () => {
    upsertTask({
      id: 'cron-task',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Do something.',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      contextMode: 'isolated',
    });

    const stored = getTaskById('cron-task');
    expect(stored).toBeDefined();
    expect(stored!.next_run).not.toBeNull();
    expect(new Date(stored!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores the task with a future next_run for interval type', () => {
    upsertTask({
      id: 'interval-task',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Do something on interval.',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
    });

    const stored = getTaskById('interval-task');
    expect(stored).toBeDefined();
    expect(stored!.next_run).not.toBeNull();
    expect(new Date(stored!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('register-task runbook_url handling', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('persists runbook_url when provided on create', () => {
    upsertTask({
      id: 'rbt-create',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      runbookUrl: 'https://www.notion.so/Runbook-x',
    });
    const stored = getTaskById('rbt-create');
    expect(stored!.runbook_url).toBe('https://www.notion.so/Runbook-x');
  });

  it('stores null runbook_url when not provided on create', () => {
    upsertTask({
      id: 'rbt-no-url',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });
    const stored = getTaskById('rbt-no-url');
    expect(stored!.runbook_url).toBeNull();
  });

  it('does not clear existing runbook_url when re-registering without --runbook-url', () => {
    upsertTask({
      id: 'rbt-keep',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      runbookUrl: 'https://www.notion.so/Runbook-x',
    });
    upsertTask({
      id: 'rbt-keep',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated prompt.',
      scheduleType: 'cron',
      scheduleValue: '0 * * * *',
      contextMode: 'isolated',
      // runbookUrl intentionally omitted
    });
    const stored = getTaskById('rbt-keep');
    expect(stored!.runbook_url).toBe('https://www.notion.so/Runbook-x');
  });

  it('overwrites runbook_url when a new url is provided on re-register', () => {
    upsertTask({
      id: 'rbt-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      runbookUrl: 'https://old-runbook.example.com',
    });
    upsertTask({
      id: 'rbt-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      runbookUrl: 'https://new-runbook.example.com',
    });
    const stored = getTaskById('rbt-overwrite');
    expect(stored!.runbook_url).toBe('https://new-runbook.example.com');
  });

  it('rejects empty-string runbookUrl at the upsertTask boundary', () => {
    const call = () =>
      upsertTask({
        id: 'rbt-empty',
        groupFolder: 'slack_main',
        chatJid: 'C123@slack',
        prompt: 'p',
        scheduleType: 'cron',
        scheduleValue: '*/15 * * * *',
        contextMode: 'isolated',
        runbookUrl: '',
      });
    expect(call).toThrow(RegisterTaskArgError);
    expect(call).toThrow(
      'upsertTask: runbookUrl must be a non-empty string or undefined',
    );
  });
});

describe('parseArgs (strict --runbook-url semantics)', () => {
  const baseArgs = [
    '--id',
    't1',
    '--group-folder',
    'slack_main',
    '--chat-jid',
    'C123@slack',
    '--prompt-file',
    '/tmp/prompt.md',
    '--schedule-type',
    'cron',
    '--schedule-value',
    '*/15 * * * *',
    '--context-mode',
    'isolated',
  ];

  it('leaves runbookUrl undefined when the flag is omitted', () => {
    const parsed = _parseArgs(baseArgs);
    expect(parsed.runbookUrl).toBeUndefined();
  });

  it('captures a non-empty runbook url', () => {
    const parsed = _parseArgs([
      ...baseArgs,
      '--runbook-url',
      'https://www.notion.so/Runbook-x',
    ]);
    expect(parsed.runbookUrl).toBe('https://www.notion.so/Runbook-x');
  });

  it('rejects an empty --runbook-url with RegisterTaskArgError', () => {
    expect(() => _parseArgs([...baseArgs, '--runbook-url', ''])).toThrow(
      RegisterTaskArgError,
    );
    expect(() => _parseArgs([...baseArgs, '--runbook-url', ''])).toThrow(
      '--runbook-url requires a non-empty value',
    );
  });

  it('rejects a trailing --runbook-url with no value', () => {
    expect(() => _parseArgs([...baseArgs, '--runbook-url'])).toThrow(
      RegisterTaskArgError,
    );
  });
});

describe('parseArgs (strict --post-after-fails semantics)', () => {
  const baseArgs = [
    '--id',
    't1',
    '--group-folder',
    'slack_main',
    '--chat-jid',
    'C123@slack',
    '--prompt-file',
    '/tmp/prompt.md',
    '--schedule-type',
    'cron',
    '--schedule-value',
    '*/15 * * * *',
    '--context-mode',
    'isolated',
  ];

  it('leaves postAfterFails undefined when the flag is omitted', () => {
    const parsed = _parseArgs(baseArgs);
    expect(parsed.postAfterFails).toBeUndefined();
  });

  it('captures --post-after-fails 1 as the integer 1', () => {
    const parsed = _parseArgs([...baseArgs, '--post-after-fails', '1']);
    expect(parsed.postAfterFails).toBe(1);
  });

  it('captures --post-after-fails 3 as the integer 3', () => {
    const parsed = _parseArgs([...baseArgs, '--post-after-fails', '3']);
    expect(parsed.postAfterFails).toBe(3);
  });

  it('rejects --post-after-fails 0 with RegisterTaskArgError', () => {
    expect(() => _parseArgs([...baseArgs, '--post-after-fails', '0'])).toThrow(
      RegisterTaskArgError,
    );
    expect(() => _parseArgs([...baseArgs, '--post-after-fails', '0'])).toThrow(
      'positive integer',
    );
  });

  it('rejects a negative --post-after-fails value', () => {
    expect(() => _parseArgs([...baseArgs, '--post-after-fails', '-3'])).toThrow(
      RegisterTaskArgError,
    );
  });

  it('rejects a non-numeric --post-after-fails value', () => {
    expect(() =>
      _parseArgs([...baseArgs, '--post-after-fails', 'abc']),
    ).toThrow(RegisterTaskArgError);
  });

  it('rejects an empty --post-after-fails value', () => {
    expect(() => _parseArgs([...baseArgs, '--post-after-fails', ''])).toThrow(
      RegisterTaskArgError,
    );
  });

  it('rejects a trailing --post-after-fails with no value', () => {
    expect(() => _parseArgs([...baseArgs, '--post-after-fails'])).toThrow(
      RegisterTaskArgError,
    );
  });
});

describe('register-task failure_post_threshold handling', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('stores the column DEFAULT (2) when postAfterFails is omitted on create', () => {
    upsertTask({
      id: 'thr-default',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });
    const stored = getTaskById('thr-default');
    expect(stored!.failure_post_threshold).toBe(2);
  });

  it('persists postAfterFails on create', () => {
    upsertTask({
      id: 'thr-create',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      postAfterFails: 1,
    });
    const stored = getTaskById('thr-create');
    expect(stored!.failure_post_threshold).toBe(1);
  });

  it('preserves the existing threshold when postAfterFails is omitted on update', () => {
    upsertTask({
      id: 'thr-keep',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      postAfterFails: 5,
    });
    upsertTask({
      id: 'thr-keep',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated prompt.',
      scheduleType: 'cron',
      scheduleValue: '0 * * * *',
      contextMode: 'isolated',
      // postAfterFails intentionally omitted
    });
    const stored = getTaskById('thr-keep');
    expect(stored!.failure_post_threshold).toBe(5);
  });

  it('overwrites the threshold when a new value is provided on update', () => {
    upsertTask({
      id: 'thr-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      postAfterFails: 5,
    });
    upsertTask({
      id: 'thr-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      postAfterFails: 3,
    });
    const stored = getTaskById('thr-overwrite');
    expect(stored!.failure_post_threshold).toBe(3);
  });
});

describe('parseArgs (strict --capability-profile semantics)', () => {
  const baseArgs = [
    '--id',
    't1',
    '--group-folder',
    'slack_main',
    '--chat-jid',
    'C123@slack',
    '--prompt-file',
    '/tmp/prompt.md',
    '--schedule-type',
    'cron',
    '--schedule-value',
    '*/15 * * * *',
    '--context-mode',
    'isolated',
  ];

  it('defaults to operator when the flag is omitted (fail-closed)', () => {
    const parsed = _parseArgs(baseArgs);
    expect(parsed.capabilityProfile).toBe('operator');
  });

  it('captures --capability-profile trusted-writer', () => {
    const parsed = _parseArgs([
      ...baseArgs,
      '--capability-profile',
      'trusted-writer',
    ]);
    expect(parsed.capabilityProfile).toBe('trusted-writer');
  });

  it('captures --capability-profile operator', () => {
    const parsed = _parseArgs([
      ...baseArgs,
      '--capability-profile',
      'operator',
    ]);
    expect(parsed.capabilityProfile).toBe('operator');
  });

  it('rejects an unknown --capability-profile value', () => {
    expect(() =>
      _parseArgs([...baseArgs, '--capability-profile', 'root']),
    ).toThrow(RegisterTaskArgError);
    expect(() =>
      _parseArgs([...baseArgs, '--capability-profile', 'root']),
    ).toThrow(
      '--capability-profile must be one of operator, trusted-writer (got root)',
    );
  });

  it('rejects an empty --capability-profile value', () => {
    expect(() => _parseArgs([...baseArgs, '--capability-profile', ''])).toThrow(
      RegisterTaskArgError,
    );
  });

  it('rejects a trailing --capability-profile with no value', () => {
    expect(() => _parseArgs([...baseArgs, '--capability-profile'])).toThrow(
      RegisterTaskArgError,
    );
  });
});

describe('register-task capability_profile handling', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('defaults capability_profile to operator on create when omitted', () => {
    upsertTask({
      id: 'cap-default',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });
    expect(getTaskById('cap-default')!.capability_profile).toBe('operator');
  });

  it('persists capability_profile trusted-writer on create', () => {
    upsertTask({
      id: 'cap-trusted',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Poll Notion.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      capabilityProfile: 'trusted-writer',
    });
    expect(getTaskById('cap-trusted')!.capability_profile).toBe(
      'trusted-writer',
    );
  });

  it('overwrites the profile when a new value is provided on update', () => {
    upsertTask({
      id: 'cap-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      capabilityProfile: 'operator',
    });
    upsertTask({
      id: 'cap-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      capabilityProfile: 'trusted-writer',
    });
    expect(getTaskById('cap-overwrite')!.capability_profile).toBe(
      'trusted-writer',
    );
  });
});

describe('prompt file handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-register-task-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads multi-line prompt from file', () => {
    const promptPath = path.join(tmpDir, 'prompt.md');
    const multiLinePrompt = 'Line one.\nLine two.\nLine three.';
    fs.writeFileSync(promptPath, multiLinePrompt);

    const content = fs.readFileSync(promptPath, 'utf-8').trim();
    expect(content).toBe(multiLinePrompt);
  });

  it('detects missing prompt file', () => {
    const missing = path.join(tmpDir, 'nonexistent.md');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('detects empty prompt file', () => {
    const emptyPath = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(emptyPath, '   \n  ');
    const content = fs.readFileSync(emptyPath, 'utf-8').trim();
    expect(content).toBe('');
  });
});

describe('parseArgs (strict --reply-mode semantics)', () => {
  const baseArgs = [
    '--id',
    't1',
    '--group-folder',
    'slack_main',
    '--chat-jid',
    'C123@slack',
    '--prompt-file',
    '/tmp/prompt.md',
    '--schedule-type',
    'cron',
    '--schedule-value',
    '*/15 * * * *',
    '--context-mode',
    'isolated',
  ];

  it('defaults to text when the flag is omitted', () => {
    expect(_parseArgs(baseArgs).replyMode).toBe('text');
  });

  it('captures --reply-mode structured', () => {
    expect(
      _parseArgs([...baseArgs, '--reply-mode', 'structured']).replyMode,
    ).toBe('structured');
  });

  it('captures --reply-mode text', () => {
    expect(_parseArgs([...baseArgs, '--reply-mode', 'text']).replyMode).toBe(
      'text',
    );
  });

  it('rejects an unknown --reply-mode value', () => {
    expect(() => _parseArgs([...baseArgs, '--reply-mode', 'json'])).toThrow(
      '--reply-mode must be one of text, structured (got json)',
    );
  });

  it('rejects an empty --reply-mode value', () => {
    expect(() => _parseArgs([...baseArgs, '--reply-mode', ''])).toThrow(
      RegisterTaskArgError,
    );
  });

  it('rejects a trailing --reply-mode with no value', () => {
    expect(() => _parseArgs([...baseArgs, '--reply-mode'])).toThrow(
      RegisterTaskArgError,
    );
  });
});

describe('register-task reply_mode handling', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('defaults reply_mode to text on create when omitted', () => {
    upsertTask({
      id: 'reply-default',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Do work.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });
    expect(getTaskById('reply-default')!.reply_mode).toBe('text');
  });

  it('persists reply_mode structured on create', () => {
    upsertTask({
      id: 'reply-structured',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Poll and report.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      replyMode: 'structured',
    });
    expect(getTaskById('reply-structured')!.reply_mode).toBe('structured');
  });

  it('overwrites reply_mode when a new value is provided on update', () => {
    upsertTask({
      id: 'reply-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Original.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      replyMode: 'text',
    });
    upsertTask({
      id: 'reply-overwrite',
      groupFolder: 'slack_main',
      chatJid: 'C123@slack',
      prompt: 'Updated.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
      replyMode: 'structured',
    });
    expect(getTaskById('reply-overwrite')!.reply_mode).toBe('structured');
  });
});

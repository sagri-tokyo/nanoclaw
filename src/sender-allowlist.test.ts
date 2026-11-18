import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  filterPromptMessages,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  // Fail-closed (sagri-ai#709): every unusable-config path denies all senders
  // and drops their messages.
  function expectDenyAll(cfg: SenderAllowlistConfig): void {
    expect(cfg.default).toEqual({ allow: [], mode: 'drop' });
    expect(cfg.chats).toEqual({});
    expect(isSenderAllowed('any-chat', 'anyone', cfg)).toBe(false);
    expect(shouldDropMessage('any-chat', cfg)).toBe(true);
  }

  it('denies all (drop) when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expectDenyAll(cfg);
    expect(cfg.logDenied).toBe(true);
  });

  it('denies all when the path is unreadable (a directory)', () => {
    const p = cfgPath('dir');
    fs.mkdirSync(p);
    expectDenyAll(loadSenderAllowlist(p));
  });

  it.each([
    ['null', null],
    ['an array', [{ allow: '*', mode: 'trigger' }]],
    ['a string', '*'],
    ['an empty object', {}],
  ])('denies all when the top level is %s', (_label, value) => {
    expectDenyAll(loadSenderAllowlist(writeConfig(value)));
  });

  it('a deny-all result is a fresh object each call (no shared mutable default)', () => {
    const a = loadSenderAllowlist(cfgPath());
    (a.default.allow as string[]).push('mallory');
    const b = loadSenderAllowlist(cfgPath());
    expect(b.default.allow).toEqual([]);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('denies all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    expectDenyAll(loadSenderAllowlist(p));
  });

  it('denies all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    expectDenyAll(loadSenderAllowlist(p));
  });

  it('denies all on an invalid mode', () => {
    const p = writeConfig({ default: { allow: '*', mode: 'open' }, chats: {} });
    expectDenyAll(loadSenderAllowlist(p));
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    expectDenyAll(loadSenderAllowlist(p));
  });

  it('denies a chat whose per-chat entry is invalid instead of using the default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toEqual({ allow: [], mode: 'drop' });
    expect(isSenderAllowed('bad', 'anyone', cfg)).toBe(false);
    expect(isSenderAllowed('other', 'anyone', cfg)).toBe(true);
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('filterPromptMessages (sagri-ai#709)', () => {
  const cfg: SenderAllowlistConfig = {
    default: { allow: ['alice'], mode: 'trigger' },
    chats: {},
    logDenied: true,
  };
  const msgs = [
    { id: '1', sender: 'alice' },
    { id: '2', sender: 'mallory' },
    { id: '3', sender: 'bot', is_from_me: true },
    { id: '4', sender: 'B_OTHER', is_bot_message: true },
    { id: '5', sender: 'eve', is_from_me: false, is_bot_message: false },
  ];

  it('drops non-allowlisted human senders, keeps allowed and bot rows', () => {
    expect(filterPromptMessages('g', msgs, cfg).map((m) => m.id)).toEqual([
      '1',
      '3',
      '4',
    ]);
  });

  it('is a no-op under allow=*', () => {
    const open: SenderAllowlistConfig = {
      ...cfg,
      default: { allow: '*', mode: 'trigger' },
    };
    expect(filterPromptMessages('g', msgs, open)).toHaveLength(msgs.length);
  });

  it('keeps no human messages under the fail-closed config', () => {
    const denied = loadSenderAllowlist(path.join(tmpDir, 'missing.json'));
    expect(filterPromptMessages('g', msgs, denied).map((m) => m.id)).toEqual([
      '3',
      '4',
    ]);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type http from 'http';

// --- Mocks ---
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
  SLACK_FILE_INGESTION: true,
  SLACK_FILE_MAX_BYTES: 262144,
  SLACK_FILE_MAX_COUNT: 10,
  SLACK_FILE_MAX_ROWS: 1000,
  SLACK_FILE_MAX_PROMPT_CHARS: 120000,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  hashPayload: vi.fn(() => 'h'),
  hashFailureOutput: vi.fn(() => 'h'),
}));

vi.mock('../db.js', () => ({ updateChatName: vi.fn() }));

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, (...a: any[]) => any>();
    token: string;
    appToken: string;
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }) },
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.1' }) },
      conversations: {
        list: vi
          .fn()
          .mockResolvedValue({ channels: [], response_metadata: {} }),
        replies: vi.fn().mockResolvedValue({ messages: [] }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { real_name: 'Alice' } }),
      },
      files: { info: vi.fn() },
    };
    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }
    event(name: string, handler: (...a: any[]) => any) {
      this.eventHandlers.set(name, handler);
    }
    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import {
  SlackChannel,
  SlackChannelOpts,
  extractFileBundle,
  FileFetchError,
} from './slack.js';
import type { FetchUntrustedDeps } from '../fetch-untrusted.js';
import type { NewMessage } from '../types.js';

// A scripted ClientRequest stub recording per-hop request options.
function makeStub(
  responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }>,
) {
  const seen: Array<Record<string, string | undefined>> = [];
  const factory = (options: http.RequestOptions): http.ClientRequest => {
    const idx = seen.length;
    seen.push((options.headers ?? {}) as Record<string, string | undefined>);
    const req = new EventEmitter() as any;
    req.write = () => {};
    req.destroy = (err: Error) =>
      process.nextTick(() => req.emit('error', err));
    req.end = () => {
      const r = responses[Math.min(idx, responses.length - 1)];
      process.nextTick(() => {
        const res = new EventEmitter() as any;
        res.statusCode = r.status;
        res.headers = r.headers ?? {};
        req.emit('response', res);
        const buf = Buffer.isBuffer(r.body)
          ? r.body
          : Buffer.from(r.body ?? '');
        process.nextTick(() => {
          if (buf.length) res.emit('data', buf);
          process.nextTick(() => res.emit('end'));
        });
      });
    };
    return req as http.ClientRequest;
  };
  return { factory, seen };
}

const lookupPublic = async () => ({ address: '8.8.8.8', family: 4 as const });

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

async function triggerEvent(event: Record<string, unknown>) {
  const handler = appRef.current.eventHandlers.get('message');
  if (handler) await handler({ event });
}

describe('extractFileBundle', () => {
  it('maps Slack file objects to metadata-only refs', () => {
    const b = extractFileBundle(
      [
        {
          id: 'F1',
          name: 'a.csv',
          mimetype: 'text/csv',
          size: 10,
          url_private_download: 'https://files.slack.com/a',
        },
      ],
      10,
    );
    expect(b?.refs[0]).toEqual({
      id: 'F1',
      name: 'a.csv',
      mimetype: 'text/csv',
      size: 10,
      url_private_download: 'https://files.slack.com/a',
    });
  });

  it('falls back to url_private when url_private_download is absent', () => {
    const b = extractFileBundle(
      [{ id: 'F1', url_private: 'https://files.slack.com/p' }],
      10,
    );
    expect(b?.refs[0].url_private_download).toBe('https://files.slack.com/p');
  });

  it('caps at maxCount and records omitted_count', () => {
    const raw = Array.from({ length: 4 }, (_, i) => ({ id: `F${i}` }));
    const b = extractFileBundle(raw, 2);
    expect(b?.refs).toHaveLength(2);
    expect(b?.omitted_count).toBe(2);
  });

  it('drops entries without a string id; returns undefined when empty', () => {
    expect(extractFileBundle([{ name: 'no-id' }], 10)).toBeUndefined();
    expect(extractFileBundle([], 10)).toBeUndefined();
    expect(extractFileBundle(undefined, 10)).toBeUndefined();
  });
});

describe('inbound file capture', () => {
  let onMessage = vi.fn();
  beforeEach(async () => {
    onMessage = vi.fn();
    const channel = new SlackChannel(createTestOpts({ onMessage }));
    await channel.connect();
  });

  it('attaches a files bundle to a message with text + files', async () => {
    await triggerEvent({
      channel: 'C0123456789',
      channel_type: 'channel',
      user: 'U_USER_456',
      text: '@Jonesy process these',
      ts: '1704067200.000000',
      files: [{ id: 'F1', name: 'a.csv', mimetype: 'text/csv' }],
    });
    const msg = onMessage.mock.calls[0][1] as NewMessage;
    expect(msg.files?.refs[0]).toMatchObject({ id: 'F1', name: 'a.csv' });
  });

  it('gives a files-only message neutral non-trigger content', async () => {
    await triggerEvent({
      channel: 'C0123456789',
      channel_type: 'channel',
      user: 'U_USER_456',
      ts: '1704067201.000000',
      subtype: 'file_share',
      files: [{ id: 'F1' }, { id: 'F2' }],
    });
    const msg = onMessage.mock.calls[0][1] as NewMessage;
    expect(msg.content).toBe('[shared 2 files]');
    expect(msg.files?.refs).toHaveLength(2);
  });
});

describe('fetchFileContent', () => {
  it('downloads with a Bearer token over the SSRF-guarded fetcher', async () => {
    const { factory, seen } = makeStub([{ status: 200, body: 'a,b\n1,2' }]);
    const deps: FetchUntrustedDeps = {
      lookup: lookupPublic,
      httpsRequestFactory: factory,
    };
    const channel = new SlackChannel(createTestOpts({ fetchDeps: deps }));
    const res = await channel.fetchFileContent({
      id: 'F1',
      name: 'a.csv',
      mimetype: 'text/csv',
      url_private_download: 'https://files.slack.com/a.csv',
    });
    expect(res.bytes.toString('utf-8')).toBe('a,b\n1,2');
    expect(res.mimetype).toBe('text/csv');
    expect(seen[0].authorization).toBe('Bearer xoxb-test-token');
  });

  it('resolves an incomplete ref via files.info', async () => {
    const { factory } = makeStub([{ status: 200, body: 'x' }]);
    const channel = new SlackChannel(
      createTestOpts({
        fetchDeps: { lookup: lookupPublic, httpsRequestFactory: factory },
      }),
    );
    appRef.current.client.files.info.mockResolvedValueOnce({
      file: {
        id: 'F1',
        name: 'resolved.csv',
        mimetype: 'text/csv',
        url_private_download: 'https://files.slack.com/resolved.csv',
      },
    });
    const res = await channel.fetchFileContent({
      id: 'F1',
      file_access: 'check_file_info',
    });
    expect(appRef.current.client.files.info).toHaveBeenCalledWith({
      file: 'F1',
    });
    expect(res.mimetype).toBe('text/csv');
  });

  it('rejects a non-Slack download host without fetching', async () => {
    const { factory, seen } = makeStub([{ status: 200, body: 'x' }]);
    const channel = new SlackChannel(
      createTestOpts({
        fetchDeps: { lookup: lookupPublic, httpsRequestFactory: factory },
      }),
    );
    await expect(
      channel.fetchFileContent({
        id: 'F1',
        mimetype: 'text/csv',
        url_private_download: 'https://evil.example/a.csv',
      }),
    ).rejects.toMatchObject({ reason: 'untrusted_host' });
    expect(seen).toHaveLength(0);
  });

  it('maps a 401 to the files:read-denied reason', async () => {
    const { factory } = makeStub([{ status: 401, body: 'no' }]);
    const channel = new SlackChannel(
      createTestOpts({
        fetchDeps: { lookup: lookupPublic, httpsRequestFactory: factory },
      }),
    );
    await expect(
      channel.fetchFileContent({
        id: 'F1',
        mimetype: 'text/csv',
        url_private_download: 'https://files.slack.com/a.csv',
      }),
    ).rejects.toMatchObject({ reason: 'slack_files_read_denied' });
  });

  it('throws FileFetchError when the ref has no download url', async () => {
    const channel = new SlackChannel(createTestOpts());
    appRef.current.client.files.info.mockResolvedValueOnce({
      file: { id: 'F1' },
    });
    await expect(channel.fetchFileContent({ id: 'F1' })).rejects.toBeInstanceOf(
      FileFetchError,
    );
  });
});

describe('fetchThread file capture', () => {
  it('captures file refs on thread replies', async () => {
    const channel = new SlackChannel(createTestOpts());
    await channel.connect();
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      messages: [
        {
          ts: '1.1',
          text: 'see attached',
          user: 'U_USER_456',
          files: [{ id: 'F7', name: 'data.csv', mimetype: 'text/csv' }],
        },
      ],
    });
    const out = await channel.fetchThread('slack:C0123456789', '1.1', 50);
    expect(out[0].files?.refs[0]).toMatchObject({ id: 'F7' });
  });

  it('keeps a files-only reply with neutral synthetic content (judge can see it)', async () => {
    const channel = new SlackChannel(createTestOpts());
    await channel.connect();
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      messages: [
        { ts: '1.0', text: 'here is the question', user: 'U_USER_456' },
        // user's latest reply: a file with NO accompanying text
        {
          ts: '1.2',
          user: 'U_USER_456',
          files: [{ id: 'F9', name: 'data.csv', mimetype: 'text/csv' }],
        },
        // a genuinely empty message (no text, no files) must be skipped
        { ts: '1.3', user: 'U_USER_789' },
      ],
    });
    const out = await channel.fetchThread('slack:C0123456789', '1.0', 50);
    expect(out).toHaveLength(2);
    const filesOnly = out.find((m) => m.id === '1.2');
    expect(filesOnly?.content).toBe('[shared 1 file]');
    expect(filesOnly?.files?.refs[0]).toMatchObject({ id: 'F9' });
  });
});

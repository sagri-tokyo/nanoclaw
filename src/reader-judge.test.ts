import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { judgeShouldReply } from './reader.js';

let server: http.Server;
let lastBody = '';
let respondText = '';
let respondStatus = 200;

beforeEach(async () => {
  respondStatus = 200;
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf-8');
        res.statusCode = respondStatus;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'claude-haiku-4-5',
            content: [{ type: 'text', text: respondText }],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  mockEnv.ANTHROPIC_API_KEY = 'test-key';
  mockEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('judgeShouldReply', () => {
  it('returns true when the model says should_reply: true', async () => {
    respondText = JSON.stringify({
      should_reply: true,
      reason: 'addressed to the assistant',
    });
    const v = await judgeShouldReply('alice: @sagri-ai check this', 'sagri-ai');
    expect(v.should_reply).toBe(true);
    expect(v.reason).toContain('assistant');
  });

  it('returns false when the model says should_reply: false', async () => {
    respondText = JSON.stringify({
      should_reply: false,
      reason: 'human chatter',
    });
    const v = await judgeShouldReply('alice: hey bob', 'sagri-ai');
    expect(v.should_reply).toBe(false);
  });

  it('tolerates a code-fenced JSON response', async () => {
    respondText = '```json\n{"should_reply": true, "reason": "ok"}\n```';
    const v = await judgeShouldReply('x', 'sagri-ai');
    expect(v.should_reply).toBe(true);
  });

  it('coerces a missing/non-boolean should_reply to false (fail closed)', async () => {
    respondText = JSON.stringify({ reason: 'no decision field' });
    const v = await judgeShouldReply('x', 'sagri-ai');
    expect(v.should_reply).toBe(false);
  });

  it('throws on a non-2xx response so callers fail closed', async () => {
    respondStatus = 500;
    respondText = '{}';
    await expect(judgeShouldReply('x', 'sagri-ai')).rejects.toThrow();
  });

  it('passes the assistant name in the system prompt and uses Haiku', async () => {
    respondText = JSON.stringify({ should_reply: false, reason: '' });
    await judgeShouldReply('x', 'sagri-ai');
    const parsed = JSON.parse(lastBody);
    expect(parsed.system).toContain('sagri-ai');
    expect(parsed.model).toBe('claude-haiku-4-5');
  });
});

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

import { classifyFileRisk } from './reader.js';

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

describe('classifyFileRisk', () => {
  it('returns flags and a summary on a clean response', async () => {
    respondText = JSON.stringify({
      risk_flags: ['prompt_injection'],
      summary: 'a CSV of suppliers',
    });
    const r = await classifyFileRisk('["a","b"]', 'text/csv');
    expect(r.risk_flags).toEqual(['prompt_injection']);
    expect(r.summary).toBe('a CSV of suppliers');
  });

  it('uses the Haiku model and the sanitized content as input', async () => {
    respondText = JSON.stringify({ risk_flags: [], summary: 'ok' });
    await classifyFileRisk('SANITIZED_BODY', 'text/csv');
    const sent = JSON.parse(lastBody);
    expect(sent.model).toBe('claude-haiku-4-5');
    expect(JSON.stringify(sent.messages)).toContain('SANITIZED_BODY');
  });

  it('tolerates a code-fenced JSON response', async () => {
    respondText = '```json\n{"risk_flags":["ambiguous"],"summary":"x"}\n```';
    const r = await classifyFileRisk('x', 'text/plain');
    expect(r.risk_flags).toEqual(['ambiguous']);
  });

  it('clamps an oversized summary and too-many flags', async () => {
    respondText = JSON.stringify({
      risk_flags: Array.from({ length: 50 }, (_, i) => `flag_${i}`),
      summary: 'z'.repeat(500),
    });
    const r = await classifyFileRisk('x', 'text/plain');
    expect(r.risk_flags.length).toBeLessThanOrEqual(16);
    expect(r.summary.length).toBeLessThanOrEqual(200);
  });

  it('drops non-string flags', async () => {
    respondText = JSON.stringify({
      risk_flags: ['ok', 123, null, 'fine'],
      summary: 's',
    });
    const r = await classifyFileRisk('x', 'text/plain');
    expect(r.risk_flags).toEqual(['ok', 'fine']);
  });

  it('throws on a non-2xx response (caller fails safe)', async () => {
    respondStatus = 500;
    respondText = 'err';
    await expect(classifyFileRisk('x', 'text/plain')).rejects.toThrow();
  });

  it('throws on malformed JSON', async () => {
    respondText = 'not json at all';
    await expect(classifyFileRisk('x', 'text/plain')).rejects.toThrow();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (key in mockEnv) result[key] = mockEnv[key];
    }
    return result;
  }),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  },
}));

const config = {
  LITELLM_GATEWAY_PORT: 4000,
  LITELLM_PER_TASK_BUDGET_USD: 1,
};
vi.mock('./config.js', () => ({
  get LITELLM_GATEWAY_PORT() {
    return config.LITELLM_GATEWAY_PORT;
  },
  get LITELLM_PER_TASK_BUDGET_USD() {
    return config.LITELLM_PER_TASK_BUDGET_USD;
  },
}));

import { litellmEnabled, mintVirtualKey } from './litellm-gateway.js';

function clearMockEnv(): void {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
}

describe('litellmEnabled', () => {
  afterEach(clearMockEnv);

  it('is true when LITELLM_MASTER_KEY is a non-empty string', () => {
    mockEnv.LITELLM_MASTER_KEY = 'sk-master-abc';
    expect(litellmEnabled()).toBe(true);
  });

  it('is false when LITELLM_MASTER_KEY is absent', () => {
    expect(litellmEnabled()).toBe(false);
  });

  it('is false when LITELLM_MASTER_KEY is an empty string', () => {
    mockEnv.LITELLM_MASTER_KEY = '';
    expect(litellmEnabled()).toBe(false);
  });
});

describe('mintVirtualKey', () => {
  let gateway: http.Server;
  let requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
  let respond: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: 'sk-virtual-task-key' }));
    };
    gateway = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString(),
        });
        respond(res);
      });
    });
    await new Promise<void>((resolve) =>
      gateway.listen(0, '127.0.0.1', resolve),
    );
    config.LITELLM_GATEWAY_PORT = (gateway.address() as AddressInfo).port;
    config.LITELLM_PER_TASK_BUDGET_USD = 1;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    clearMockEnv();
  });

  it('POSTs to /key/generate with the Bearer master key and the budget body, and returns the key', async () => {
    mockEnv.LITELLM_MASTER_KEY = 'sk-master-abc';
    config.LITELLM_PER_TASK_BUDGET_USD = 2.5;

    const key = await mintVirtualKey({
      taskId: 'nanoclaw-test-group-1700000000000',
      channel: 'test-group',
    });

    expect(key).toBe('sk-virtual-task-key');
    expect(requests).toHaveLength(1);
    const received = requests[0];
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/key/generate');
    expect(received.headers['authorization']).toBe('Bearer sk-master-abc');
    expect(received.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received.body)).toEqual({
      key_alias: 'task-nanoclaw-test-group-1700000000000',
      max_budget: 2.5,
      duration: '24h',
      metadata: {
        task_id: 'nanoclaw-test-group-1700000000000',
        channel: 'test-group',
      },
    });
  });

  it('throws when LITELLM_MASTER_KEY is absent', async () => {
    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/LITELLM_MASTER_KEY/);
    expect(requests).toHaveLength(0);
  });

  it('throws when the gateway returns a non-200 status', async () => {
    mockEnv.LITELLM_MASTER_KEY = 'sk-master-abc';
    respond = (res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/403/);
  });

  it('throws when the response has no string key field', async () => {
    mockEnv.LITELLM_MASTER_KEY = 'sk-master-abc';
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ not_a_key: true }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/key/);
  });
});

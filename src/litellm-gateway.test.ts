import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

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

// readEnvFile reads LITELLM_MASTER_KEY from CREDENTIALS_DIRECTORY (one file per
// key). Point it at a per-test temp dir and write the key file there so the real
// env-source logic runs instead of a stub of our own module.
const savedCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
let credentialsDirectory: string;

beforeEach(() => {
  credentialsDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'litellm-gateway-test-'),
  );
  process.env.CREDENTIALS_DIRECTORY = credentialsDirectory;
});

afterEach(() => {
  if (savedCredentialsDirectory === undefined) {
    delete process.env.CREDENTIALS_DIRECTORY;
  } else {
    process.env.CREDENTIALS_DIRECTORY = savedCredentialsDirectory;
  }
  fs.rmSync(credentialsDirectory, { recursive: true, force: true });
});

function setMasterKey(value: string): void {
  fs.writeFileSync(
    path.join(credentialsDirectory, 'LITELLM_MASTER_KEY'),
    value,
  );
}

describe('litellmEnabled', () => {
  it('is true when LITELLM_MASTER_KEY is a non-empty string', () => {
    setMasterKey('sk-master-abc');
    expect(litellmEnabled()).toBe(true);
  });

  it('is false when LITELLM_MASTER_KEY is absent', () => {
    expect(litellmEnabled()).toBe(false);
  });

  it('is false when LITELLM_MASTER_KEY is an empty string', () => {
    setMasterKey('');
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
  let respond: (res: http.ServerResponse, url: string | undefined) => void;

  beforeEach(async () => {
    requests = [];
    respond = (res, url) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        url === '/user/new'
          ? JSON.stringify({ user_id: 'test-group' })
          : JSON.stringify({ key: 'sk-virtual-task-key' }),
      );
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
        respond(res, req.url);
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
  });

  it('POSTs to /key/generate with the Bearer master key and the budget body, and returns the key', async () => {
    setMasterKey('sk-master-abc');
    config.LITELLM_PER_TASK_BUDGET_USD = 2.5;

    const key = await mintVirtualKey({
      taskId: 'nanoclaw-test-group-1700000000000',
      channel: 'test-group',
    });

    expect(key).toBe('sk-virtual-task-key');
    expect(requests).toHaveLength(2);
    const received = requests[1];
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/key/generate');
    expect(received.headers['authorization']).toBe('Bearer sk-master-abc');
    expect(received.headers['content-type']).toBe('application/json');
    const body = JSON.parse(received.body);
    // key_alias carries a random suffix for uniqueness; the rest is exact.
    expect(body.key_alias).toMatch(
      /^task-nanoclaw-test-group-1700000000000-[0-9a-f]{12}$/,
    );
    expect(body.max_budget).toBe(2.5);
    expect(body.duration).toBe('24h');
    expect(body.user_id).toBe('test-group');
    expect(body.metadata).toEqual({
      task_id: 'nanoclaw-test-group-1700000000000',
      channel: 'test-group',
    });
  });

  it('creates the channel user row before minting, without a budget of its own', async () => {
    setMasterKey('sk-master-abc');

    await mintVirtualKey({
      taskId: 'nanoclaw-test-group-1700000000000',
      channel: 'test-group',
    });

    expect(requests.map((r) => r.url)).toEqual(['/user/new', '/key/generate']);
    const received = requests[0];
    expect(received.method).toBe('POST');
    expect(received.headers['authorization']).toBe('Bearer sk-master-abc');
    // budget fields intentionally absent — see ensureGatewayUser's doc comment.
    expect(JSON.parse(received.body)).toEqual({
      user_id: 'test-group',
      user_role: 'internal_user',
      auto_create_key: false,
    });
  });

  it('mints the key anyway when the user row already exists', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: { error: 'User with id test-group already exists' },
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: 'sk-virtual-task-key' }));
    };

    const key = await mintVirtualKey({
      taskId: 'task-1',
      channel: 'test-group',
    });

    expect(key).toBe('sk-virtual-task-key');
    expect(requests.map((r) => r.url)).toEqual(['/user/new', '/key/generate']);
  });

  it('mints the key anyway when the duplicate-user conflict surfaces as a non-409 status with the message in the body', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'User with id test-group already exists' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: 'sk-virtual-task-key' }));
    };

    const key = await mintVirtualKey({
      taskId: 'task-1',
      channel: 'test-group',
    });

    expect(key).toBe('sk-virtual-task-key');
    expect(requests.map((r) => r.url)).toEqual(['/user/new', '/key/generate']);
  });

  it('throws without minting when /user/new fails for any other reason, with the response body in the error', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: 'sk-virtual-task-key' }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'test-group' }),
    ).rejects.toThrow(/\/user\/new returned HTTP 500.*boom/);
    expect(requests.map((r) => r.url)).toEqual(['/user/new']);
  });

  it('does not swallow an "already exists" body on a status other than 400 or 409', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'unrelated failure mentioning already exists in passing',
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: 'sk-virtual-task-key' }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'test-group' }),
    ).rejects.toThrow(/\/user\/new returned HTTP 500/);
    expect(requests.map((r) => r.url)).toEqual(['/user/new']);
  });

  it('redacts a key-shaped substring from a gateway error body', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'rejected key sk-leaked-abc123 on replay' }),
      );
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'test-group' }),
    ).rejects.toThrow(/\[REDACTED\]/);
    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'test-group' }),
    ).rejects.not.toThrow(/sk-leaked-abc123/);
  });

  it('throws when LITELLM_MASTER_KEY is absent', async () => {
    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/LITELLM_MASTER_KEY/);
    expect(requests).toHaveLength(0);
  });

  it('throws when the gateway returns a non-200 status', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/403/);
  });

  it('throws when the response has no string key field', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url === '/user/new' ? {} : { not_a_key: true }));
    };

    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/key/);
  });

  it('rejects rather than crashing when the response stream fails mid-transfer', async () => {
    setMasterKey('sk-master-abc');
    respond = (res, url) => {
      if (url === '/user/new') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"key":');
      // Abruptly destroy the socket mid-body. Without an 'error' listener on
      // the client response stream this surfaces as an uncaught exception that
      // would take down the host; mintVirtualKey must reject instead.
      res.socket?.destroy();
    };

    // A mid-body socket destroy surfaces as either a request-level "socket hang
    // up" or a response-stream error depending on timing; both must reject with
    // a descriptive LiteLLM /key/generate error rather than crash the host.
    await expect(
      mintVirtualKey({ taskId: 'task-1', channel: 'chan' }),
    ).rejects.toThrow(/LiteLLM \/key\/generate .*failed for task task-1/);
  });
});

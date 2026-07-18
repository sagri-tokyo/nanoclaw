import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  awaitOrgActionResult,
  parseOrgActionResult,
} from './org-action-response.js';

describe('parseOrgActionResult', () => {
  it('parses each verdict kind', () => {
    expect(parseOrgActionResult('{"kind":"execute"}')).toEqual({
      kind: 'execute',
    });
    expect(parseOrgActionResult('{"kind":"hold","token":"abc"}')).toEqual({
      kind: 'hold',
      token: 'abc',
    });
    expect(
      parseOrgActionResult('{"kind":"refuse","reason":"classified_refuse"}'),
    ).toEqual({ kind: 'refuse', reason: 'classified_refuse' });
    expect(parseOrgActionResult('{"kind":"unknown"}')).toEqual({
      kind: 'unknown',
    });
  });

  it('throws on an unknown kind rather than treating it as success', () => {
    expect(() => parseOrgActionResult('{"kind":"ok"}')).toThrow(/unknown kind/);
  });

  it('throws on a hold missing its token and a refuse missing its reason', () => {
    expect(() => parseOrgActionResult('{"kind":"hold"}')).toThrow(/token/);
    expect(() => parseOrgActionResult('{"kind":"refuse"}')).toThrow(/reason/);
  });

  it('throws on a non-object payload', () => {
    expect(() => parseOrgActionResult('["kind"]')).toThrow(/not a JSON object/);
  });
});

describe('awaitOrgActionResult', () => {
  let dir: string;
  const requestId = 'req-1';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-action-resp-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the verdict once the host writes it and deletes the file', async () => {
    const file = path.join(dir, `${requestId}.json`);
    let ticks = 0;
    const result = await awaitOrgActionResult(dir, requestId, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      now: () => ticks,
      sleep: async () => {
        ticks += 1;
        if (ticks === 3) {
          fs.writeFileSync(
            file,
            JSON.stringify({ kind: 'refuse', reason: 'classified_refuse' }),
          );
        }
      },
    });
    expect(result).toEqual({ kind: 'refuse', reason: 'classified_refuse' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('throws on timeout so a lost verdict never reads as success', async () => {
    let ticks = 0;
    await expect(
      awaitOrgActionResult(dir, requestId, {
        pollIntervalMs: 0,
        timeoutMs: 5,
        now: () => ticks,
        sleep: async () => {
          ticks += 10;
        },
      }),
    ).rejects.toThrow(/no verdict/);
  });
});

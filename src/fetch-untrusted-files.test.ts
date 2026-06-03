import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type http from 'http';

import {
  fetchWithRedirects,
  resolveDeps,
  FetchUntrustedError,
} from './fetch-untrusted.js';

interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

// A ClientRequest-like stub whose factory records the request options (so we
// can assert which headers were sent on each redirect hop) and replays a
// scripted sequence of responses, one per hop.
function makeStub(responses: StubResponse[]) {
  const seen: Array<Record<string, string | undefined>> = [];
  const factory = (options: http.RequestOptions): http.ClientRequest => {
    const idx = seen.length;
    seen.push((options.headers ?? {}) as Record<string, string | undefined>);
    const req = new EventEmitter() as EventEmitter & {
      write: (c?: unknown) => void;
      end: () => void;
      destroy: (err: Error) => void;
    };
    req.write = () => {};
    req.destroy = (err: Error) => {
      process.nextTick(() => req.emit('error', err));
    };
    req.end = () => {
      const r = responses[Math.min(idx, responses.length - 1)];
      process.nextTick(() => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
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
    return req as unknown as http.ClientRequest;
  };
  return { factory, seen };
}

const lookupPublic = async () => ({ address: '8.8.8.8', family: 4 as const });

describe('fetchWithRedirects — file download additions', () => {
  it('returns both bodyBytes (Buffer) and the UTF-8 body string', async () => {
    const { factory } = makeStub([
      { status: 200, body: Buffer.from('héllo', 'utf-8') },
    ]);
    const deps = resolveDeps({
      lookup: lookupPublic,
      httpsRequestFactory: factory,
    });
    const resp = await fetchWithRedirects({
      url: 'https://files.slack.com/x',
      headers: {},
      deps,
    });
    expect(Buffer.isBuffer(resp.bodyBytes)).toBe(true);
    expect(resp.bodyBytes.toString('utf-8')).toBe('héllo');
    expect(resp.body).toBe('héllo');
  });

  it('enforces a custom maxBytes cap', async () => {
    const { factory } = makeStub([
      { status: 200, body: Buffer.alloc(1000, 0x61) },
    ]);
    const deps = resolveDeps({
      lookup: lookupPublic,
      httpsRequestFactory: factory,
    });
    await expect(
      fetchWithRedirects({
        url: 'https://files.slack.com/big',
        headers: {},
        deps,
        maxBytes: 100,
      }),
    ).rejects.toThrow(FetchUntrustedError);
  });

  it('strips Authorization on a cross-origin redirect (keeps other headers)', async () => {
    const { factory, seen } = makeStub([
      { status: 302, headers: { location: 'https://evil.example/file' } },
      { status: 200, body: 'ok' },
    ]);
    const deps = resolveDeps({
      lookup: lookupPublic,
      httpsRequestFactory: factory,
    });
    await fetchWithRedirects({
      url: 'https://files.slack.com/x',
      headers: { authorization: 'Bearer secret', 'user-agent': 'ua' },
      deps,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].authorization).toBe('Bearer secret');
    expect(seen[1].authorization).toBeUndefined();
    expect(seen[1]['user-agent']).toBe('ua');
  });

  it('preserves Authorization on a same-origin redirect', async () => {
    const { factory, seen } = makeStub([
      { status: 302, headers: { location: 'https://files.slack.com/other' } },
      { status: 200, body: 'ok' },
    ]);
    const deps = resolveDeps({
      lookup: lookupPublic,
      httpsRequestFactory: factory,
    });
    await fetchWithRedirects({
      url: 'https://files.slack.com/x',
      headers: { authorization: 'Bearer secret' },
      deps,
    });
    expect(seen[1].authorization).toBe('Bearer secret');
  });
});

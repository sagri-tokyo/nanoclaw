import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const out: Record<string, string> = {};
    for (const key of keys) {
      if (mockEnv[key] !== undefined) out[key] = mockEnv[key];
    }
    return out;
  }),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  fetchUntrusted,
  FetchUntrustedError,
  type FetchUntrustedDeps,
} from './fetch-untrusted.js';

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeServerHandle {
  port: number;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

async function startFakeServer(
  handler: (
    req: CapturedRequest,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<FakeServerHandle> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const captured_req: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      captured.push(captured_req);
      Promise.resolve(handler(captured_req, res)).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    captured,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

// Build a deps object that redirects HTTPS requests for a given hostname to a
// local plain-HTTP server. Used only for the "external accept" tests; SSRF
// rejection tests use the default deps and never touch the network.
//
// Lookup is keyed by hostname. The `httpsRequestFactory` is keyed by the
// resolved IP address that the production code now passes through as
// `options.hostname` (DNS-rebinding fix), so we map IPs back to ports here.
function buildLocalRedirectDeps(args: {
  redirects: Record<string, { port: number; resolveTo: string }>;
}): FetchUntrustedDeps {
  const ipToPort: Record<string, number> = {};
  for (const target of Object.values(args.redirects)) {
    ipToPort[target.resolveTo] = target.port;
  }
  return {
    lookup: async (hostname: string) => {
      const target = args.redirects[hostname];
      if (target) return { address: target.resolveTo, family: 4 };
      throw new Error(`unexpected lookup: ${hostname}`);
    },
    httpsRequestFactory: (options) => {
      const hostname =
        typeof options.hostname === 'string' ? options.hostname : '';
      // After the DNS-rebinding fix, `options.hostname` is the resolved IP.
      // Map IP -> port. As a transitional convenience also accept the
      // logical hostname (in case any callers still pass that).
      const port =
        ipToPort[hostname] ?? args.redirects[hostname]?.port ?? null;
      if (port === null) {
        throw new Error(`unexpected https request: ${hostname}`);
      }
      return http.request({
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      });
    },
  };
}

describe('fetch-untrusted', () => {
  let upstreamReader: http.Server;
  let upstreamReaderPort: number;
  let upstreamReaderRespond: () => { status: number; body: unknown };
  let lastReaderBody: string;

  beforeEach(async () => {
    lastReaderBody = '';
    upstreamReaderRespond = () => ({
      status: 200,
      body: {
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              intent: 'user is reading a benign external resource',
              extracted_data: { topic: 'test' },
              confidence: 0.9,
              risk_flags: [],
            }),
          },
        ],
      },
    });

    upstreamReader = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastReaderBody = Buffer.concat(chunks).toString('utf-8');
        const { status, body } = upstreamReaderRespond();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) =>
      upstreamReader.listen(0, '127.0.0.1', r),
    );
    upstreamReaderPort = (upstreamReader.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamReaderPort}`,
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => upstreamReader?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  // ---------- web_content ----------

  it('web_content rejects http scheme with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'http://example.com/page',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({
      code: 'bad_url',
    } as FetchUntrustedError);
  });

  it('web_content rejects file:// scheme with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'file:///etc/passwd',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('web_content rejects RFC1918 literal hostnames with bad_url', async () => {
    for (const host of ['10.0.0.1', '192.168.1.1', '172.16.0.1']) {
      await expect(
        fetchUntrusted({
          url_or_id: `https://${host}/page`,
          source_type: 'web_content',
        }),
      ).rejects.toMatchObject({ code: 'bad_url' });
    }
  });

  it('web_content rejects loopback literals (127.0.0.1, ::1) with bad_url', async () => {
    for (const host of ['127.0.0.1', '[::1]']) {
      await expect(
        fetchUntrusted({
          url_or_id: `https://${host}/page`,
          source_type: 'web_content',
        }),
      ).rejects.toMatchObject({ code: 'bad_url' });
    }
  });

  it('web_content rejects link-local AWS metadata IP with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://169.254.169.254/latest/meta-data',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('web_content rejects 0.0.0.0 with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://0.0.0.0/',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('web_content accepts an external-shaped HTTPS URL and laundered through reader', async () => {
    const target = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>hello world</body></html>');
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'research.example': { port: target.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrusted(
        {
          url_or_id: 'https://research.example/paper',
          source_type: 'web_content',
        },
        deps,
      );
      expect(result.source_provenance.source).toBe('web_content');
      expect(result.source_provenance.url).toBe(
        'https://research.example/paper',
      );
      expect(lastReaderBody).toContain('hello world');
    } finally {
      await target.close();
    }
  });

  it('web_content enforces 256 KiB body cap with fetch_failure', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const target = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(huge);
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'big.example': { port: target.port, resolveTo: '8.8.8.8' },
        },
      });
      await expect(
        fetchUntrusted(
          {
            url_or_id: 'https://big.example/huge',
            source_type: 'web_content',
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'fetch_failure' });
    } finally {
      await target.close();
    }
  });

  it('web_content enforces timeout with fetch_failure', async () => {
    // Use a factory that destroys the request immediately with a timeout-shaped
    // Error message. We don't actually wait for the production timeout to
    // fire (30s); we just confirm fetch_failure surfaces and the message is
    // forwarded through.
    const deps: FetchUntrustedDeps = {
      lookup: async (_hostname: string) => ({
        address: '8.8.8.8',
        family: 4,
      }),
      httpsRequestFactory: (_options) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: 1, // unreachable
          path: '/',
          method: 'GET',
        });
        // Force an immediate failure with a recognisable message.
        process.nextTick(() => {
          req.destroy(new Error('fetch timed out after 100ms'));
        });
        return req;
      },
    };
    await expect(
      fetchUntrusted(
        {
          url_or_id: 'https://slow.example/hang',
          source_type: 'web_content',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'fetch_failure',
      message: expect.stringContaining('fetch timed out'),
    });
  });

  it('web_content re-validates redirect target (RFC1918 redirect) with bad_url', async () => {
    const target = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: 'https://10.0.0.1/internal' });
      res.end();
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'redir.example': { port: target.port, resolveTo: '8.8.8.8' },
        },
      });
      await expect(
        fetchUntrusted(
          {
            url_or_id: 'https://redir.example/r',
            source_type: 'web_content',
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'bad_url' });
    } finally {
      await target.close();
    }
  });

  // ---------- github_issue ----------

  it('github_issue rejects URL that is not /issues/N with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://github.com/owner/repo/pull/1',
        source_type: 'github_issue',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('github_issue parses owner/repo/n and calls api.github.com with bearer auth', async () => {
    Object.assign(mockEnv, { GITHUB_TOKEN: 'ghs_sentinelvalueA' });
    const apiServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          number: 42,
          title: 'Bug in fetcher',
          body: 'reproducer steps',
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': {
            port: apiServer.port,
            resolveTo: '8.8.8.8',
          },
        },
      });
      const result = await fetchUntrusted(
        {
          url_or_id: 'https://github.com/foo/bar/issues/42',
          source_type: 'github_issue',
        },
        deps,
      );
      expect(apiServer.captured).toHaveLength(1);
      expect(apiServer.captured[0].path).toBe('/repos/foo/bar/issues/42');
      expect(apiServer.captured[0].headers.authorization).toBe(
        'Bearer ghs_sentinelvalueA',
      );
      expect(result.source_provenance.source).toBe('github_issue');
      expect(result.source_provenance.url).toBe(
        'https://github.com/foo/bar/issues/42',
      );
    } finally {
      await apiServer.close();
    }
  });

  it('github_issue missing GITHUB_TOKEN throws fetch_failure', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://github.com/foo/bar/issues/1',
        source_type: 'github_issue',
      }),
    ).rejects.toMatchObject({ code: 'fetch_failure' });
  });

  it('github_issue concatenates title + body for laundering', async () => {
    Object.assign(mockEnv, { GITHUB_TOKEN: 'ghs_x' });
    const apiServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          number: 7,
          title: 'TITLE_SENTINEL_X',
          body: 'BODY_SENTINEL_Y',
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': {
            port: apiServer.port,
            resolveTo: '8.8.8.8',
          },
        },
      });
      await fetchUntrusted(
        {
          url_or_id: 'https://github.com/foo/bar/issues/7',
          source_type: 'github_issue',
        },
        deps,
      );
      expect(lastReaderBody).toContain('TITLE_SENTINEL_X');
      expect(lastReaderBody).toContain('BODY_SENTINEL_Y');
    } finally {
      await apiServer.close();
    }
  });

  // ---------- github_comment ----------

  it('github_comment parses comment id and calls comments endpoint', async () => {
    Object.assign(mockEnv, { GITHUB_TOKEN: 'ghs_y' });
    const apiServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 99, body: 'comment text' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': {
            port: apiServer.port,
            resolveTo: '8.8.8.8',
          },
        },
      });
      const result = await fetchUntrusted(
        {
          url_or_id:
            'https://github.com/foo/bar/issues/3#issuecomment-99',
          source_type: 'github_comment',
        },
        deps,
      );
      expect(apiServer.captured).toHaveLength(1);
      expect(apiServer.captured[0].path).toBe(
        '/repos/foo/bar/issues/comments/99',
      );
      expect(apiServer.captured[0].headers.authorization).toBe('Bearer ghs_y');
      expect(result.source_provenance.source).toBe('github_comment');
    } finally {
      await apiServer.close();
    }
  });

  // ---------- notion_page ----------

  it('notion_page accepts both bare 32-hex id and Notion URL form', async () => {
    Object.assign(mockEnv, { NOTION_API_KEY: 'secret_xyz' });
    const apiServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          properties: { title: { title: [{ plain_text: 'demo' }] } },
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': {
            port: apiServer.port,
            resolveTo: '8.8.8.8',
          },
        },
      });
      const id = 'a'.repeat(32);
      const dashed = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

      const r1 = await fetchUntrusted(
        { url_or_id: id, source_type: 'notion_page' },
        deps,
      );
      expect(r1.source_provenance.source).toBe('notion_page');
      expect(r1.source_provenance.url).toBe(`https://www.notion.so/${id}`);

      const r2 = await fetchUntrusted(
        { url_or_id: dashed, source_type: 'notion_page' },
        deps,
      );
      expect(r2.source_provenance.url).toBe(`https://www.notion.so/${id}`);

      const r3 = await fetchUntrusted(
        {
          url_or_id: `https://www.notion.so/Page-Title-${id}`,
          source_type: 'notion_page',
        },
        deps,
      );
      expect(r3.source_provenance.url).toBe(
        `https://www.notion.so/Page-Title-${id}`,
      );

      // All three calls must have hit the API with the canonical id.
      for (const captured of apiServer.captured) {
        expect(captured.path).toBe(`/v1/pages/${id}`);
      }
      expect(apiServer.captured).toHaveLength(3);
    } finally {
      await apiServer.close();
    }
  });

  it('notion_page missing NOTION_API_KEY throws fetch_failure', async () => {
    const id = 'b'.repeat(32);
    await expect(
      fetchUntrusted({ url_or_id: id, source_type: 'notion_page' }),
    ).rejects.toMatchObject({ code: 'fetch_failure' });
  });

  it('notion_page sends Notion-Version header', async () => {
    Object.assign(mockEnv, { NOTION_API_KEY: 'secret_zzz' });
    const apiServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ properties: {} }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': {
            port: apiServer.port,
            resolveTo: '8.8.8.8',
          },
        },
      });
      const id = 'c'.repeat(32);
      await fetchUntrusted(
        { url_or_id: id, source_type: 'notion_page' },
        deps,
      );
      expect(apiServer.captured[0].headers['notion-version']).toBe(
        '2022-06-28',
      );
      expect(apiServer.captured[0].headers.authorization).toBe(
        'Bearer secret_zzz',
      );
    } finally {
      await apiServer.close();
    }
  });

  // ---------- top-level param validation ----------

  it('rejects an invalid source_type with invalid_params', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://example.com',
        source_type: 'not_a_real_source',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rejects missing url_or_id with invalid_params', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: undefined,
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rejects empty url_or_id with invalid_params', async () => {
    await expect(
      fetchUntrusted({ url_or_id: '', source_type: 'web_content' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  // ---------- IPv6 SSRF (compressed forms must be rejected) ----------

  it('web_content rejects ULA prefix [fdab:cd::1] (still fc00::/7)', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://[fdab:cd::1]/page',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('web_content rejects compressed link-local [fe80::1]', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://[fe80::1]/page',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('web_content does NOT classify documentation prefix [2001:db8::1] as private', async () => {
    // 2001:db8::/32 is the IETF documentation prefix, public-shaped from the
    // SSRF defence's perspective. Confirm it passes the validator (the
    // factory below will be invoked because validation didn't reject).
    let factoryInvoked = false;
    const deps: FetchUntrustedDeps = {
      lookup: async () => ({ address: '2001:db8::1', family: 6 }),
      httpsRequestFactory: () => {
        factoryInvoked = true;
        // Throw synchronously so we don't hang; the production code will
        // wrap this into a fetch_failure, which is expected and orthogonal
        // to the property under test.
        throw new Error('synthetic — factory was reached');
      },
    };
    await expect(
      fetchUntrusted(
        {
          url_or_id: 'https://[2001:db8::1]/x',
          source_type: 'web_content',
        },
        deps,
      ),
    ).rejects.toBeDefined();
    expect(factoryInvoked).toBe(true);
  });

  // ---------- CGNAT (RFC 6598) ----------

  it('web_content rejects CGNAT 100.64.0.0/10 literal with bad_url', async () => {
    await expect(
      fetchUntrusted({
        url_or_id: 'https://100.64.0.1/',
        source_type: 'web_content',
      }),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  // ---------- DNS rebinding (resolved IP threaded through to TCP connect) ----------

  it('web_content connects to the resolved IP, not the hostname (DNS rebinding defence)', async () => {
    const target = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    });
    try {
      let capturedHostname: string | undefined;
      let capturedServername: string | undefined;
      let capturedHostHeader: string | undefined;
      const deps: FetchUntrustedDeps = {
        lookup: async (hostname: string) => {
          if (hostname === 'rebind.example') {
            return { address: '203.0.113.7', family: 4 };
          }
          throw new Error(`unexpected lookup: ${hostname}`);
        },
        httpsRequestFactory: (options) => {
          capturedHostname =
            typeof options.hostname === 'string' ? options.hostname : undefined;
          capturedServername =
            typeof (options as { servername?: unknown }).servername === 'string'
              ? ((options as { servername?: string }).servername as string)
              : undefined;
          const headers = options.headers as
            | Record<string, string | string[] | undefined>
            | undefined;
          const hostHeader = headers?.host ?? headers?.Host;
          capturedHostHeader =
            typeof hostHeader === 'string' ? hostHeader : undefined;
          return http.request({
            hostname: '127.0.0.1',
            port: target.port,
            path: options.path,
            method: options.method,
            headers: options.headers,
          });
        },
      };
      await fetchUntrusted(
        {
          url_or_id: 'https://rebind.example/page',
          source_type: 'web_content',
        },
        deps,
      );
      expect(capturedHostname).toBe('203.0.113.7');
      expect(capturedServername).toBe('rebind.example');
      expect(capturedHostHeader).toBe('rebind.example');
    } finally {
      await target.close();
    }
  });

  it('redirect re-validation: second hop uses the second hostname\'s resolved IP', async () => {
    // First hop returns a 302 to a different host. Each hop must be resolved
    // independently and the connection must be made to that hop's IP.
    const firstHop = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: 'https://second.example/dest' });
      res.end();
    });
    const secondHop = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>final</html>');
    });
    try {
      const lookupCalls: string[] = [];
      const factoryHostnames: string[] = [];
      const deps: FetchUntrustedDeps = {
        lookup: async (hostname: string) => {
          lookupCalls.push(hostname);
          if (hostname === 'first.example') {
            return { address: '203.0.113.10', family: 4 };
          }
          if (hostname === 'second.example') {
            return { address: '203.0.113.20', family: 4 };
          }
          throw new Error(`unexpected lookup: ${hostname}`);
        },
        httpsRequestFactory: (options) => {
          const ip =
            typeof options.hostname === 'string' ? options.hostname : '';
          factoryHostnames.push(ip);
          if (ip === '203.0.113.10') {
            return http.request({
              hostname: '127.0.0.1',
              port: firstHop.port,
              path: options.path,
              method: options.method,
              headers: options.headers,
            });
          }
          if (ip === '203.0.113.20') {
            return http.request({
              hostname: '127.0.0.1',
              port: secondHop.port,
              path: options.path,
              method: options.method,
              headers: options.headers,
            });
          }
          throw new Error(`unexpected request to ${ip}`);
        },
      };
      await fetchUntrusted(
        {
          url_or_id: 'https://first.example/start',
          source_type: 'web_content',
        },
        deps,
      );
      expect(lookupCalls).toEqual(['first.example', 'second.example']);
      expect(factoryHostnames).toEqual(['203.0.113.10', '203.0.113.20']);
    } finally {
      await firstHop.close();
      await secondHop.close();
    }
  });

  // ---------- Item 12: forwarded fetch error message ----------

  it('forwards the underlying error message on fetch_failure', async () => {
    const deps: FetchUntrustedDeps = {
      lookup: async () => ({ address: '8.8.8.8', family: 4 }),
      httpsRequestFactory: () => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: 1,
          path: '/',
          method: 'GET',
        });
        process.nextTick(() => {
          req.destroy(new Error('socket got reset by upstream'));
        });
        return req;
      },
    };
    await expect(
      fetchUntrusted(
        {
          url_or_id: 'https://research.example/x',
          source_type: 'web_content',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'fetch_failure',
      message: expect.stringContaining('socket got reset by upstream'),
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { EventEmitter } from 'events';

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
  fetchUntrustedList,
  FetchUntrustedListResult,
} from './fetch-untrusted-list.js';
import {
  FetchUntrustedDeps,
  FetchUntrustedError,
  FetchUntrustedHttp4xx,
  FetchUntrustedHttp5xx,
  FetchUntrustedMalformed,
  FetchUntrustedSsrfReject,
  FetchUntrustedTimeout,
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
      const port = ipToPort[hostname] ?? args.redirects[hostname]?.port ?? null;
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

async function expectMalformedSearch(
  results: unknown[],
  expectedMessage: string,
): Promise<void> {
  const notion = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results, has_more: false }));
  });
  try {
    const deps = buildLocalRedirectDeps({
      redirects: {
        'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
      },
    });
    let caught: unknown;
    try {
      await fetchUntrustedList(
        {
          source_type: 'notion_search',
          params: { query: 'x', object_kind: 'page', limit: 10 },
        },
        deps,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FetchUntrustedMalformed);
    // Pin the exact static message: a malformed-row throw must never
    // interpolate untrusted response bytes (result.object etc.) into it.
    expect((caught as FetchUntrustedMalformed).message).toBe(expectedMessage);
  } finally {
    await notion.close();
  }
}

const READER_RESPONSE = {
  model: 'claude-haiku-4-5',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
      }),
    },
  ],
};

describe('fetch-untrusted-list', () => {
  let upstreamReader: http.Server;
  let upstreamReaderPort: number;
  let readerCallBodies: string[];

  beforeEach(async () => {
    readerCallBodies = [];
    upstreamReader = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        readerCallBodies.push(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(READER_RESPONSE));
      });
    });
    await new Promise<void>((r) => upstreamReader.listen(0, '127.0.0.1', r));
    upstreamReaderPort = (upstreamReader.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamReaderPort}`,
      GITHUB_TOKEN: 'ghp_test',
      NOTION_API_KEY: 'secret_test',
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => upstreamReader?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  // ---------- top-level validation ----------

  it('rejects unknown source_type with invalid_params', async () => {
    await expect(
      fetchUntrustedList({ source_type: 'rss_feed', params: {} }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
    } as FetchUntrustedError);
  });

  it('rejects missing params with invalid_params', async () => {
    await expect(
      fetchUntrustedList({ source_type: 'arxiv_search' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rejects unknown top-level keys with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'arxiv_search',
        params: { query: 'x', limit: 1 },
        rogue: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  // ---------- arxiv_search ----------

  it('arxiv_search parses Atom feed and launders title+summary per entry', async () => {
    const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Paper One</title>
    <summary>An interesting abstract.</summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <updated>2024-01-04T00:00:00Z</updated>
    <published>2024-01-03T00:00:00Z</published>
    <title>Paper Two</title>
    <summary>Another abstract.</summary>
    <author><name>Carol</name></author>
  </entry>
</feed>`;
    const arxiv = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(arxivXml);
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'export.arxiv.org': { port: arxiv.port, resolveTo: '8.8.8.8' },
        },
      });
      const result: FetchUntrustedListResult = await fetchUntrustedList(
        {
          source_type: 'arxiv_search',
          params: { query: 'graph neural networks', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 'http://arxiv.org/abs/2401.00001v1',
        url: 'http://arxiv.org/abs/2401.00001v1',
        published: '2024-01-01T00:00:00Z',
        updated: '2024-01-02T00:00:00Z',
        authors: ['Alice', 'Bob'],
      });
      expect(result.items[1]).toMatchObject({
        id: 'http://arxiv.org/abs/2401.00002v1',
        authors: ['Carol'],
      });
      expect(arxiv.captured[0].path).toContain(
        'search_query=graph%20neural%20networks',
      );
      expect(arxiv.captured[0].path).toContain('max_results=5');
      expect(readerCallBodies).toHaveLength(2);
      expect(readerCallBodies[0]).toContain('Paper One');
      expect(readerCallBodies[0]).toContain('An interesting abstract.');
    } finally {
      await arxiv.close();
    }
  });

  it('arxiv_search rejects limit over cap with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'arxiv_search',
        params: { query: 'x', limit: 999 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  // ---------- github_search ----------

  it('github_search returns laundered repos with constrained fields raw', async () => {
    const search = await startFakeServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer ghp_test');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              full_name: 'octo/cat',
              html_url: 'https://github.com/octo/cat',
              stargazers_count: 100,
              language: 'TypeScript',
              updated_at: '2024-01-01T00:00:00Z',
              description: 'A test repo',
            },
            {
              id: 2,
              full_name: 'octo/dog',
              html_url: 'https://github.com/octo/dog',
              stargazers_count: 50,
              language: null,
              updated_at: '2024-02-01T00:00:00Z',
              description: '',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: search.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_search',
          params: { query: 'reader pipeline', limit: 5 },
        },
        deps,
      );
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 1,
        full_name: 'octo/cat',
        url: 'https://github.com/octo/cat',
        stars: 100,
        language: 'TypeScript',
      });
      expect(result.items[1]).toMatchObject({
        id: 2,
        language: null,
      });
      expect(search.captured[0].path).toContain('q=reader%20pipeline');
      expect(search.captured[0].path).toContain('per_page=5');
    } finally {
      await search.close();
    }
  });

  it('github_search throws fetch_failure when GITHUB_TOKEN missing', async () => {
    delete mockEnv.GITHUB_TOKEN;
    await expect(
      fetchUntrustedList({
        source_type: 'github_search',
        params: { query: 'x', limit: 1 },
      }),
    ).rejects.toMatchObject({ code: 'fetch_failure' });
  });

  // ---------- github_pr_list ----------

  it('github_pr_list returns laundered PRs and applies since filter', async () => {
    const ghApi = await startFakeServer((req, res) => {
      expect(req.path).toContain('state=open');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 10,
            html_url: 'https://github.com/o/r/pull/10',
            state: 'open',
            draft: false,
            created_at: '2024-03-01T00:00:00Z',
            updated_at: '2024-03-05T00:00:00Z',
            user: { login: 'alice' },
            title: 'New feature',
          },
          {
            number: 9,
            html_url: 'https://github.com/o/r/pull/9',
            state: 'open',
            draft: true,
            created_at: '2024-02-01T00:00:00Z',
            updated_at: '2024-02-01T00:00:00Z',
            user: { login: 'bob' },
            title: 'Old WIP',
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: {
            owner: 'o',
            repo: 'r',
            state: 'open',
            since: '2024-03-01T00:00:00Z',
            limit: 50,
          },
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        number: 10,
        author: 'alice',
        draft: false,
      });
    } finally {
      await ghApi.close();
    }
  });

  // ---------- github list pagination (sagri-ai#472) ----------
  //
  // A pulls item is ~20KB, so per_page=100 returned ~2MB and tripped
  // fetchWithRedirects' 256KB MAX_BODY_BYTES guard: github_pr_list failed for
  // any limit above ~14 and GITHUB_LIST_LIMIT_MAX=100 was unreachable. These
  // pin the paging that fixes it. The per_page assertion is the load-bearing
  // one — the bug was per_page tracking limit.

  function prRow(number: number, updatedAt: string): Record<string, unknown> {
    return {
      number,
      html_url: `https://github.com/o/r/pull/${number}`,
      state: 'open',
      draft: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: updatedAt,
      user: { login: 'alice' },
      title: `PR ${number}`,
    };
  }

  function issueRow(
    number: number,
    updatedAt: string,
    isPr = false,
  ): Record<string, unknown> {
    const row: Record<string, unknown> = {
      number,
      html_url: `https://github.com/o/r/issues/${number}`,
      state: 'open',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: updatedAt,
      user: { login: 'alice' },
      labels: [],
      title: `issue ${number}`,
    };
    if (isPr) row.pull_request = { url: 'x' };
    return row;
  }

  function pageOf(path: string): number {
    return Number(new URL(path, 'http://x').searchParams.get('page'));
  }

  // Exact, not toContain: 'per_page=100'.includes('per_page=10') is true, so a
  // substring check passes on the very value this guards against.
  function perPageOf(path: string): string | null {
    return new URL(path, 'http://x').searchParams.get('per_page');
  }

  it('github_pr_list never requests more than one page size, whatever the limit', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      const rows =
        page === 1
          ? Array.from({ length: 10 }, (_, i) =>
              prRow(100 - i, '2024-03-05T00:00:00Z'),
            )
          : page === 2
            ? Array.from({ length: 5 }, (_, i) =>
                prRow(90 - i, '2024-03-04T00:00:00Z'),
              )
            : [];
      res.end(JSON.stringify(rows));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', state: 'open', limit: 50 },
        },
        deps,
      );
      // 10 from page 1 + 5 from page 2; the short page ends it, so no page 3.
      expect(result.items).toHaveLength(15);
      expect(ghApi.captured.map((r) => pageOf(r.path))).toEqual([1, 2]);
      // Asserted out here, not in the handler — startFakeServer catches a
      // throwing handler and turns it into a 500, which would swallow this.
      expect(ghApi.captured.map((r) => perPageOf(r.path))).toEqual([
        '10',
        '10',
      ]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_pr_list stops at the caller limit mid-page', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      // Distinct rows per page, as GitHub serves them.
      res.end(
        JSON.stringify(
          Array.from({ length: 10 }, (_, i) =>
            prRow(100 - (page - 1) * 10 - i, '2024-03-05T00:00:00Z'),
          ),
        ),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', state: 'open', limit: 12 },
        },
        deps,
      );
      expect(result.items).toHaveLength(12);
      // Two pages cover 12; a third would be wasted.
      expect(ghApi.captured).toHaveLength(2);
    } finally {
      await ghApi.close();
    }
  });

  it('github_pr_list keeps paging when a full page carries an unusable row', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      // A full page of 10 whose 5th entry is null. The page is full, so more
      // rows exist; if the walk ends here because only 9 survived the filter,
      // the caller gets a short list that reads like the repo running out.
      const rows: unknown[] =
        page === 1
          ? Array.from({ length: 10 }, (_, i) =>
              i === 4 ? null : prRow(100 - i, '2024-03-05T00:00:00Z'),
            )
          : [prRow(80, '2024-03-05T00:00:00Z')];
      res.end(JSON.stringify(rows));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', state: 'open', limit: 50 },
        },
        deps,
      );
      // 9 usable from page 1, plus page 2's single row.
      expect(result.items).toHaveLength(10);
      expect(ghApi.captured.map((r) => pageOf(r.path))).toEqual([1, 2]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_pr_list stops paging once a page crosses the since cutoff', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      // Page 2 opens with a row older than `since`. Sorted updated-desc, so
      // everything past it is older: page 3 must never be requested.
      const rows =
        page === 1
          ? Array.from({ length: 10 }, (_, i) =>
              prRow(100 - i, '2024-03-05T00:00:00Z'),
            )
          : Array.from({ length: 10 }, (_, i) =>
              prRow(90 - i, '2024-01-01T00:00:00Z'),
            );
      res.end(JSON.stringify(rows));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: {
            owner: 'o',
            repo: 'r',
            state: 'open',
            since: '2024-03-01T00:00:00Z',
            limit: 100,
          },
        },
        deps,
      );
      expect(result.items).toHaveLength(10);
      expect(ghApi.captured.map((r) => pageOf(r.path))).toEqual([1, 2]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_issue_list pages past PR rows without spending the caller limit', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      // /issues returns PRs too. Pre-paging, the adapter sliced to `limit`
      // before dropping them, so a page of PRs ate the whole budget and the
      // caller got nothing.
      const rows =
        page === 1
          ? Array.from({ length: 10 }, (_, i) =>
              issueRow(100 - i, '2024-03-05T00:00:00Z', true),
            )
          : [
              issueRow(50, '2024-03-05T00:00:00Z'),
              issueRow(49, '2024-03-05T00:00:00Z'),
              issueRow(48, '2024-03-05T00:00:00Z'),
            ];
      res.end(JSON.stringify(rows));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_issue_list',
          params: { owner: 'o', repo: 'r', state: 'open', limit: 3 },
        },
        deps,
      );
      expect(result.items.map((i) => (i as { number: number }).number)).toEqual(
        [50, 49, 48],
      );
      expect(ghApi.captured.map((r) => pageOf(r.path))).toEqual([1, 2]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_issue_list throws rather than return a short list when it hits the page ceiling', async () => {
    const ghApi = await startFakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Every row is a PR, so the issue filter rejects all of them and the
      // limit is never reached; the ceiling has to stop it.
      res.end(
        JSON.stringify(
          Array.from({ length: 10 }, (_, i) =>
            issueRow(1000 - i, '2024-03-05T00:00:00Z', true),
          ),
        ),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      await expect(
        fetchUntrustedList(
          {
            source_type: 'github_issue_list',
            params: { owner: 'o', repo: 'r', state: 'open', limit: 5 },
          },
          deps,
        ),
      ).rejects.toThrow(/page ceiling/);
      // limit 5 works out under the 3-page floor, so it gets 3.
      expect(ghApi.captured).toHaveLength(3);
    } finally {
      await ghApi.close();
    }
  });

  it('github_pr_list drops a row that repeats across pages', async () => {
    const ghApi = await startFakeServer((req, res) => {
      const page = pageOf(req.path);
      res.writeHead(200, { 'content-type': 'application/json' });
      // PR 91 was updated between the two fetches, so it moved up onto page 1
      // and page 2 re-serves it. One request could not produce this; thirty
      // sequential ones against a live repo can.
      const rows =
        page === 1
          ? Array.from({ length: 10 }, (_, i) =>
              prRow(100 - i, '2024-03-05T00:00:00Z'),
            )
          : [
              prRow(91, '2024-03-05T00:00:00Z'),
              prRow(90, '2024-03-04T00:00:00Z'),
            ];
      res.end(JSON.stringify(rows));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', state: 'open', limit: 50 },
        },
        deps,
      );
      const numbers = result.items.map((i) => (i as { number: number }).number);
      expect(numbers).toEqual([...new Set(numbers)]);
      expect(numbers.filter((n) => n === 91)).toHaveLength(1);
    } finally {
      await ghApi.close();
    }
  });

  it('github_pr_list throws rather than return a short list when pages stop making progress', async () => {
    const ghApi = await startFakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Every page serves the same 10 rows, so dedup rejects everything after
      // page 1 and the limit is never reached.
      res.end(
        JSON.stringify(
          Array.from({ length: 10 }, (_, i) =>
            prRow(100 - i, '2024-03-05T00:00:00Z'),
          ),
        ),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      await expect(
        fetchUntrustedList(
          {
            source_type: 'github_pr_list',
            params: { owner: 'o', repo: 'r', state: 'open', limit: 50 },
          },
          deps,
        ),
      ).rejects.toThrow(/page ceiling/);
      // limit 50 * overscan 3 / page size 10.
      expect(ghApi.captured).toHaveLength(15);
    } finally {
      await ghApi.close();
    }
  });

  // Every leg taking `since` takes the same guard; see ISO_8601_UTC for why.
  // The two rejected spellings are the ones that fail silently rather than
  // loudly: 'yesterday' sorts above every ISO timestamp, '.000Z' just below
  // the same instant.
  it.each([
    ['github_pr_list', 'yesterday'],
    ['github_issue_list', 'yesterday'],
    ['github_run_list', 'yesterday'],
    ['github_pr_list', '2024-03-01T00:00:00.000Z'],
    ['github_run_list', '2024-03-01T00:00:00.000Z'],
  ])('%s rejects a since of %s', async (sourceType, since) => {
    const deps = buildLocalRedirectDeps({ redirects: {} });
    await expect(
      fetchUntrustedList(
        {
          source_type: sourceType as 'github_pr_list',
          params: { owner: 'o', repo: 'r', since, limit: 10 },
        },
        deps,
      ),
    ).rejects.toThrow(/since must be an ISO-8601 UTC timestamp/);
  });

  // ---------- github_issue_list ----------

  it('github_issue_list filters out PRs (which have pull_request key) and surfaces labels', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 50,
            html_url: 'https://github.com/o/r/issues/50',
            state: 'open',
            created_at: '2024-04-01T00:00:00Z',
            updated_at: '2024-04-02T00:00:00Z',
            user: { login: 'alice' },
            title: 'Real issue',
            labels: [{ name: 'bug' }, { name: 'p1' }],
          },
          {
            number: 51,
            html_url: 'https://github.com/o/r/pull/51',
            pull_request: { url: 'whatever' },
            state: 'open',
            user: { login: 'bot' },
            title: 'PR masquerading as issue',
            labels: [],
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_issue_list',
          params: { owner: 'o', repo: 'r', limit: 20 },
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        number: 50,
        labels: ['bug', 'p1'],
      });
    } finally {
      await ghApi.close();
    }
  });

  // ---------- github_run_list ----------

  it('github_run_list parses workflow_runs envelope and forwards status filter', async () => {
    const ghApi = await startFakeServer((req, res) => {
      expect(req.path).toContain('status=completed');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 999,
              html_url: 'https://github.com/o/r/actions/runs/999',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc123',
              workflow_id: 42,
              created_at: '2024-05-01T00:00:00Z',
              name: 'CI',
              display_title: 'feat: thing',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_run_list',
          params: {
            owner: 'o',
            repo: 'r',
            status: 'completed',
            limit: 10,
          },
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 999,
        status: 'completed',
        conclusion: 'success',
        workflow_id: 42,
        head_sha: 'abc123',
      });
    } finally {
      await ghApi.close();
    }
  });

  // ---------- notion_database_query ----------

  it('notion_database_query POSTs filter+page_size and never invokes the reader', async () => {
    const notion = await startFakeServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.headers['notion-version']).toBe('2022-06-28');
      expect(req.headers.authorization).toBe('Bearer secret_test');
      const body = JSON.parse(req.body);
      expect(body.page_size).toBe(10);
      expect(body.filter).toEqual({
        property: 'Status',
        select: { equals: 'Ready for AI' },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'page-id-1',
              url: 'https://www.notion.so/page-id-1',
              created_time: '2024-06-01T00:00:00Z',
              last_edited_time: '2024-06-02T00:00:00Z',
              archived: false,
              properties: { Name: { title: [{ plain_text: 'Brief one' }] } },
            },
          ],
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_database_query',
          params: {
            database_id: 'abc',
            filter: {
              property: 'Status',
              select: { equals: 'Ready for AI' },
            },
            limit: 10,
          },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 'page-id-1',
          url: 'https://www.notion.so/page-id-1',
          created_time: '2024-06-01T00:00:00Z',
          last_edited_time: '2024-06-02T00:00:00Z',
          archived: false,
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await notion.close();
    }
  });

  // Regression: laundering the full properties blob broke the reader's
  // scalars-only/200-char output contract on rich rows and 502'd the query.
  it('notion_database_query rejects include_reader with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'notion_database_query',
        params: { database_id: 'abc', limit: 10 },
        include_reader: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_database_query rejects non-object filter with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'notion_database_query',
        params: { database_id: 'abc', filter: 'not-an-object', limit: 5 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_database_query throws fetch_failure with httpStatus on non-2xx', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unauthorized' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      await expect(
        fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'fetch_failure', httpStatus: 401 });
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query throws fetch_failure without httpStatus when 2xx body is unparseable', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json-at-all');
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedError);
      expect(caught).toMatchObject({ code: 'fetch_failure' });
      expect((caught as FetchUntrustedError).httpStatus).toBeUndefined();
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query rejects RFC1918 hostname with bad_url', async () => {
    // Fake the resolver to return an RFC1918 address; the SSRF guard should catch it.
    const deps: FetchUntrustedDeps = {
      lookup: async (_hostname: string) => ({ address: '10.0.0.1', family: 4 }),
      httpsRequestFactory: () => {
        throw new Error('should not be called');
      },
    };
    await expect(
      fetchUntrustedList(
        {
          source_type: 'notion_database_query',
          params: { database_id: 'abc', limit: 5 },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'bad_url' });
  });

  // ---------- notion_search ----------

  it('notion_search POSTs query+page_size+filter and launders each page title', async () => {
    const notion = await startFakeServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/v1/search');
      expect(req.headers['notion-version']).toBe('2022-06-28');
      expect(req.headers.authorization).toBe('Bearer secret_test');
      const body = JSON.parse(req.body);
      expect(body.query).toBe('soil brief');
      expect(body.page_size).toBe(5);
      expect(body.filter).toEqual({ property: 'object', value: 'page' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              object: 'page',
              id: 'page-id-1',
              url: 'https://www.notion.so/page-id-1',
              properties: {
                Status: { type: 'select', select: { name: 'Done' } },
                Name: {
                  type: 'title',
                  title: [{ plain_text: 'Soil Brief One' }],
                },
              },
            },
          ],
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_search',
          params: { query: 'soil brief', object_kind: 'page', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'page-id-1',
        url: 'https://www.notion.so/page-id-1',
        object: 'page',
      });
      expect((result.items[0] as { reader?: unknown }).reader).toBeDefined();
      expect(readerCallBodies).toHaveLength(1);
      expect(readerCallBodies[0]).toContain('Soil Brief One');
      // The title-only launder must NOT include other page properties (the
      // 'Done' select). If this regresses to laundering full `properties`, the
      // injection surface widens; assert the narrowing holds.
      expect(readerCallBodies[0]).not.toContain('Done');
    } finally {
      await notion.close();
    }
  });

  it('notion_search returns every match up to limit in order with page_size=limit', async () => {
    // A downstream skill treats items.length as an exact match count:
    // length 1 == unique match, length == limit == "too many, refine". That
    // only holds if the adapter never truncates below limit and asks Notion
    // for exactly limit rows, so pin both here. The throw-not-drop invariant
    // that keeps the count exact lives in notionSearch and is exercised by the
    // FetchUntrustedMalformed tests below.
    const notion = await startFakeServer((req, res) => {
      const body = JSON.parse(req.body);
      expect(body.page_size).toBe(10);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [1, 2, 3].map((n) => ({
            object: 'page',
            id: `page-id-${n}`,
            url: `https://www.notion.so/page-id-${n}`,
            properties: {
              Name: { type: 'title', title: [{ plain_text: `Page ${n}` }] },
            },
          })),
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_search',
          params: { query: 'page', object_kind: 'page', limit: 10 },
        },
        deps,
      );
      expect(result.items.map((item) => (item as { id: string }).id)).toEqual([
        'page-id-1',
        'page-id-2',
        'page-id-3',
      ]);
    } finally {
      await notion.close();
    }
  });

  it('notion_search throws FetchUntrustedMalformed on a non-object result row', async () => {
    await expectMalformedSearch(
      ['not-an-object'],
      'notion search result was not an object',
    );
  });

  it('notion_search throws FetchUntrustedMalformed on a result whose object kind does not match', async () => {
    // Notion's object filter guarantees only the requested kind returns, so a
    // mismatch is a contract violation.
    await expectMalformedSearch(
      [
        {
          object: 'page',
          id: 'page-id-1',
          url: 'https://www.notion.so/page-id-1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Keep me' }] },
          },
        },
        {
          object: 'database',
          id: 'db-id-1',
          url: 'https://www.notion.so/db-id-1',
          title: [{ plain_text: 'Wrong kind' }],
        },
      ],
      'notion search result object kind did not match the request',
    );
  });

  it('notion_search throws FetchUntrustedMalformed on a result missing url (id present)', async () => {
    await expectMalformedSearch(
      [{ object: 'page', id: 'page-id-1' }],
      'notion search result missing id or url',
    );
  });

  it('notion_search throws FetchUntrustedMalformed on a result missing id (url present)', async () => {
    // Covers the id === null operand; the missing-url case above covers the
    // resultUrl === null operand of the same guard.
    await expectMalformedSearch(
      [{ object: 'page', url: 'https://www.notion.so/page-id-1' }],
      'notion search result missing id or url',
    );
  });

  it('notion_search surfaces a 404 from /v1/search as FetchUntrustedHttp4xx', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_search',
            params: { query: 'x', object_kind: 'page', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedHttp4xx);
      expect(caught).toMatchObject({ code: 'fetch_failure', httpStatus: 404 });
    } finally {
      await notion.close();
    }
  });

  it('notion_search reads a database title from the top-level title array', async () => {
    const notion = await startFakeServer((req, res) => {
      const body = JSON.parse(req.body);
      expect(body.filter).toEqual({ property: 'object', value: 'database' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              object: 'database',
              id: 'db-id-1',
              url: 'https://www.notion.so/db-id-1',
              title: [{ plain_text: 'Sagri AI ' }, { plain_text: 'Tasks' }],
            },
          ],
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_search',
          params: { query: 'sagri', object_kind: 'database', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'db-id-1',
        url: 'https://www.notion.so/db-id-1',
        object: 'database',
      });
      expect(readerCallBodies).toHaveLength(1);
      expect(readerCallBodies[0]).toContain('Sagri AI Tasks');
    } finally {
      await notion.close();
    }
  });

  it('notion_search rejects a missing object_kind with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'notion_search',
        params: { query: 'x', limit: 5 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_search rejects an object_kind other than page/database with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'notion_search',
        params: { query: 'x', object_kind: 'block', limit: 5 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_search rejects an unknown param with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'notion_search',
        params: { query: 'x', object_kind: 'page', limit: 5, extra: 1 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_search throws fetch_failure when NOTION_API_KEY missing', async () => {
    delete mockEnv.NOTION_API_KEY;
    await expect(
      fetchUntrustedList({
        source_type: 'notion_search',
        params: { query: 'x', object_kind: 'page', limit: 5 },
      }),
    ).rejects.toMatchObject({ code: 'fetch_failure' });
  });

  it('notion_search omits items[].reader by default and skips the reader RPC', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              object: 'page',
              id: 'page-id-1',
              url: 'https://www.notion.so/page-id-1',
              properties: {
                Name: {
                  type: 'title',
                  title: [{ plain_text: 'Embedded INJECTION here' }],
                },
              },
            },
          ],
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_search',
          params: { query: 'x', object_kind: 'page', limit: 5 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 'page-id-1',
          url: 'https://www.notion.so/page-id-1',
          object: 'page',
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await notion.close();
    }
  });

  // ---------- error subclasses (sagri-tokyo/sagri-ai#255) ----------

  it('notion_database_query throws FetchUntrustedHttp4xx on a 404 status', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedHttp4xx);
      expect(caught).toBeInstanceOf(FetchUntrustedError);
      expect((caught as Error).constructor.name).toBe('FetchUntrustedHttp4xx');
      expect(caught).toMatchObject({ code: 'fetch_failure', httpStatus: 404 });
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query throws FetchUntrustedHttp5xx on a 500 status', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'internal' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedHttp5xx);
      expect(caught).toBeInstanceOf(FetchUntrustedError);
      expect((caught as Error).constructor.name).toBe('FetchUntrustedHttp5xx');
      expect(caught).toMatchObject({ code: 'fetch_failure', httpStatus: 500 });
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query throws FetchUntrustedSsrfReject on an RFC1918 hostname', async () => {
    const deps: FetchUntrustedDeps = {
      lookup: async (_hostname: string) => ({ address: '10.0.0.1', family: 4 }),
      httpsRequestFactory: () => {
        throw new Error('should not be called');
      },
    };
    let caught: unknown;
    try {
      await fetchUntrustedList(
        {
          source_type: 'notion_database_query',
          params: { database_id: 'abc', limit: 5 },
        },
        deps,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FetchUntrustedSsrfReject);
    expect(caught).toBeInstanceOf(FetchUntrustedError);
    expect((caught as Error).constructor.name).toBe('FetchUntrustedSsrfReject');
    expect(caught).toMatchObject({ code: 'bad_url' });
  });

  it('notion_database_query throws FetchUntrustedMalformed when the 2xx body is not json', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json-at-all');
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedMalformed);
      expect(caught).toBeInstanceOf(FetchUntrustedError);
      expect((caught as Error).constructor.name).toBe(
        'FetchUntrustedMalformed',
      );
      expect(caught).toMatchObject({ code: 'fetch_failure' });
      expect((caught as FetchUntrustedError).httpStatus).toBeUndefined();
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query throws FetchUntrustedMalformed when results is not an array', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: 'not-an-array' }));
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      let caught: unknown;
      try {
        await fetchUntrustedList(
          {
            source_type: 'notion_database_query',
            params: { database_id: 'abc', limit: 5 },
          },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchUntrustedMalformed);
      expect((caught as Error).constructor.name).toBe(
        'FetchUntrustedMalformed',
      );
    } finally {
      await notion.close();
    }
  });

  it('notion_database_query throws FetchUntrustedTimeout when the upstream never responds', async () => {
    // Stub httpsRequestFactory returns a ClientRequest-like EventEmitter
    // that never emits 'response'. The POST_TIMEOUT_MS timer fires, which
    // calls req.destroy(err), which triggers the 'error' listener with the
    // FetchUntrustedTimeout instance.
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter() as EventEmitter & {
        write?: (chunk: string) => void;
        end?: () => void;
        destroy?: (err: Error) => void;
      };
      emitter.write = () => {};
      emitter.end = () => {};
      emitter.destroy = (err: Error) => {
        // Match real ClientRequest semantics: emit 'error' on destroy(err).
        process.nextTick(() => emitter.emit('error', err));
      };
      const stubRequest = emitter as unknown as http.ClientRequest;

      const deps: FetchUntrustedDeps = {
        lookup: async (_hostname: string) => ({
          address: '8.8.8.8',
          family: 4,
        }),
        httpsRequestFactory: () => stubRequest,
      };

      const pending = fetchUntrustedList(
        {
          source_type: 'notion_database_query',
          params: { database_id: 'abc', limit: 5 },
        },
        deps,
      );
      const caughtPromise = pending.catch((e: unknown) => e);
      // Advance past the 30s POST_TIMEOUT_MS plus a tick for nextTick.
      await vi.advanceTimersByTimeAsync(31_000);
      const caught = await caughtPromise;
      expect(caught).toBeInstanceOf(FetchUntrustedTimeout);
      expect(caught).toBeInstanceOf(FetchUntrustedError);
      expect((caught as Error).constructor.name).toBe('FetchUntrustedTimeout');
      expect(caught).toMatchObject({ code: 'fetch_failure' });
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- include_reader default-omit (sagri-ai#119) ----------

  it('rejects include_reader as non-boolean with invalid_params', async () => {
    await expect(
      fetchUntrustedList({
        source_type: 'arxiv_search',
        params: { query: 'x', limit: 1 },
        include_reader: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('notion_database_query omits items[].reader by default and skips reader RPC', async () => {
    const notion = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'page-id-1',
              url: 'https://www.notion.so/page-id-1',
              created_time: '2024-06-01T00:00:00Z',
              last_edited_time: '2024-06-02T00:00:00Z',
              archived: false,
              properties: {
                Name: { title: [{ plain_text: 'Embedded INJECTION here' }] },
              },
            },
          ],
          has_more: false,
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.notion.com': { port: notion.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'notion_database_query',
          params: { database_id: 'abc', limit: 10 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 'page-id-1',
          url: 'https://www.notion.so/page-id-1',
          created_time: '2024-06-01T00:00:00Z',
          last_edited_time: '2024-06-02T00:00:00Z',
          archived: false,
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await notion.close();
    }
  });

  it('arxiv_search omits items[].reader by default and skips reader RPC', async () => {
    const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Paper One</title>
    <summary>An interesting abstract.</summary>
    <author><name>Alice</name></author>
  </entry>
</feed>`;
    const arxiv = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(arxivXml);
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'export.arxiv.org': { port: arxiv.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'arxiv_search',
          params: { query: 'x', limit: 1 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 'http://arxiv.org/abs/2401.00001v1',
          url: 'http://arxiv.org/abs/2401.00001v1',
          published: '2024-01-01T00:00:00Z',
          updated: '2024-01-02T00:00:00Z',
          authors: ['Alice'],
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await arxiv.close();
    }
  });

  it('github_search omits items[].reader by default and skips reader RPC', async () => {
    const search = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              full_name: 'octo/cat',
              html_url: 'https://github.com/octo/cat',
              stargazers_count: 100,
              language: 'TypeScript',
              updated_at: '2024-01-01T00:00:00Z',
              description: 'A test repo with INJECT payload',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: search.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_search',
          params: { query: 'x', limit: 1 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 1,
          full_name: 'octo/cat',
          url: 'https://github.com/octo/cat',
          stars: 100,
          language: 'TypeScript',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await search.close();
    }
  });

  it('github_pr_list omits items[].reader by default and skips reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 10,
            html_url: 'https://github.com/o/r/pull/10',
            state: 'open',
            draft: false,
            created_at: '2024-03-01T00:00:00Z',
            updated_at: '2024-03-05T00:00:00Z',
            user: { login: 'alice' },
            title: 'New feature with INJECT payload',
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          number: 10,
          url: 'https://github.com/o/r/pull/10',
          state: 'open',
          author: 'alice',
          draft: false,
          created_at: '2024-03-01T00:00:00Z',
          updated_at: '2024-03-05T00:00:00Z',
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_issue_list omits items[].reader by default and skips reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 50,
            html_url: 'https://github.com/o/r/issues/50',
            state: 'open',
            created_at: '2024-04-01T00:00:00Z',
            updated_at: '2024-04-02T00:00:00Z',
            user: { login: 'alice' },
            title: 'Real issue with INJECT payload',
            labels: [{ name: 'bug' }],
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_issue_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          number: 50,
          url: 'https://github.com/o/r/issues/50',
          state: 'open',
          author: 'alice',
          labels: ['bug'],
          created_at: '2024-04-01T00:00:00Z',
          updated_at: '2024-04-02T00:00:00Z',
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await ghApi.close();
    }
  });

  it('github_run_list omits items[].reader by default and skips reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 999,
              html_url: 'https://github.com/o/r/actions/runs/999',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc123',
              workflow_id: 42,
              created_at: '2024-05-01T00:00:00Z',
              name: 'CI INJECT payload',
              display_title: 'feat: thing',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_run_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
        },
        deps,
      );
      expect(result.items).toEqual([
        {
          id: 999,
          url: 'https://github.com/o/r/actions/runs/999',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          head_sha: 'abc123',
          workflow_id: 42,
          created_at: '2024-05-01T00:00:00Z',
        },
      ]);
      expect(readerCallBodies).toEqual([]);
    } finally {
      await ghApi.close();
    }
  });

  it('include_reader=true on arxiv_search returns items with reader populated', async () => {
    const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Paper One</title>
    <summary>Abstract.</summary>
    <author><name>Alice</name></author>
  </entry>
</feed>`;
    const arxiv = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(arxivXml);
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'export.arxiv.org': { port: arxiv.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'arxiv_search',
          params: { query: 'x', limit: 1 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.reader).toEqual({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
        source_provenance: {
          source: 'web_content',
          url: 'http://arxiv.org/abs/2401.00001v1',
          author_model: 'claude-haiku-4-5',
          timestamp: expect.any(String),
        },
      });
      expect(readerCallBodies).toHaveLength(1);
    } finally {
      await arxiv.close();
    }
  });

  it('include_reader=true on github_search populates items[].reader and calls reader RPC', async () => {
    const search = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              full_name: 'octo/cat',
              html_url: 'https://github.com/octo/cat',
              stargazers_count: 100,
              language: 'TypeScript',
              updated_at: '2024-01-01T00:00:00Z',
              description: 'A test repo',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: search.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_search',
          params: { query: 'x', limit: 1 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].reader).toEqual({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
        source_provenance: {
          source: 'web_content',
          url: 'https://github.com/octo/cat',
          author_model: 'claude-haiku-4-5',
          timestamp: expect.any(String),
        },
      });
      expect(readerCallBodies).toHaveLength(1);
    } finally {
      await search.close();
    }
  });

  it('include_reader=true on github_pr_list populates items[].reader and calls reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 10,
            html_url: 'https://github.com/o/r/pull/10',
            state: 'open',
            draft: false,
            created_at: '2024-03-01T00:00:00Z',
            updated_at: '2024-03-05T00:00:00Z',
            user: { login: 'alice' },
            title: 'New feature',
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_pr_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].reader).toEqual({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
        source_provenance: {
          source: 'web_content',
          url: 'https://github.com/o/r/pull/10',
          author_model: 'claude-haiku-4-5',
          timestamp: expect.any(String),
        },
      });
      expect(readerCallBodies).toHaveLength(1);
    } finally {
      await ghApi.close();
    }
  });

  it('include_reader=true on github_issue_list populates items[].reader and calls reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            number: 50,
            html_url: 'https://github.com/o/r/issues/50',
            state: 'open',
            created_at: '2024-04-01T00:00:00Z',
            updated_at: '2024-04-02T00:00:00Z',
            user: { login: 'alice' },
            title: 'Real issue',
            labels: [{ name: 'bug' }],
          },
        ]),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_issue_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].reader).toEqual({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
        source_provenance: {
          source: 'web_content',
          url: 'https://github.com/o/r/issues/50',
          author_model: 'claude-haiku-4-5',
          timestamp: expect.any(String),
        },
      });
      expect(readerCallBodies).toHaveLength(1);
    } finally {
      await ghApi.close();
    }
  });

  it('include_reader=true on github_run_list populates items[].reader and calls reader RPC', async () => {
    const ghApi = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 999,
              html_url: 'https://github.com/o/r/actions/runs/999',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc123',
              workflow_id: 42,
              created_at: '2024-05-01T00:00:00Z',
              name: 'CI',
              display_title: 'feat: thing',
            },
          ],
        }),
      );
    });
    try {
      const deps = buildLocalRedirectDeps({
        redirects: {
          'api.github.com': { port: ghApi.port, resolveTo: '8.8.8.8' },
        },
      });
      const result = await fetchUntrustedList(
        {
          source_type: 'github_run_list',
          params: { owner: 'o', repo: 'r', limit: 5 },
          include_reader: true,
        },
        deps,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].reader).toEqual({
        intent: 'user is reading a benign list item',
        extracted_data: { topic: 'test' },
        confidence: 0.9,
        risk_flags: [],
        source_provenance: {
          source: 'web_content',
          url: 'https://github.com/o/r/actions/runs/999',
          author_model: 'claude-haiku-4-5',
          timestamp: expect.any(String),
        },
      });
      expect(readerCallBodies).toHaveLength(1);
    } finally {
      await ghApi.close();
    }
  });
});

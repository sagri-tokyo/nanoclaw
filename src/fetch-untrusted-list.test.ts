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
  fetchUntrustedList,
  FetchUntrustedListResult,
} from './fetch-untrusted-list.js';
import { FetchUntrustedDeps, FetchUntrustedError } from './fetch-untrusted.js';

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

const READER_RESPONSE = {
  model: 'claude-sonnet-4-6',
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

  it('notion_database_query POSTs filter+page_size and launders properties per page', async () => {
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
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'page-id-1',
        url: 'https://www.notion.so/page-id-1',
        archived: false,
      });
      expect(readerCallBodies[0]).toContain('Brief one');
    } finally {
      await notion.close();
    }
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
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { RequestOptions } from 'https';

import {
  executeOrgAction,
  resolveNotionTarget,
  type OrgActionClientDeps,
} from './org-action-clients.js';
import type { FetchUntrustedDeps } from './fetch-untrusted.js';

const HEX32 = 'a'.repeat(32);
const DASHED_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeServer {
  port: number;
  captured: CapturedRequest[];
  setResponse: (status: number, body: string) => void;
  close: () => Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const captured: CapturedRequest[] = [];
  let response = { status: 200, body: '{"ok":true}' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(response.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    captured,
    setResponse: (status, body) => {
      response = { status, body };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Route every https request for any host to the one loopback server, and make
// DNS resolve every host to a routable-looking public IP so the SSRF guard
// passes (the production guard rejects RFC1918; 93.184.216.34 is public).
function loopbackDeps(port: number): FetchUntrustedDeps {
  return {
    lookup: async () => ({ address: '93.184.216.34', family: 4 }),
    httpsRequestFactory: (options: RequestOptions) =>
      http.request({
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      }),
  };
}

let server: FakeServer;
const ghCalls: { args: string[] }[] = [];

beforeEach(async () => {
  server = await startFakeServer();
  ghCalls.length = 0;
});

afterEach(async () => {
  await server.close();
});

function deps(
  overrides: Partial<OrgActionClientDeps> = {},
): OrgActionClientDeps {
  return {
    notionApiKey: 'notion-secret',
    githubToken: 'gh-secret',
    fetchDeps: loopbackDeps(server.port),
    spawnGh: async (args) => {
      ghCalls.push({ args });
      if (args[1] === 'list') {
        return { stdout: '[]', code: 0 };
      }
      return {
        stdout: 'https://github.com/sagri-tokyo/sagri-ai/issues/1\n',
        code: 0,
      };
    },
    sendDigest: async () => {},
    ...overrides,
  };
}

describe('notion writers', () => {
  it('append_progress PATCHes /v1/blocks/{id}/children with the host token', async () => {
    await executeOrgAction(
      {
        action: 'notion.append_progress',
        target_ref: HEX32,
        canonical_args: { text: 'progress note' },
      },
      deps(),
    );
    expect(server.captured).toHaveLength(1);
    const req = server.captured[0];
    expect(req.method).toBe('PATCH');
    expect(req.path).toBe(`/v1/blocks/${HEX32}/children`);
    expect(req.headers.authorization).toBe('Bearer notion-secret');
    expect(req.headers['notion-version']).toBe('2022-06-28');
  });

  it('write_property PATCHes /v1/pages/{id} with a rich_text body for a text property', async () => {
    await executeOrgAction(
      {
        action: 'notion.write_property',
        target_ref: HEX32,
        canonical_args: { property: 'Results Summary', value: 'done' },
      },
      deps(),
    );
    const req = server.captured[0];
    expect(req.method).toBe('PATCH');
    expect(req.path).toBe(`/v1/pages/${HEX32}`);
    expect(JSON.parse(req.body)).toEqual({
      properties: {
        'Results Summary': { rich_text: [{ text: { content: 'done' } }] },
      },
    });
  });

  it('write_property sends a select body for the Status lifecycle property', async () => {
    await executeOrgAction(
      {
        action: 'notion.write_property',
        target_ref: HEX32,
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      deps(),
    );
    expect(JSON.parse(server.captured[0].body)).toEqual({
      properties: { Status: { select: { name: 'Ready for AI' } } },
    });
  });

  it('create_task POSTs /v1/pages', async () => {
    await executeOrgAction(
      {
        action: 'notion.create_task',
        target_ref: HEX32,
        canonical_args: { title: 'New task' },
      },
      deps(),
    );
    const req = server.captured[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/pages');
  });

  it('throws (fail-fast) on a non-2xx Notion response', async () => {
    server.setResponse(400, '{"message":"bad"}');
    await expect(
      executeOrgAction(
        {
          action: 'notion.write_property',
          target_ref: HEX32,
          canonical_args: { property: 'X', value: 'y' },
        },
        deps(),
      ),
    ).rejects.toThrow();
  });
});

describe('github writers', () => {
  it('file_issue searches for duplicates then spawns gh create when none exist', async () => {
    await executeOrgAction(
      {
        action: 'github.file_issue',
        target_ref: 'sagri-tokyo/sagri-ai',
        canonical_args: { title: 'Bug', body: 'Details' },
      },
      deps(),
    );
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0].args).toEqual([
      'issue',
      'list',
      '--repo',
      'sagri-tokyo/sagri-ai',
      '--search',
      'Bug',
      '--state',
      'all',
      '--json',
      'title,url',
      '--limit',
      '5',
    ]);
    expect(ghCalls[1].args).toEqual([
      'issue',
      'create',
      '--repo',
      'sagri-tokyo/sagri-ai',
      '--title',
      'Bug',
      '--body',
      'Details',
    ]);
  });

  it('refuses to file when a case-insensitive title match already exists', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'Existing Bug', body: 'd' },
        },
        deps({
          spawnGh: async (args) => {
            ghCalls.push({ args });
            if (args[1] === 'list') {
              return {
                stdout: JSON.stringify([
                  {
                    number: 291,
                    title: 'existing bug',
                    url: 'https://github.com/sagri-tokyo/sagri-ai/issues/291',
                  },
                ]),
                code: 0,
              };
            }
            return { stdout: '', code: 0 };
          },
        }),
      ),
    ).rejects.toThrow(/already exists.*issues\/291/);
    expect(ghCalls.map((c) => c.args[1])).toEqual(['list']);
  });

  it('refuses when an existing title is a substring of the new title', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            title: 'Dedup file_issue against existing open issues',
            body: 'd',
          },
        },
        deps({
          spawnGh: async (args) => {
            ghCalls.push({ args });
            if (args[1] === 'list') {
              return {
                stdout: JSON.stringify([
                  {
                    title: 'dedup file_issue',
                    url: 'https://github.com/sagri-tokyo/sagri-ai/issues/362',
                  },
                ]),
                code: 0,
              };
            }
            return { stdout: '', code: 0 };
          },
        }),
      ),
    ).rejects.toThrow(/issues\/362/);
    expect(ghCalls.map((c) => c.args[1])).toEqual(['list']);
  });

  it('skips a malformed hit but still catches a real duplicate later in the list', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'Real Dup', body: 'd' },
        },
        deps({
          spawnGh: async (args) => {
            ghCalls.push({ args });
            if (args[1] === 'list') {
              return {
                stdout: JSON.stringify([
                  { number: 1 },
                  {
                    title: 'real dup',
                    url: 'https://github.com/sagri-tokyo/sagri-ai/issues/9',
                  },
                ]),
                code: 0,
              };
            }
            return { stdout: '', code: 0 };
          },
        }),
      ),
    ).rejects.toThrow(/issues\/9/);
    expect(ghCalls.map((c) => c.args[1])).toEqual(['list']);
  });

  it('files when the search returns only topically-unrelated issues', async () => {
    await executeOrgAction(
      {
        action: 'github.file_issue',
        target_ref: 'sagri-tokyo/sagri-ai',
        canonical_args: { title: 'Add dedup check to file_issue', body: 'd' },
      },
      deps({
        spawnGh: async (args) => {
          ghCalls.push({ args });
          if (args[1] === 'list') {
            return {
              stdout: JSON.stringify([
                {
                  number: 5,
                  title: 'Something completely different',
                  url: 'https://github.com/sagri-tokyo/sagri-ai/issues/5',
                },
              ]),
              code: 0,
            };
          }
          return { stdout: 'created', code: 0 };
        },
      }),
    );
    expect(ghCalls.map((c) => c.args[1])).toEqual(['list', 'create']);
  });

  it('refuses (does not create) when the duplicate search itself fails', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'Bug', body: 'd' },
        },
        deps({
          spawnGh: async (args) => {
            ghCalls.push({ args });
            if (args[1] === 'list') {
              return { stdout: '', stderr: 'search boom', code: 1 };
            }
            return { stdout: 'created', code: 0 };
          },
        }),
      ),
    ).rejects.toThrow(/gh issue list/);
    expect(ghCalls.map((c) => c.args[1])).toEqual(['list']);
  });

  it('open_draft_pr always passes --draft', async () => {
    await executeOrgAction(
      {
        action: 'github.open_draft_pr',
        target_ref: 'sagri-tokyo/sagri-ai',
        canonical_args: {
          head: 'feat/x',
          base: 'main',
          title: 'PR',
          body: 'body',
        },
      },
      deps(),
    );
    expect(ghCalls[0].args).toContain('--draft');
    expect(ghCalls[0].args).not.toContain('ready');
    expect(ghCalls[0].args).not.toContain('merge');
  });

  it('refuses any repo other than the allowlisted one', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/nanoclaw',
          canonical_args: { title: 'X', body: 'y' },
        },
        deps(),
      ),
    ).rejects.toThrow(/allowlist/i);
    expect(ghCalls).toHaveLength(0);
  });

  it('throws when gh exits non-zero', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'X', body: 'y' },
        },
        deps({
          spawnGh: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a file_issue title over the 200-char cap without spawning gh', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'x'.repeat(201), body: 'y' },
        },
        deps(),
      ),
    ).rejects.toThrow(/200-character limit/);
    expect(ghCalls).toHaveLength(0);
  });

  it('rejects a file_issue body over the 10000-char cap without spawning gh', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: { title: 'ok', body: 'y'.repeat(10001) },
        },
        deps(),
      ),
    ).rejects.toThrow(/10000-character limit/);
    expect(ghCalls).toHaveLength(0);
  });

  it('rejects an open_draft_pr head beginning with "-" (flag injection) without spawning gh', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.open_draft_pr',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            head: '--force',
            base: 'main',
            title: 'PR',
            body: 'body',
          },
        },
        deps(),
      ),
    ).rejects.toThrow(/flag injection/);
    expect(ghCalls).toHaveLength(0);
  });

  it('rejects an open_draft_pr base with characters outside the branch-name set', async () => {
    await expect(
      executeOrgAction(
        {
          action: 'github.open_draft_pr',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            head: 'feat/x',
            base: 'main; rm -rf /',
            title: 'PR',
            body: 'body',
          },
        },
        deps(),
      ),
    ).rejects.toThrow(/valid branch name/);
    expect(ghCalls).toHaveLength(0);
  });
});

describe('slack digest + doc.draft', () => {
  it('post_digest delegates to the host send seam', async () => {
    const posted: { channelId: string; text: string }[] = [];
    await executeOrgAction(
      {
        action: 'slack.post_digest',
        target_ref: 'C0AAA1111',
        canonical_args: { text: 'the digest' },
      },
      deps({
        sendDigest: async (channelId, text) => {
          posted.push({ channelId, text });
        },
      }),
    );
    expect(posted).toEqual([{ channelId: 'C0AAA1111', text: 'the digest' }]);
  });

  it('doc.draft creates a Notion page (POST /v1/pages)', async () => {
    await executeOrgAction(
      {
        action: 'doc.draft',
        target_ref: HEX32,
        canonical_args: { title: 'Draft', body: 'content' },
      },
      deps(),
    );
    const req = server.captured[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/pages');
  });
});

function searchResult(pages: { id: string; title: string }[]): string {
  return JSON.stringify({
    object: 'list',
    results: pages.map((p) => ({
      object: 'page',
      id: p.id,
      properties: {
        Title: {
          id: 'title',
          type: 'title',
          title: [{ type: 'text', plain_text: p.title }],
        },
      },
    })),
  });
}

describe('resolveNotionTarget — host-side name resolution', () => {
  it('POSTs /v1/search with a page filter and the query, using the host token', async () => {
    server.setResponse(
      200,
      searchResult([{ id: DASHED_ID, title: 'Soil Model Task' }]),
    );
    await resolveNotionTarget('Soil Model Task', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(server.captured).toHaveLength(1);
    const req = server.captured[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/search');
    expect(req.headers.authorization).toBe('Bearer notion-secret');
    expect(JSON.parse(req.body)).toEqual({
      query: 'Soil Model Task',
      filter: { property: 'object', value: 'page' },
      page_size: 20,
    });
  });

  it('returns no_match when the single relevance hit has no title text (cannot name-match a titleless page)', async () => {
    server.setResponse(
      200,
      JSON.stringify({
        object: 'list',
        results: [{ object: 'page', id: DASHED_ID, properties: {} }],
      }),
    );
    const resolution = await resolveNotionTarget('Soil Model Task', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({ kind: 'unresolved', reason: 'no_match' });
  });

  it('returns the single match as a dash-stripped 32-hex id plus its title', async () => {
    server.setResponse(
      200,
      searchResult([{ id: DASHED_ID, title: 'Soil Model Task' }]),
    );
    const resolution = await resolveNotionTarget('Soil Model Task', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({
      kind: 'resolved',
      id: HEX32,
      title: 'Soil Model Task',
    });
  });

  it('returns an unresolved no_match sentinel on zero results', async () => {
    server.setResponse(200, searchResult([]));
    const resolution = await resolveNotionTarget('Nothing', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({ kind: 'unresolved', reason: 'no_match' });
  });

  it('returns an unresolved multiple_matches sentinel when more than one page has the exact title', async () => {
    server.setResponse(
      200,
      searchResult([
        { id: DASHED_ID, title: 'Soil Model Task' },
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          title: 'Soil Model Task',
        },
      ]),
    );
    const resolution = await resolveNotionTarget('Soil Model Task', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({
      kind: 'unresolved',
      reason: 'multiple_matches',
    });
  });

  it('filters out a relevance-only hit whose title does not equal the query (no_match)', async () => {
    // /v1/search is relevance-ranked, not title-exact: it returns pages whose
    // title does not equal the query. Those must not resolve.
    server.setResponse(
      200,
      searchResult([{ id: DASHED_ID, title: 'A Different Page' }]),
    );
    const resolution = await resolveNotionTarget('Soil Model Task', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({ kind: 'unresolved', reason: 'no_match' });
  });

  it('matches the exact title case-insensitively after trimming', async () => {
    server.setResponse(
      200,
      searchResult([{ id: DASHED_ID, title: 'Soil Model Task' }]),
    );
    const resolution = await resolveNotionTarget('  soil model task  ', {
      notionApiKey: 'notion-secret',
      fetchDeps: loopbackDeps(server.port),
    });
    expect(resolution).toEqual({
      kind: 'resolved',
      id: HEX32,
      title: 'Soil Model Task',
    });
  });

  it('throws (fail-fast) on a non-2xx search response', async () => {
    server.setResponse(401, '{"message":"unauthorized"}');
    await expect(
      resolveNotionTarget('Soil Model Task', {
        notionApiKey: 'notion-secret',
        fetchDeps: loopbackDeps(server.port),
      }),
    ).rejects.toThrow();
  });

  it('throws on a single match whose id is not a valid 32-hex page id', async () => {
    server.setResponse(
      200,
      JSON.stringify({
        object: 'list',
        results: [
          {
            object: 'page',
            id: 'not-a-real-id',
            properties: {
              Title: {
                id: 'title',
                type: 'title',
                title: [{ type: 'text', plain_text: 'Soil Model Task' }],
              },
            },
          },
        ],
      }),
    );
    await expect(
      resolveNotionTarget('Soil Model Task', {
        notionApiKey: 'notion-secret',
        fetchDeps: loopbackDeps(server.port),
      }),
    ).rejects.toThrow(/malformed page id/);
  });
});

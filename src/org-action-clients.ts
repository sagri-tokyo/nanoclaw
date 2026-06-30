/**
 * Host-side write clients for the gated org-action set (D2.4).
 *
 * These exist only because the gate moves execution host-side: the host owns
 * `NOTION_API_KEY` / `GITHUB_TOKEN` in its own `process.env` and replays the
 * persisted canonical args after approval. The container has no synchronous
 * write client; this is it. All HTTP writes go through the SSRF-guarded
 * `fetchJsonWrite` (public-address / DNS-rebinding guards inherited); `gh`
 * writes go through `spawn` with an argv array (never shell interpolation).
 *
 * Fail-fast: a non-2xx, a non-zero `gh` exit, or an out-of-allowlist repo
 * throws. No silent retry, no fallback.
 */

import { spawn } from 'child_process';

import {
  fetchJsonWrite,
  resolveDeps,
  type FetchUntrustedDeps,
} from './fetch-untrusted.js';
import { GITHUB_REPO_ALLOWLIST, isPlainObject } from './org-action-gate.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface OrgActionExecRequest {
  action: string;
  target_ref: string;
  canonical_args: Record<string, unknown>;
}

export interface GhResult {
  stdout: string;
  stderr?: string;
  code: number;
}

export interface OrgActionClientDeps {
  notionApiKey: string;
  githubToken: string;
  // SSRF-fetch deps (lookup + httpsRequestFactory). Injected in tests to route
  // to a loopback fake; in production it is the default real transport.
  fetchDeps?: FetchUntrustedDeps;
  // `gh` invocation seam. Resolves with stdout/exit code; the default spawns
  // the real `gh` with GITHUB_TOKEN in the child env.
  spawnGh?: (args: string[], githubToken: string) => Promise<GhResult>;
  // Slack digest send seam — reuses the host's existing send path (the host
  // already owns the Slack token); no new client here.
  sendDigest: (channelId: string, text: string) => Promise<void>;
}

function notionHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'notion-version': NOTION_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'nanoclaw-org-action/1.0',
  };
}

function defaultSpawnGh(
  args: string[],
  githubToken: string,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      env: { ...process.env, GITHUB_TOKEN: githubToken, GH_TOKEN: githubToken },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        code: code ?? -1,
      });
    });
  });
}

// Notion property bodies are type-specific. `Status` and `Type` are `select`
// properties in the Sagri AI Tasks DB (and `Status` is the lifecycle-flip the
// gate holds on), so a `rich_text` body 400s. Map the known select properties
// explicitly; everything else is treated as `rich_text`. A property whose
// real type is mismatched is a fail-fast 400 from Notion, not a silent write.
const NOTION_SELECT_PROPERTIES: ReadonlySet<string> = new Set([
  'Status',
  'Type',
  'Priority',
  'Source',
]);

function notionPropertyBody(property: string, value: string): object {
  if (NOTION_SELECT_PROPERTIES.has(property)) {
    return { select: { name: value } };
  }
  return { rich_text: [{ text: { content: value } }] };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`org-action: missing required string arg "${key}"`);
  }
  return value;
}

const TITLE_MAX = 200;
const BODY_MAX = 10000;
// Conservative git ref shape. The first character is anchored to exclude `-`
// so a leading `-` (which `gh` would read as a flag, not a branch name — argv
// flag injection) can never match, independent of the explicit startsWith check
// below. The argv array is spawned without a shell, but flag injection does not
// need a shell.
const BRANCH_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,254}$/;

function requireBoundedString(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = requireString(args, key);
  if (value.length > max) {
    throw new Error(
      `org-action: "${key}" exceeds the ${max}-character limit (${value.length})`,
    );
  }
  return value;
}

function requireBranchName(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key);
  if (value.startsWith('-')) {
    throw new Error(
      `org-action: "${key}" must not start with "-" (flag injection)`,
    );
  }
  if (!BRANCH_NAME.test(value)) {
    throw new Error(`org-action: "${key}" is not a valid branch name`);
  }
  return value;
}

export async function executeOrgAction(
  request: OrgActionExecRequest,
  deps: OrgActionClientDeps,
): Promise<void> {
  const fetchDeps = resolveDeps(deps.fetchDeps);
  const spawnGh = deps.spawnGh ?? defaultSpawnGh;

  switch (request.action) {
    case 'notion.append_progress': {
      const text = requireString(request.canonical_args, 'text');
      await fetchJsonWrite({
        url: `${NOTION_API_BASE}/blocks/${request.target_ref}/children`,
        method: 'PATCH',
        headers: notionHeaders(deps.notionApiKey),
        body: JSON.stringify({
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [{ type: 'text', text: { content: text } }],
              },
            },
          ],
        }),
        deps: fetchDeps,
      });
      return;
    }

    case 'notion.write_property': {
      const property = requireString(request.canonical_args, 'property');
      const value = requireString(request.canonical_args, 'value');
      await fetchJsonWrite({
        url: `${NOTION_API_BASE}/pages/${request.target_ref}`,
        method: 'PATCH',
        headers: notionHeaders(deps.notionApiKey),
        body: JSON.stringify({
          properties: {
            [property]: notionPropertyBody(property, value),
          },
        }),
        deps: fetchDeps,
      });
      return;
    }

    case 'notion.create_task':
    case 'doc.draft': {
      const title = requireBoundedString(
        request.canonical_args,
        'title',
        TITLE_MAX,
      );
      await fetchJsonWrite({
        url: `${NOTION_API_BASE}/pages`,
        method: 'POST',
        headers: notionHeaders(deps.notionApiKey),
        body: JSON.stringify({
          parent: { database_id: request.target_ref },
          properties: {
            Title: { title: [{ text: { content: title } }] },
            Status: { select: { name: 'Draft' } },
          },
        }),
        deps: fetchDeps,
      });
      return;
    }

    case 'github.file_issue': {
      assertAllowlistedRepo(request.target_ref);
      const title = requireBoundedString(
        request.canonical_args,
        'title',
        TITLE_MAX,
      );
      const body = requireBoundedString(
        request.canonical_args,
        'body',
        BODY_MAX,
      );
      const result = await spawnGh(
        [
          'issue',
          'create',
          '--repo',
          request.target_ref,
          '--title',
          title,
          '--body',
          body,
        ],
        deps.githubToken,
      );
      assertGhOk(result, 'gh issue create');
      return;
    }

    case 'github.open_draft_pr': {
      assertAllowlistedRepo(request.target_ref);
      const head = requireBranchName(request.canonical_args, 'head');
      const base = requireBranchName(request.canonical_args, 'base');
      const title = requireBoundedString(
        request.canonical_args,
        'title',
        TITLE_MAX,
      );
      const body = requireBoundedString(
        request.canonical_args,
        'body',
        BODY_MAX,
      );
      const result = await spawnGh(
        [
          'pr',
          'create',
          '--repo',
          request.target_ref,
          '--head',
          head,
          '--base',
          base,
          '--title',
          title,
          '--body',
          body,
          '--draft',
        ],
        deps.githubToken,
      );
      assertGhOk(result, 'gh pr create');
      return;
    }

    case 'slack.post_digest': {
      const text = requireString(request.canonical_args, 'text');
      await deps.sendDigest(request.target_ref, text);
      return;
    }

    default:
      throw new Error(`org-action: unknown action "${request.action}"`);
  }
}

export interface NotionResolveDeps {
  notionApiKey: string;
  // SSRF-fetch deps, injected in tests to route to a loopback fake. Same seam
  // executeOrgAction uses, so resolution inherits the public-address /
  // DNS-rebinding guards rather than opening a new un-guarded fetch path.
  fetchDeps?: FetchUntrustedDeps;
}

export type NotionTargetResolution =
  | { kind: 'resolved'; id: string; title: string | null }
  | { kind: 'unresolved'; reason: 'no_match' | 'multiple_matches' };

function extractTitle(page: Record<string, unknown>): string | null {
  const properties = page.properties;
  if (!isPlainObject(properties)) return null;
  for (const value of Object.values(properties)) {
    if (!isPlainObject(value) || value.type !== 'title') continue;
    const parts = value.title;
    if (!Array.isArray(parts)) return null;
    const text = parts
      .map((part) =>
        isPlainObject(part) && typeof part.plain_text === 'string'
          ? part.plain_text
          : '',
      )
      .join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Resolve a Notion page NAME to a page id host-side (the operator container
 * has no NOTION_API_KEY after sagri-ai#312, so it cannot resolve the name
 * in-container). One-match-or-abort: a search that returns zero or more than
 * one page is an `unresolved` sentinel the caller turns into a refuse, never a
 * best-guess pick. A non-2xx search throws (fail-fast). Reuses the SSRF-guarded
 * `fetchJsonWrite` so this opens no new un-guarded fetch path.
 */
export async function resolveNotionTarget(
  query: string,
  deps: NotionResolveDeps,
): Promise<NotionTargetResolution> {
  const fetchDeps = resolveDeps(deps.fetchDeps);
  const response = await fetchJsonWrite({
    url: `${NOTION_API_BASE}/search`,
    method: 'POST',
    headers: notionHeaders(deps.notionApiKey),
    body: JSON.stringify({
      query,
      filter: { property: 'object', value: 'page' },
    }),
    deps: fetchDeps,
  });
  const results = response.results;
  if (!Array.isArray(results) || results.length === 0) {
    return { kind: 'unresolved', reason: 'no_match' };
  }
  if (results.length > 1) {
    return { kind: 'unresolved', reason: 'multiple_matches' };
  }
  const page = results[0];
  if (!isPlainObject(page) || typeof page.id !== 'string') {
    throw new Error('org-action: Notion search result has no page id');
  }
  const id = page.id.replace(/-/g, '').toLowerCase();
  return { kind: 'resolved', id, title: extractTitle(page) };
}

function assertAllowlistedRepo(repo: string): void {
  if (repo !== GITHUB_REPO_ALLOWLIST) {
    throw new Error(
      `org-action: github repo "${repo}" is not in the allowlist (${GITHUB_REPO_ALLOWLIST})`,
    );
  }
}

function assertGhOk(result: GhResult, label: string): void {
  if (result.code !== 0) {
    throw new Error(
      `org-action: ${label} exited ${result.code}: ${result.stderr ?? ''}`,
    );
  }
}

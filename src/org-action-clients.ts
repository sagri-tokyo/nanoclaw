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
import {
  GITHUB_REPO_ALLOWLIST,
  isNotionPageId,
  isPlainObject,
} from './org-action-gate.js';

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
      // ponytail: best-effort, non-atomic. Two concurrent file_issue replays
      // for the same title can both pass this check before either creates.
      // Fine here — org-actions execute serially after single-approval, and
      // GitHub has no issue-creation idempotency key to make it atomic.
      const search = await spawnGh(
        [
          'issue',
          'list',
          '--repo',
          request.target_ref,
          '--search',
          title,
          '--state',
          'all',
          '--json',
          'title,url',
          '--limit',
          '5',
        ],
        deps.githubToken,
      );
      assertGhOk(search, 'gh issue list');
      const duplicate = findDuplicateIssue(search.stdout, title);
      if (duplicate !== null) {
        throw new Error(
          `org-action: a similar issue already exists: ${duplicate.url} ("${duplicate.title}") — refusing to file a duplicate`,
        );
      }
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
    // page_size 10 bounds the response under the 256KB fetch cap (the default
    // returns up to 100 full page objects, which overflows it). /v1/search is
    // relevance-ranked, not a title-exact lookup: it returns pages even when no
    // title equals the query, so the exact-title filter below is what makes
    // resolution precise. 10 candidates lets a distinctive title surface while
    // staying well under the body cap.
    body: JSON.stringify({
      query,
      filter: { property: 'object', value: 'page' },
      page_size: 20,
    }),
    deps: fetchDeps,
  });
  const results = response.results;
  if (!Array.isArray(results)) {
    return { kind: 'unresolved', reason: 'no_match' };
  }
  // Keep only exact title matches, then apply one-match-or-abort over that
  // filtered set. A relevance hit whose title does not equal the query is not
  // the page the operator named. Compare trimmed, NFC-normalized (so composed
  // vs decomposed accents match), and case-insensitively.
  const normalize = (value: string) =>
    value.trim().normalize('NFC').toLowerCase();
  const wanted = normalize(query);
  const matches = results.filter((page): page is Record<string, unknown> => {
    if (!isPlainObject(page) || typeof page.id !== 'string') return false;
    const title = extractTitle(page);
    return title !== null && normalize(title) === wanted;
  });
  if (matches.length === 0) {
    return { kind: 'unresolved', reason: 'no_match' };
  }
  if (matches.length > 1) {
    return { kind: 'unresolved', reason: 'multiple_matches' };
  }
  const page = matches[0];
  const rawId = page.id as string;
  const id = rawId.replace(/-/g, '').toLowerCase();
  // Throw a specific diagnostic rather than letting the classifier refuse the
  // resolved id with a generic shape-refuse log line. The handler turns this
  // throw into a refuse.
  if (!isNotionPageId(id)) {
    throw new Error(
      `org-action: Notion search returned a malformed page id "${rawId}"`,
    );
  }
  return { kind: 'resolved', id, title: extractTitle(page) };
}

interface IssueSearchHit {
  title: string;
  url: string;
}

// Search-before-create dedup for `github.file_issue`: gh already relevance-
// ranks candidates server-side via `--search <title>`, so this only needs to
// decide which of those candidates counts as "the same issue". A case-
// insensitive exact-or-substring title match is the smallest check that would
// have caught the 2026-07-03 near-miss (re-filing sagri-ai#291 whose card was
// unfurled in the same message).
// ponytail: exact/substring title match, not fuzzy. If real near-dupes slip
// through with reworded titles, swap in a token-overlap score here.
function findDuplicateIssue(
  searchStdout: string,
  title: string,
): IssueSearchHit | null {
  const parsed = JSON.parse(searchStdout);
  if (!Array.isArray(parsed)) {
    throw new Error('org-action: gh issue list returned a non-array payload');
  }
  const normalize = (value: string) =>
    value.trim().normalize('NFC').toLowerCase();
  const wanted = normalize(title);
  for (const hit of parsed) {
    if (!isPlainObject(hit) || typeof hit.title !== 'string') continue;
    const existing = normalize(hit.title);
    if (existing.length === 0) continue;
    const isMatch =
      existing === wanted ||
      existing.includes(wanted) ||
      wanted.includes(existing);
    if (!isMatch) continue;
    if (typeof hit.url !== 'string') {
      throw new Error(
        'org-action: gh issue list hit matched by title but has no url',
      );
    }
    return { title: hit.title, url: hit.url };
  }
  return null;
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

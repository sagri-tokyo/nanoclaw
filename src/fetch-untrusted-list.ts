/**
 * List-source adapters that complement `fetchUntrusted`. Each adapter fetches
 * a paginated upstream list (arXiv search, GitHub repo/PR/issue/run lists,
 * Notion database query, Notion search) and returns a structured list. Constrained fields
 * (numeric ids, urls, ISO timestamps, GitHub logins) are always surfaced raw
 * on each item.
 *
 * By default, each item's free-text fields (titles, descriptions, abstracts)
 * are dropped entirely — they never reach the agent and the host-side reader
 * pipeline (`readUntrustedContent`) is not invoked.
 * Callers that need a laundered paraphrase to rank or summarize items pass
 * `include_reader: true`; for those callers the free-text body is run through
 * the reader pipeline and the resulting `ReaderOutput` is attached as
 * `items[].reader`. See sagri-ai#119 for the threat model — the prior
 * always-launder behavior surfaced attacker-influenced wording in
 * `reader.intent` / `reader.extracted_data`, which the agent treated as
 * trusted context even though the prompt instructed otherwise.
 *
 * `notion_database_query` is the exception: it is enumeration-only and rejects
 * `include_reader` outright, so Notion page properties are never laundered. The
 * laundered per-row view is the `notion_page` read in `fetchUntrusted`.
 *
 * Same SSRF defences as `fetchUntrusted`: HTTPS only, public addresses only,
 * connection bound to the resolved IP. Reuses helpers from `./fetch-untrusted`.
 *
 * sagri-ai#99 (initial), sagri-ai#119 (default-omit reader).
 */
import { XMLParser } from 'fast-xml-parser';
import { RequestOptions } from 'https';
import { ClientRequest } from 'http';

import {
  FetchUntrustedDeps,
  FetchUntrustedError,
  FetchUntrustedMalformed,
  FetchUntrustedTimeout,
  FetchUntrustedUnlaunderable,
  fetchJsonObject,
  fetchWithRedirects,
  requireEnv,
  resolveDeps,
  throwForNon2xxStatus,
  validatePublicHttpsUrl,
} from './fetch-untrusted.js';
import { logger } from './logger.js';
import { isPlainObject } from './org-action-gate.js';
import {
  readUntrustedContent,
  type ReaderOutput,
  type SourceMetadata,
} from './reader.js';

const NOTION_VERSION = '2022-06-28';
const POST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;

const ARXIV_LIMIT_MAX = 25;
const GITHUB_SEARCH_LIMIT_MAX = 30;
const GITHUB_LIST_LIMIT_MAX = 100;
const NOTION_LIMIT_MAX = 100;

// A GitHub pulls item embeds full head/base repo and user objects and runs
// ~20KB, so asking for per_page=100 returns ~2MB and trips the MAX_BODY_BYTES
// guard before anything is parsed (sagri-ai#472). 10 keeps a pulls page near
// 200KB, and issues pages are far smaller.
const GITHUB_PAGE_SIZE = 10;

// 200KB of typical rows leaves a page only 1.4x under the 256 KiB default, and
// the bound that matters is what a page may contain, not what one repo measured:
// GitHub caps an issue/PR body at 65,536 characters, so GITHUB_PAGE_SIZE rows of
// maximal ASCII body plus their ~20KB of surrounding fields reach ~840KB. 1 MiB
// clears that; every other adapter keeps MAX_BODY_BYTES.
//
// A DoS backstop, not a correctness guarantee: a page of maximal multibyte
// bodies could still cross it, and surfaces as a loud leg failure rather than a
// silent truncation.
const GITHUB_LIST_MAX_BODY_BYTES = 1024 * 1024;

// How many rows we are willing to read per row the caller asked for, before
// giving up. The issue list drops every pull_request row, and on a repo where
// bots open PRs around the clock those can be most of a page, so `limit` rows
// of output can cost several times that in input. 3 covers a list that is
// two-thirds PRs. Crossing it throws rather than returning a short list: a
// truncated list is indistinguishable from a genuinely small one, and inventing
// that ambiguity is the bug this file is being fixed for (sagri-ai#472, #378).
const GITHUB_LIST_OVERSCAN = 3;

// Floor under the overscan. A page is GITHUB_PAGE_SIZE rows whatever the ask,
// so overscan alone is too coarse at small limits: limit 3 works out to a
// single page, and one page of PR rows would exhaust an issue list before it
// saw its first issue. Three pages give any limit room to page past a filtered
// run.
const GITHUB_MIN_PAGES = 3;

// GitHub's exact updated_at/created_at spelling. Deliberately no milliseconds:
// `since` is compared byte-wise against those fields, which is only sound when
// both sides are spelled the same. '.' sorts below 'Z', so a since carrying
// '.000Z' would sit just under the same instant and skew the boundary rather
// than fail. Reject it and make the caller say what it means.
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function optionalSince(params: Record<string, unknown>): string | undefined {
  const since = optionalString(params, 'since');
  if (since === undefined) return since;
  // The regex fixes the spelling, Date fixes the calendar. '2024-99-99T99:99:99Z'
  // is the right shape and sorts above every real updated_at, so on its own the
  // regex lets it end the walk at row one and return the empty list that reads
  // exactly like an empty window. Round-tripping rejects it, along with the
  // values Date would silently normalize instead (2024-02-30, 24:00:00). NaN
  // first: toISOString throws on an invalid date.
  const parsed = new Date(since);
  if (
    !ISO_8601_UTC.test(since) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== since.replace('Z', '.000Z')
  ) {
    paramErr(
      'since must be an ISO-8601 UTC timestamp with no milliseconds, e.g. 2026-07-15T00:00:00Z',
    );
  }
  return since;
}

export type ListSourceType =
  | 'arxiv_search'
  | 'github_search'
  | 'github_pr_list'
  | 'github_issue_list'
  | 'github_run_list'
  | 'notion_database_query'
  | 'notion_search';

const VALID_LIST_SOURCE_TYPES: ReadonlySet<ListSourceType> = new Set([
  'arxiv_search',
  'github_search',
  'github_pr_list',
  'github_issue_list',
  'github_run_list',
  'notion_database_query',
  'notion_search',
]);

// Post-validation shape produced by `validateInput`. The raw RPC payload may
// omit `include_reader` — the validator normalises it to a concrete boolean
// before any adapter runs.
export interface FetchUntrustedListInput {
  source_type: ListSourceType;
  params: Record<string, unknown>;
  include_reader: boolean;
}

export interface ArxivItem {
  id: string;
  url: string;
  published: string;
  updated: string;
  authors: string[];
  reader?: ReaderOutput;
}

export interface GithubSearchItem {
  id: number;
  full_name: string;
  url: string;
  stars: number;
  language: string | null;
  updated_at: string;
  reader?: ReaderOutput;
}

export interface GithubPrItem {
  number: number;
  url: string;
  state: string;
  author: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  reader?: ReaderOutput;
}

export interface GithubIssueItem {
  number: number;
  url: string;
  state: string;
  author: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  reader?: ReaderOutput;
}

export interface GithubRunItem {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  workflow_id: number;
  created_at: string;
  reader?: ReaderOutput;
}

export interface NotionDatabaseItem {
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  // Enumeration-only: this adapter rejects include_reader, so a reader is never
  // attached. Typed `never` rather than omitted so `reader` stays accessible
  // across the ListItem union without per-member narrowing.
  reader?: never;
}

export interface NotionSearchItem {
  id: string;
  url: string;
  object: 'page' | 'database';
  reader?: ReaderOutput;
}

export type ListItem =
  | ArxivItem
  | GithubSearchItem
  | GithubPrItem
  | GithubIssueItem
  | GithubRunItem
  | NotionDatabaseItem
  | NotionSearchItem;

export interface FetchUntrustedListResult {
  items: ListItem[];
}

function paramErr(message: string): never {
  throw new FetchUntrustedError('invalid_params', message);
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    paramErr(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    paramErr(`${name} must be a non-empty string when provided`);
  }
  return value;
}

function requireLimit(params: Record<string, unknown>, cap: number): number {
  const value = params.limit;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    paramErr('limit must be a positive integer');
  }
  if (value > cap) {
    paramErr(`limit must be <= ${cap}`);
  }
  return value;
}

function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) paramErr(`unknown param: ${key}`);
  }
}

// The largest real input is arxiv_search's title+abstract, near 2000 chars,
// and nothing here enforces that: it holds because arXiv's submission form caps
// abstracts around 1920, a convention this repo does not own. So no adapter
// trips this today *given that limit*, which is the assumption to check first
// if it ever fires. It is a tripwire for a future adapter widened to launder a
// whole issue body, which is prose the shape check below would wave through.
// The real ceiling without it is MAX_BODY_BYTES (256KB), no kind of bound on a
// field meant to be a sentence; 4000 is ~2x the largest real input and ~64x
// tighter than the body cap. A chosen bound, not a derivation. sagri-ai#471.
const MAX_LAUNDER_RAW_LENGTH = 4000;

// Convicts a nested struct: JSON.stringify(properties), the blob that broke
// prod, wraps every value in a per-type envelope object. Nesting is the
// discriminator, not parseability and not a leading brace, so '{redacted} ...'
// prose and a flat scalar map like '{"status":"done"}' both acquit. Each is a
// field a human sends, and a conviction costs the whole batch.
//
// A top-level array is never examined, so a widening to JSON.stringify(labels)
// in githubIssueList would slip through bracket-opened (sagri-ai#483).
function isSerializedStruct(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  // Unreachable: '{' parses only as an object. Narrows unknown for Object.values.
  if (parsed === null || typeof parsed !== 'object') return false;
  return Object.values(parsed).some(
    (value) => value !== null && typeof value === 'object',
  );
}

async function launder(args: {
  raw: string;
  source: 'web_content' | 'github_issue' | 'github_comment' | 'notion_page';
  url: string;
}): Promise<ReaderOutput> {
  // Guarded here, the one boundary every adapter routes through, so a widened
  // adapter trips it without needing its own check. Both checks throw for the
  // whole batch, so each may only convict input no honest adapter can send
  // (sagri-ai#483). Messages carry lengths, never raw bytes.
  if (args.raw.length > MAX_LAUNDER_RAW_LENGTH) {
    throw new FetchUntrustedUnlaunderable(
      `launder raw exceeds ${MAX_LAUNDER_RAW_LENGTH} chars (got ${args.raw.length})`,
    );
  }
  if (isSerializedStruct(args.raw)) {
    throw new FetchUntrustedUnlaunderable(
      'launder raw must be prose, not a serialized struct',
    );
  }
  const sourceMetadata: SourceMetadata = { url: args.url };
  try {
    return await readUntrustedContent({
      raw: args.raw,
      source: args.source,
      sourceMetadata,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-untrusted-list: reader pipeline failed');
    throw new FetchUntrustedError('reader_failure', 'reader pipeline failed');
  }
}

// ---------- arxiv_search ----------

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';

interface ArxivAtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  authors: string[];
}

function parseArxivFeed(xml: string): ArxivAtomEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  const feed = parsed?.feed;
  if (!feed || typeof feed !== 'object') {
    throw new FetchUntrustedError(
      'fetch_failure',
      'arxiv response missing feed',
    );
  }
  const rawEntries = feed.entry;
  if (rawEntries === undefined) return [];
  const entries: unknown[] = Array.isArray(rawEntries)
    ? rawEntries
    : [rawEntries];
  const out: ArxivAtomEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    const title = typeof e.title === 'string' ? e.title : '';
    const summary = typeof e.summary === 'string' ? e.summary : '';
    const published = typeof e.published === 'string' ? e.published : '';
    const updated = typeof e.updated === 'string' ? e.updated : '';
    const rawAuthor = e.author;
    const authorList: unknown[] = Array.isArray(rawAuthor)
      ? rawAuthor
      : rawAuthor
        ? [rawAuthor]
        : [];
    const authors: string[] = [];
    for (const a of authorList) {
      if (a && typeof a === 'object') {
        const name = (a as Record<string, unknown>).name;
        if (typeof name === 'string') authors.push(name);
      }
    }
    if (id.length === 0) continue;
    out.push({ id, title, summary, published, updated, authors });
  }
  return out;
}

async function arxivSearch(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<ArxivItem[]> {
  rejectUnknownKeys(params, new Set(['query', 'limit']));
  const query = requireString(params, 'query');
  const limit = requireLimit(params, ARXIV_LIMIT_MAX);
  const url = `${ARXIV_API_BASE}?search_query=${encodeURIComponent(
    query,
  )}&start=0&max_results=${limit}`;
  const response = await fetchWithRedirects({
    url,
    headers: {
      accept: 'application/atom+xml, application/xml;q=0.9',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
  });
  const entries = parseArxivFeed(response.body);
  const items: ArxivItem[] = [];
  for (const entry of entries) {
    const item: ArxivItem = {
      id: entry.id,
      url: entry.id,
      published: entry.published,
      updated: entry.updated,
      authors: entry.authors,
    };
    if (includeReader) {
      item.reader = await launder({
        raw: `${entry.title}\n\n${entry.summary}`,
        source: 'web_content',
        url: entry.id,
      });
    }
    items.push(item);
  }
  return items;
}

// ---------- github_search ----------

async function githubSearch(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubSearchItem[]> {
  rejectUnknownKeys(params, new Set(['query', 'limit']));
  const query = requireString(params, 'query');
  const limit = requireLimit(params, GITHUB_SEARCH_LIMIT_MAX);
  const token = requireEnv('GITHUB_TOKEN');
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&per_page=${limit}`;
  const obj = await fetchJsonObject(
    url,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
  );
  const itemsRaw = obj.items;
  if (!Array.isArray(itemsRaw)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'github search response missing items array',
    );
  }
  const out: GithubSearchItem[] = [];
  for (const repoRaw of itemsRaw.slice(0, limit)) {
    if (!repoRaw || typeof repoRaw !== 'object') continue;
    const repo = repoRaw as Record<string, unknown>;
    const id = typeof repo.id === 'number' ? repo.id : null;
    const fullName = typeof repo.full_name === 'string' ? repo.full_name : null;
    const htmlUrl = typeof repo.html_url === 'string' ? repo.html_url : null;
    const stars =
      typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null;
    const language = typeof repo.language === 'string' ? repo.language : null;
    const updatedAt =
      typeof repo.updated_at === 'string' ? repo.updated_at : null;
    if (id === null || fullName === null || htmlUrl === null) continue;
    const item: GithubSearchItem = {
      id,
      full_name: fullName,
      url: htmlUrl,
      stars: stars ?? 0,
      language,
      updated_at: updatedAt ?? '',
    };
    if (includeReader) {
      const description =
        typeof repo.description === 'string' ? repo.description : '';
      item.reader = await launder({
        raw: description.length > 0 ? description : '(no description)',
        source: 'web_content',
        url: htmlUrl,
      });
    }
    out.push(item);
  }
  return out;
}

// ---------- github_pr_list / github_issue_list shared ----------

interface GithubListRequest {
  owner: string;
  repo: string;
  state: string;
  since: string | undefined;
  limit: number;
}

function readGithubListRequest(
  params: Record<string, unknown>,
): GithubListRequest {
  rejectUnknownKeys(
    params,
    new Set(['owner', 'repo', 'state', 'since', 'limit']),
  );
  const owner = requireString(params, 'owner');
  const repo = requireString(params, 'repo');
  const stateRaw = optionalString(params, 'state') ?? 'open';
  if (!['open', 'closed', 'all'].includes(stateRaw)) {
    paramErr('state must be one of: open, closed, all');
  }
  // Paging makes the first row past `since` end the walk, so a malformed value
  // does not filter — it decides. 'yesterday' sorts above every ISO timestamp
  // and would return an empty list that reads exactly like an empty window.
  const since = optionalSince(params);
  const limit = requireLimit(params, GITHUB_LIST_LIMIT_MAX);
  return { owner, repo, state: stateRaw, since, limit };
}

/**
 * Fetches one page of a GitHub array-returning list endpoint. Rows are returned
 * exactly as served, unfiltered: the walk ends on a short page, and that has to
 * mean "GitHub ran out of rows", not "we dropped one".
 */
async function githubListPage(
  baseUrl: string,
  search: URLSearchParams,
  page: number,
  what: string,
  token: string,
  deps: Required<FetchUntrustedDeps>,
): Promise<unknown[]> {
  const paged = new URLSearchParams(search);
  paged.set('per_page', String(GITHUB_PAGE_SIZE));
  paged.set('page', String(page));
  const response = await fetchWithRedirects({
    url: `${baseUrl}?${paged.toString()}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
    maxBytes: GITHUB_LIST_MAX_BODY_BYTES,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedError(
      'fetch_failure',
      `${what} response was not json`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      `${what} response was not an array`,
    );
  }
  return parsed;
}

function readLogin(userRaw: unknown): string {
  if (!userRaw || typeof userRaw !== 'object') return '';
  const login = (userRaw as Record<string, unknown>).login;
  return typeof login === 'string' ? login : '';
}

/**
 * Walks a GitHub updated-desc list endpoint page by page until it has `limit`
 * items, the rows run out, or `since` ends the window.
 *
 * `build` maps one raw row to an item, or null to drop it (unparseable, or a PR
 * row on the issues leg). It cannot move: it runs after the `since` cutoff
 * because a dropped row must still be able to end the walk, and before the
 * dedup because only `build` can produce the `number` the dedup keys on.
 * Dropped rows never reach `out`, so they cost a row of input rather than a row
 * of the caller's `limit`.
 */
async function githubPagedList<
  T extends { number: number; url: string; reader?: ReaderOutput },
>(
  request: GithubListRequest,
  what: 'pulls' | 'issues',
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
  build: (row: Record<string, unknown>) => T | null,
): Promise<T[]> {
  const search = new URLSearchParams({
    state: request.state,
    sort: 'updated',
    direction: 'desc',
  });
  const url = `https://api.github.com/repos/${request.owner}/${request.repo}/${what}`;
  const token = requireEnv('GITHUB_TOKEN');
  const out: T[] = [];
  // A row updated between two page fetches moves toward page 1, so a row that
  // was on page N can reappear on page N+1. One request could not do this. The
  // reverse — an unseen row pushed back across a boundary already read — is
  // inherent to offset paging and needs cursors to fix.
  const seen = new Set<number>();
  // Scales with the ask, so a limit of 10 cannot spend a limit-of-100 budget.
  // ponytail: at limit 100 on an active repo this bursts up to 30 sequential
  // calls with no jitter. Add backoff if secondary-rate-limit 403s show up.
  const maxPages = Math.max(
    GITHUB_MIN_PAGES,
    Math.ceil((request.limit * GITHUB_LIST_OVERSCAN) / GITHUB_PAGE_SIZE),
  );
  for (let page = 1; page <= maxPages; page++) {
    const rows = await githubListPage(url, search, page, what, token, deps);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      // Cutoff before `build`: rows share one updated-desc sort, so the first
      // row older than `since` proves every row after it is older too — even on
      // the issues leg, where that row may be a PR `build` would have dropped.
      // Stop rather than skip: paging on would walk the repo's whole history to
      // find nothing.
      if (
        request.since &&
        typeof record.updated_at === 'string' &&
        record.updated_at < request.since
      ) {
        return out;
      }
      const item = build(record);
      if (item === null) continue;
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      if (includeReader) {
        const title = typeof record.title === 'string' ? record.title : '';
        item.reader = await launder({
          raw: title.length > 0 ? title : '(no title)',
          source: 'web_content',
          url: item.url,
        });
      }
      out.push(item);
      if (out.length >= request.limit) return out;
    }
    // A short page is the last page: the repo has fewer matching rows than
    // asked for, which is an answer, not a truncation.
    if (rows.length < GITHUB_PAGE_SIZE) return out;
  }
  throw new FetchUntrustedError(
    'fetch_failure',
    `${what} list exceeded its page ceiling before reaching limit; narrow the window with since, or lower limit`,
  );
}

function githubPrList(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubPrItem[]> {
  const request = readGithubListRequest(params);
  return githubPagedList<GithubPrItem>(
    request,
    'pulls',
    deps,
    includeReader,
    (pr) => {
      const number = typeof pr.number === 'number' ? pr.number : null;
      const htmlUrl = typeof pr.html_url === 'string' ? pr.html_url : null;
      const state = typeof pr.state === 'string' ? pr.state : null;
      if (number === null || htmlUrl === null || state === null) return null;
      return {
        number,
        url: htmlUrl,
        state,
        author: readLogin(pr.user),
        draft: typeof pr.draft === 'boolean' ? pr.draft : false,
        created_at: typeof pr.created_at === 'string' ? pr.created_at : '',
        updated_at: typeof pr.updated_at === 'string' ? pr.updated_at : '',
      };
    },
  );
}

function githubIssueList(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubIssueItem[]> {
  const request = readGithubListRequest(params);
  return githubPagedList<GithubIssueItem>(
    request,
    'issues',
    deps,
    includeReader,
    (issue) => {
      // GitHub's /issues endpoint returns PRs too; drop them. `limit` counts
      // issues that survive this filter.
      if (issue.pull_request !== undefined) return null;
      const number = typeof issue.number === 'number' ? issue.number : null;
      const htmlUrl =
        typeof issue.html_url === 'string' ? issue.html_url : null;
      const state = typeof issue.state === 'string' ? issue.state : null;
      if (number === null || htmlUrl === null || state === null) return null;
      const labelsRaw = issue.labels;
      const labels: string[] = Array.isArray(labelsRaw)
        ? labelsRaw
            .map((l) => {
              if (!l || typeof l !== 'object') return null;
              const name = (l as Record<string, unknown>).name;
              return typeof name === 'string' ? name : null;
            })
            .filter((n): n is string => n !== null)
        : [];
      return {
        number,
        url: htmlUrl,
        state,
        author: readLogin(issue.user),
        labels,
        created_at:
          typeof issue.created_at === 'string' ? issue.created_at : '',
        updated_at:
          typeof issue.updated_at === 'string' ? issue.updated_at : '',
      };
    },
  );
}

// ---------- github_run_list ----------

async function githubRunList(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubRunItem[]> {
  rejectUnknownKeys(
    params,
    new Set(['owner', 'repo', 'status', 'since', 'limit']),
  );
  const owner = requireString(params, 'owner');
  const repo = requireString(params, 'repo');
  const status = optionalString(params, 'status');
  // Not compared byte-wise like the other legs — this one hands `since` to
  // GitHub's `created` filter — but it takes the same param from the same
  // callers, so it takes the same guard. Unvalidated, `created=>=yesterday`
  // goes to GitHub.
  const since = optionalSince(params);
  const limit = requireLimit(params, GITHUB_LIST_LIMIT_MAX);
  const token = requireEnv('GITHUB_TOKEN');
  const search = new URLSearchParams({
    per_page: String(limit),
  });
  if (status !== undefined) search.set('status', status);
  if (since !== undefined) search.set('created', `>=${since}`);
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?${search.toString()}`;
  const obj = await fetchJsonObject(
    url,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
  );
  const runsRaw = obj.workflow_runs;
  if (!Array.isArray(runsRaw)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'runs response missing workflow_runs array',
    );
  }
  const out: GithubRunItem[] = [];
  for (const runRaw of runsRaw.slice(0, limit)) {
    if (!runRaw || typeof runRaw !== 'object') continue;
    const run = runRaw as Record<string, unknown>;
    const id = typeof run.id === 'number' ? run.id : null;
    const htmlUrl = typeof run.html_url === 'string' ? run.html_url : null;
    const statusValue = typeof run.status === 'string' ? run.status : null;
    const conclusion =
      typeof run.conclusion === 'string' ? run.conclusion : null;
    const headBranch =
      typeof run.head_branch === 'string' ? run.head_branch : '';
    const headSha = typeof run.head_sha === 'string' ? run.head_sha : '';
    const workflowId =
      typeof run.workflow_id === 'number' ? run.workflow_id : null;
    const createdAt =
      typeof run.created_at === 'string' ? run.created_at : null;
    if (
      id === null ||
      htmlUrl === null ||
      statusValue === null ||
      workflowId === null
    ) {
      continue;
    }
    const item: GithubRunItem = {
      id,
      url: htmlUrl,
      status: statusValue,
      conclusion,
      head_branch: headBranch,
      head_sha: headSha,
      workflow_id: workflowId,
      created_at: createdAt ?? '',
    };
    if (includeReader) {
      const name = typeof run.name === 'string' ? run.name : '';
      const displayTitle =
        typeof run.display_title === 'string' ? run.display_title : '';
      const raw =
        [name, displayTitle].filter((s) => s.length > 0).join(' — ') ||
        '(no name)';
      item.reader = await launder({
        raw,
        source: 'web_content',
        url: htmlUrl,
      });
    }
    out.push(item);
  }
  return out;
}

// ---------- notion_database_query ----------

interface NotionPostResponse {
  status: number;
  body: string;
}

function performNotionPost(args: {
  url: string;
  body: string;
  headers: Record<string, string>;
  deps: Required<FetchUntrustedDeps>;
}): Promise<NotionPostResponse> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let validated;
      try {
        validated = await validatePublicHttpsUrl(args.url, {
          lookup: args.deps.lookup,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const { parsed, resolvedAddress } = validated;
      const tcpHostname =
        resolvedAddress.includes(':') && !resolvedAddress.startsWith('[')
          ? `[${resolvedAddress}]`
          : resolvedAddress;
      const finalHeaders: Record<string, string> = { ...args.headers };
      if (finalHeaders.host === undefined && finalHeaders.Host === undefined) {
        finalHeaders.host = parsed.hostname;
      }
      finalHeaders['content-length'] = String(
        Buffer.byteLength(args.body, 'utf-8'),
      );
      const options: RequestOptions = {
        hostname: tcpHostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: finalHeaders,
        servername: parsed.hostname,
      };
      const req: ClientRequest = args.deps.httpsRequestFactory(options);
      const timer = setTimeout(() => {
        req.destroy(
          new FetchUntrustedTimeout(
            `fetch timed out after ${POST_TIMEOUT_MS}ms`,
          ),
        );
      }, POST_TIMEOUT_MS);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            aborted = true;
            req.destroy(new Error('response body exceeded cap'));
            clearTimeout(timer);
            reject(new FetchUntrustedError('fetch_failure', 'body too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.write(args.body);
      req.end();
    })();
  });
}

async function notionPostResults(args: {
  url: string;
  body: string;
  token: string;
  deps: Required<FetchUntrustedDeps>;
}): Promise<unknown[]> {
  let response: NotionPostResponse;
  try {
    response = await performNotionPost({
      url: args.url,
      body: args.body,
      headers: {
        authorization: `Bearer ${args.token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
      },
      deps: args.deps,
    });
  } catch (err) {
    if (err instanceof FetchUntrustedError) throw err;
    const message = err instanceof Error ? err.message : 'http request failed';
    throw new FetchUntrustedError('fetch_failure', message);
  }
  if (response.status < 200 || response.status >= 300) {
    throwForNon2xxStatus(
      response.status,
      `notion returned non-2xx status ${response.status}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedMalformed('notion response was not json');
  }
  if (!isPlainObject(parsed)) {
    throw new FetchUntrustedMalformed('notion response was not an object');
  }
  const resultsRaw = parsed.results;
  if (!Array.isArray(resultsRaw)) {
    throw new FetchUntrustedMalformed('notion response missing results array');
  }
  return resultsRaw;
}

async function notionDatabaseQuery(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<NotionDatabaseItem[]> {
  rejectUnknownKeys(params, new Set(['database_id', 'filter', 'limit']));
  // Laundering the whole properties blob broke the reader's scalars-only/
  // 200-char output contract on rich rows (a date property paraphrases back as
  // an object, a wide row as a >200-char value), which 502'd the entire query.
  // Callers were already forbidden to surface the per-item reader here anyway.
  // Reject rather than ignore, so a caller asking for prose is sent to the
  // notion_page read instead of silently receiving ids.
  if (includeReader) {
    paramErr(
      'include_reader is not supported for notion_database_query; page-read each id with fetch_untrusted + notion_page for the laundered view',
    );
  }
  const databaseId = requireString(params, 'database_id');
  const limit = requireLimit(params, NOTION_LIMIT_MAX);
  const filter = params.filter;
  if (filter !== undefined && !isPlainObject(filter)) {
    paramErr('filter must be a JSON object when provided');
  }
  const token = requireEnv('NOTION_API_KEY');
  const url = `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`;
  const requestBody: Record<string, unknown> = { page_size: limit };
  if (filter !== undefined) requestBody.filter = filter;
  const resultsRaw = await notionPostResults({
    url,
    body: JSON.stringify(requestBody),
    token,
    deps,
  });
  const out: NotionDatabaseItem[] = [];
  for (const pageRaw of resultsRaw.slice(0, limit)) {
    if (!pageRaw || typeof pageRaw !== 'object') continue;
    const page = pageRaw as Record<string, unknown>;
    const id = typeof page.id === 'string' ? page.id : null;
    const pageUrl = typeof page.url === 'string' ? page.url : null;
    const createdTime =
      typeof page.created_time === 'string' ? page.created_time : null;
    const lastEditedTime =
      typeof page.last_edited_time === 'string' ? page.last_edited_time : null;
    const archived = typeof page.archived === 'boolean' ? page.archived : false;
    if (id === null || pageUrl === null) continue;
    const item: NotionDatabaseItem = {
      id,
      url: pageUrl,
      created_time: createdTime ?? '',
      last_edited_time: lastEditedTime ?? '',
      archived,
    };
    out.push(item);
  }
  return out;
}

// ---------- notion_search ----------

function concatPlainText(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((span) =>
      isPlainObject(span) && typeof span.plain_text === 'string'
        ? span.plain_text
        : '',
    )
    .join('');
}

function extractNotionSearchTitle(
  result: Record<string, unknown>,
  object: 'page' | 'database',
): string {
  if (object === 'database') {
    return concatPlainText(result.title);
  }
  const properties = result.properties;
  if (!isPlainObject(properties)) return '';
  for (const value of Object.values(properties)) {
    if (isPlainObject(value) && value.type === 'title') {
      return concatPlainText(value.title);
    }
  }
  return '';
}

async function notionSearch(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<NotionSearchItem[]> {
  rejectUnknownKeys(params, new Set(['query', 'object_kind', 'limit']));
  const query = requireString(params, 'query');
  const objectKind = requireString(params, 'object_kind');
  if (objectKind !== 'page' && objectKind !== 'database') {
    paramErr('object_kind must be one of: page, database');
  }
  const limit = requireLimit(params, NOTION_LIMIT_MAX);
  const token = requireEnv('NOTION_API_KEY');
  const resultsRaw = await notionPostResults({
    url: 'https://api.notion.com/v1/search',
    body: JSON.stringify({
      query,
      page_size: limit,
      filter: { property: 'object', value: objectKind },
    }),
    token,
    deps,
  });
  // items.length is the caller's exact match signal: 1 == unique, ==limit ==
  // "too broad, refine". It stays exact because a row that fails to parse (bad
  // id/url, wrong object kind) throws rather than being dropped, so the count
  // of in-window rows never silently under-counts. has_more is deliberately
  // not surfaced: it would only sharpen the exactly-limit boundary, where
  // "refine" is already the correct instruction, at the cost of changing the
  // shared result envelope.
  const out: NotionSearchItem[] = [];
  // Backstop only: page_size already caps the request; this trims an
  // over-return from Notion, never the caller's in-window matches.
  for (const result of resultsRaw.slice(0, limit)) {
    if (!isPlainObject(result)) {
      throw new FetchUntrustedMalformed(
        'notion search result was not an object',
      );
    }
    if (result.object !== objectKind) {
      throw new FetchUntrustedMalformed(
        'notion search result object kind did not match the request',
      );
    }
    const id = typeof result.id === 'string' ? result.id : null;
    const resultUrl = typeof result.url === 'string' ? result.url : null;
    if (id === null || resultUrl === null) {
      throw new FetchUntrustedMalformed(
        'notion search result missing id or url',
      );
    }
    const item: NotionSearchItem = {
      id,
      url: resultUrl,
      object: objectKind,
    };
    if (includeReader) {
      // Launder only the title, deliberately narrower than notionDatabaseQuery's
      // full-`properties` launder: search only needs the title to
      // rank/disambiguate, so narrowing the laundered text shrinks the
      // prompt-injection surface (sagri-ai#119). Do not widen this to full
      // properties.
      const title = extractNotionSearchTitle(result, objectKind);
      // Laundered serially (like notionDatabaseQuery); parallelizing across
      // results would risk tripping Notion rate limits.
      item.reader = await launder({
        // Database results carry source 'notion_page' because the reader
        // pipeline has no 'notion_database' source; this is provenance labeling,
        // not a security classification (notion_page is not in ADMIN_SOURCES).
        raw: title.length > 0 ? title : '(untitled)',
        source: 'notion_page',
        url: resultUrl,
      });
    }
    out.push(item);
  }
  return out;
}

// ---------- top-level entrypoint ----------

function validateInput(input: unknown): FetchUntrustedListInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    paramErr('params must be an object');
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.source_type !== 'string' ||
    !VALID_LIST_SOURCE_TYPES.has(record.source_type as ListSourceType)
  ) {
    paramErr(
      `source_type must be one of: ${[...VALID_LIST_SOURCE_TYPES].join(', ')}`,
    );
  }
  const params = record.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    paramErr('params must be a JSON object');
  }
  const includeReaderRaw = record.include_reader;
  if (includeReaderRaw !== undefined && typeof includeReaderRaw !== 'boolean') {
    paramErr('include_reader must be a boolean when provided');
  }
  const allowed = new Set(['source_type', 'params', 'include_reader']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) paramErr(`unknown top-level param: ${key}`);
  }
  return {
    source_type: record.source_type as ListSourceType,
    params: params as Record<string, unknown>,
    include_reader: includeReaderRaw === true,
  };
}

export async function fetchUntrustedList(
  rawInput: unknown,
  depsInput?: FetchUntrustedDeps,
): Promise<FetchUntrustedListResult> {
  const input = validateInput(rawInput);
  const deps = resolveDeps(depsInput);
  const includeReader = input.include_reader;
  let items: ListItem[];
  switch (input.source_type) {
    case 'arxiv_search':
      items = await arxivSearch(input.params, deps, includeReader);
      break;
    case 'github_search':
      items = await githubSearch(input.params, deps, includeReader);
      break;
    case 'github_pr_list':
      items = await githubPrList(input.params, deps, includeReader);
      break;
    case 'github_issue_list':
      items = await githubIssueList(input.params, deps, includeReader);
      break;
    case 'github_run_list':
      items = await githubRunList(input.params, deps, includeReader);
      break;
    case 'notion_database_query':
      items = await notionDatabaseQuery(input.params, deps, includeReader);
      break;
    case 'notion_search':
      items = await notionSearch(input.params, deps, includeReader);
      break;
    default: {
      const _exhaustive: never = input.source_type;
      throw new Error(`unreachable source_type: ${_exhaustive as string}`);
    }
  }
  return { items };
}

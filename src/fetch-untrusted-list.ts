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

// Convicts a nested struct, which is what JSON.stringify(properties) is: every
// key of the blob that broke prod wraps its value in a title/rich_text array.
// Nesting is the discriminator, not parseability, and not a leading brace. See
// launder() for why a conviction has to be this narrow.
//
// Three shapes are deliberately acquitted, each because convicting it costs a
// batch and none is the blob:
//   '{redacted} ...'    prose that opens a brace, so parse rather than sniff
//   '[404]'             a field that is entirely an array literal, a human's
//                       prose more often than a blob. The cost is real: a
//                       widening to JSON.stringify(labels) (a string[] already
//                       in scope in githubIssueList) slips through, short and
//                       bracket-opened. A flat label array is nothing like the
//                       nested blob that broke prod.
//   '{"status":"done"}' a flat scalar map, which is a title a human types
//
// The flat-map acquittal is narrower than it looks. It is proven only for a
// short map: the reader also throws above MAX_EXTRACTED_KEYS or on a value past
// MAX_EXTRACTED_VALUE_LENGTH, and neither is nested, so a wide or long-valued
// flat map still reaches the reader and still fails the batch there. No adapter
// sends one today; a guard for input nothing sends would be speculative, so the
// gap is named rather than closed (sagri-ai#483).
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

interface GithubListEnvelope {
  owner: string;
  repo: string;
  state: string;
  since: string | undefined;
  limit: number;
}

function readGithubListEnvelope(
  params: Record<string, unknown>,
): GithubListEnvelope {
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
  const since = optionalString(params, 'since');
  const limit = requireLimit(params, GITHUB_LIST_LIMIT_MAX);
  return { owner, repo, state: stateRaw, since, limit };
}

async function githubPrList(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubPrItem[]> {
  const env = readGithubListEnvelope(params);
  const token = requireEnv('GITHUB_TOKEN');
  const search = new URLSearchParams({
    state: env.state,
    per_page: String(env.limit),
    sort: 'updated',
    direction: 'desc',
  });
  const url = `https://api.github.com/repos/${env.owner}/${env.repo}/pulls?${search.toString()}`;
  const response = await fetchWithRedirects({
    url,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedError(
      'fetch_failure',
      'pulls response was not json',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'pulls response was not an array',
    );
  }
  const out: GithubPrItem[] = [];
  for (const prRaw of parsed.slice(0, env.limit)) {
    if (!prRaw || typeof prRaw !== 'object') continue;
    const pr = prRaw as Record<string, unknown>;
    if (
      env.since &&
      typeof pr.updated_at === 'string' &&
      pr.updated_at < env.since
    ) {
      continue;
    }
    const number = typeof pr.number === 'number' ? pr.number : null;
    const htmlUrl = typeof pr.html_url === 'string' ? pr.html_url : null;
    const state = typeof pr.state === 'string' ? pr.state : null;
    const draft = typeof pr.draft === 'boolean' ? pr.draft : false;
    const createdAt = typeof pr.created_at === 'string' ? pr.created_at : null;
    const updatedAt = typeof pr.updated_at === 'string' ? pr.updated_at : null;
    const userRaw = pr.user;
    const author =
      userRaw && typeof userRaw === 'object'
        ? typeof (userRaw as Record<string, unknown>).login === 'string'
          ? ((userRaw as Record<string, unknown>).login as string)
          : ''
        : '';
    if (number === null || htmlUrl === null || state === null) continue;
    const item: GithubPrItem = {
      number,
      url: htmlUrl,
      state,
      author,
      draft,
      created_at: createdAt ?? '',
      updated_at: updatedAt ?? '',
    };
    if (includeReader) {
      const title = typeof pr.title === 'string' ? pr.title : '';
      item.reader = await launder({
        raw: title.length > 0 ? title : '(no title)',
        source: 'web_content',
        url: htmlUrl,
      });
    }
    out.push(item);
  }
  return out;
}

async function githubIssueList(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<GithubIssueItem[]> {
  const env = readGithubListEnvelope(params);
  const token = requireEnv('GITHUB_TOKEN');
  const search = new URLSearchParams({
    state: env.state,
    per_page: String(env.limit),
    sort: 'updated',
    direction: 'desc',
  });
  const url = `https://api.github.com/repos/${env.owner}/${env.repo}/issues?${search.toString()}`;
  const response = await fetchWithRedirects({
    url,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
    },
    deps,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedError(
      'fetch_failure',
      'issues response was not json',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'issues response was not an array',
    );
  }
  const out: GithubIssueItem[] = [];
  for (const issueRaw of parsed.slice(0, env.limit)) {
    if (!issueRaw || typeof issueRaw !== 'object') continue;
    const issue = issueRaw as Record<string, unknown>;
    // GitHub's /issues endpoint returns PRs too; filter them out.
    if (issue.pull_request !== undefined) continue;
    if (
      env.since &&
      typeof issue.updated_at === 'string' &&
      issue.updated_at < env.since
    ) {
      continue;
    }
    const number = typeof issue.number === 'number' ? issue.number : null;
    const htmlUrl = typeof issue.html_url === 'string' ? issue.html_url : null;
    const state = typeof issue.state === 'string' ? issue.state : null;
    const createdAt =
      typeof issue.created_at === 'string' ? issue.created_at : null;
    const updatedAt =
      typeof issue.updated_at === 'string' ? issue.updated_at : null;
    const userRaw = issue.user;
    const author =
      userRaw && typeof userRaw === 'object'
        ? typeof (userRaw as Record<string, unknown>).login === 'string'
          ? ((userRaw as Record<string, unknown>).login as string)
          : ''
        : '';
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
    if (number === null || htmlUrl === null || state === null) continue;
    const item: GithubIssueItem = {
      number,
      url: htmlUrl,
      state,
      author,
      labels,
      created_at: createdAt ?? '',
      updated_at: updatedAt ?? '',
    };
    if (includeReader) {
      const title = typeof issue.title === 'string' ? issue.title : '';
      item.reader = await launder({
        raw: title.length > 0 ? title : '(no title)',
        source: 'web_content',
        url: htmlUrl,
      });
    }
    out.push(item);
  }
  return out;
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
  const since = optionalString(params, 'since');
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

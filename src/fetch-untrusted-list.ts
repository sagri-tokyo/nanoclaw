/**
 * List-source adapters that complement `fetchUntrusted`. Each adapter fetches
 * a paginated upstream list (arXiv search, GitHub repo/PR/issue/run lists,
 * Notion database query) and returns a structured list. Constrained fields
 * (numeric ids, urls, ISO timestamps, GitHub logins) are always surfaced raw
 * on each item.
 *
 * By default, each item's free-text fields (titles, descriptions, abstracts,
 * Notion page properties) are dropped entirely — they never reach the agent
 * and the host-side reader pipeline (`readUntrustedContent`) is not invoked.
 * Callers that need a laundered paraphrase to rank or summarize items pass
 * `include_reader: true`; for those callers the free-text body is run through
 * the reader pipeline and the resulting `ReaderOutput` is attached as
 * `items[].reader`. See sagri-ai#119 for the threat model — the prior
 * always-launder behavior surfaced attacker-influenced wording in
 * `reader.intent` / `reader.extracted_data`, which the agent treated as
 * trusted context even though the prompt instructed otherwise.
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
  fetchJsonObject,
  fetchWithRedirects,
  requireEnv,
  resolveDeps,
  validatePublicHttpsUrl,
} from './fetch-untrusted.js';
import { logger } from './logger.js';
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
  | 'notion_database_query';

const VALID_LIST_SOURCE_TYPES: ReadonlySet<ListSourceType> = new Set([
  'arxiv_search',
  'github_search',
  'github_pr_list',
  'github_issue_list',
  'github_run_list',
  'notion_database_query',
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
  reader?: ReaderOutput;
}

export type ListItem =
  | ArxivItem
  | GithubSearchItem
  | GithubPrItem
  | GithubIssueItem
  | GithubRunItem
  | NotionDatabaseItem;

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

async function launder(args: {
  raw: string;
  source: 'web_content' | 'github_issue' | 'github_comment' | 'notion_page';
  url: string;
}): Promise<ReaderOutput> {
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
        req.destroy(new Error(`fetch timed out after ${POST_TIMEOUT_MS}ms`));
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

async function notionDatabaseQuery(
  params: Record<string, unknown>,
  deps: Required<FetchUntrustedDeps>,
  includeReader: boolean,
): Promise<NotionDatabaseItem[]> {
  rejectUnknownKeys(params, new Set(['database_id', 'filter', 'limit']));
  const databaseId = requireString(params, 'database_id');
  const limit = requireLimit(params, NOTION_LIMIT_MAX);
  const filter = params.filter;
  if (
    filter !== undefined &&
    (filter === null || typeof filter !== 'object' || Array.isArray(filter))
  ) {
    paramErr('filter must be a JSON object when provided');
  }
  const token = requireEnv('NOTION_API_KEY');
  const url = `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`;
  const requestBody: Record<string, unknown> = { page_size: limit };
  if (filter !== undefined) requestBody.filter = filter;
  let response: NotionPostResponse;
  try {
    response = await performNotionPost({
      url,
      body: JSON.stringify(requestBody),
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'nanoclaw-fetch-untrusted-list/1.0',
      },
      deps,
    });
  } catch (err) {
    if (err instanceof FetchUntrustedError) throw err;
    const message = err instanceof Error ? err.message : 'http request failed';
    throw new FetchUntrustedError('fetch_failure', message);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FetchUntrustedError(
      'fetch_failure',
      `notion returned non-2xx status ${response.status}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedError(
      'fetch_failure',
      'notion response was not json',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'notion response was not an object',
    );
  }
  const resultsRaw = (parsed as Record<string, unknown>).results;
  if (!Array.isArray(resultsRaw)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'notion response missing results array',
    );
  }
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
    if (includeReader) {
      const properties = page.properties ?? {};
      item.reader = await launder({
        raw: JSON.stringify(properties),
        source: 'notion_page',
        url: pageUrl,
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
    default: {
      const _exhaustive: never = input.source_type;
      throw new Error(`unreachable source_type: ${_exhaustive as string}`);
    }
  }
  return { items };
}

/**
 * Fetch + launder untrusted content from external sources (web pages, GitHub
 * issues/comments, Notion pages). Each adapter does the minimum needed to get
 * a string of raw bytes, then forwards them to the existing reader pipeline
 * via `readUntrustedContent`. Raw bytes never leave this module — only the
 * structured ReaderOutput escapes.
 *
 * SSRF defence is implemented per-request:
 *   - HTTPS scheme only (never http, file, ftp, ...)
 *   - hostname must resolve to a public address (no RFC1918, loopback,
 *     link-local, ::1, fc00::/7, fe80::/10, 0.0.0.0, CGNAT 100.64.0.0/10)
 *   - redirects are re-validated through the same checks
 *   - the connection is made to the resolved IP (not the hostname) so the
 *     OS resolver can't be flipped between validation and connect
 *
 * sagri-ai#86 PR-A.
 */
import dns from 'dns';
import { request as httpsRequest, RequestOptions } from 'https';
import { ClientRequest } from 'http';
import { URL } from 'url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  readUntrustedContent,
  type ReaderOutput,
  type SourceMetadata,
} from './reader.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const NOTION_VERSION = '2022-06-28';

export type FetchUntrustedSourceType =
  | 'web_content'
  | 'github_issue'
  | 'github_comment'
  | 'notion_page';

export type FetchUntrustedErrorCode =
  | 'invalid_params'
  | 'bad_url'
  | 'fetch_failure'
  | 'reader_failure';

export class FetchUntrustedError extends Error {
  constructor(
    readonly code: FetchUntrustedErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchUntrustedInput {
  url_or_id: string;
  source_type: FetchUntrustedSourceType;
}

export interface FetchUntrustedDeps {
  lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }>;
  httpsRequestFactory?: (options: RequestOptions) => ClientRequest;
}

const VALID_SOURCE_TYPES: ReadonlySet<FetchUntrustedSourceType> = new Set([
  'web_content',
  'github_issue',
  'github_comment',
  'notion_page',
]);

const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;
const COMMENT_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/;

function defaultLookup(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: false }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family: family as 4 | 6 });
    });
  });
}

function ipv4InCidr(ip: string, prefix: string, bits: number): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  const prefixParts = prefix.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const ipNum =
    (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const prefixNum =
    (prefixParts[0] << 24) |
    (prefixParts[1] << 16) |
    (prefixParts[2] << 8) |
    prefixParts[3];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (prefixNum & mask);
}

function isPrivateIpv4(ip: string): boolean {
  if (ip === '0.0.0.0') return true;
  if (ipv4InCidr(ip, '127.0.0.0', 8)) return true;
  if (ipv4InCidr(ip, '10.0.0.0', 8)) return true;
  if (ipv4InCidr(ip, '172.16.0.0', 12)) return true;
  if (ipv4InCidr(ip, '192.168.0.0', 16)) return true;
  if (ipv4InCidr(ip, '169.254.0.0', 16)) return true;
  if (ipv4InCidr(ip, '100.64.0.0', 10)) return true; // CGNAT (RFC 6598)
  return false;
}

// Mask is applied to the first 16-bit group, which preserves the leading byte
// in canonical compressed forms (e.g. fdab::1), so fc00::/7 and fe80::/10 are
// caught without expanding the address.
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return true;
  const firstGroup = lower.split(':')[0];
  // Bare leading ':' means an empty first group (e.g. "::ffff:..."): the
  // address starts with the all-zeros prefix, not in fc00::/7 or fe80::/10.
  // Treat empty first group as 0 so it falls through to the public branch.
  const value = firstGroup.length === 0 ? 0 : parseInt(firstGroup, 16);
  if (Number.isNaN(value)) return false;
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

function isPrivateAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return isPrivateIpv4(address);
  return isPrivateIpv6(address);
}

function isLiteralIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = [m[1], m[2], m[3], m[4]].map((p) => parseInt(p, 10));
  return parts.every((p) => p >= 0 && p <= 255);
}

function isLiteralIpv6(host: string): string | null {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return null;
}

interface ValidatedUrl {
  parsed: URL;
  resolvedAddress: string;
}

async function validatePublicHttpsUrl(
  url: string,
  deps: Required<Pick<FetchUntrustedDeps, 'lookup'>>,
): Promise<ValidatedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchUntrustedError('bad_url', 'invalid url');
  }
  if (parsed.protocol !== 'https:') {
    throw new FetchUntrustedError('bad_url', 'scheme must be https');
  }
  if (!parsed.hostname) {
    throw new FetchUntrustedError('bad_url', 'hostname is empty');
  }

  if (isLiteralIpv4(parsed.hostname)) {
    if (isPrivateIpv4(parsed.hostname)) {
      throw new FetchUntrustedError('bad_url', 'hostname is a private address');
    }
    return { parsed, resolvedAddress: parsed.hostname };
  }
  const literalV6 = isLiteralIpv6(parsed.hostname);
  if (literalV6 !== null) {
    if (isPrivateIpv6(literalV6)) {
      throw new FetchUntrustedError('bad_url', 'hostname is a private address');
    }
    return { parsed, resolvedAddress: literalV6 };
  }

  let resolved: { address: string; family: 4 | 6 };
  try {
    resolved = await deps.lookup(parsed.hostname);
  } catch {
    throw new FetchUntrustedError('bad_url', 'hostname could not be resolved');
  }
  if (isPrivateAddress(resolved.address, resolved.family)) {
    throw new FetchUntrustedError(
      'bad_url',
      'hostname resolves to a private address',
    );
  }
  return { parsed, resolvedAddress: resolved.address };
}

interface FetchedResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  finalUrl: URL;
}

function performHttpsGet(args: {
  validated: ValidatedUrl;
  headers: Record<string, string>;
  deps: Required<Pick<FetchUntrustedDeps, 'httpsRequestFactory'>>;
}): Promise<FetchedResponse> {
  const { validated, headers, deps } = args;
  const { parsed, resolvedAddress } = validated;
  return new Promise((resolve, reject) => {
    // Bracket IPv6 literals when handing them to Node's http(s) layer.
    const tcpHostname =
      resolvedAddress.includes(':') && !resolvedAddress.startsWith('[')
        ? `[${resolvedAddress}]`
        : resolvedAddress;
    const finalHeaders: Record<string, string> = { ...headers };
    if (finalHeaders.host === undefined && finalHeaders.Host === undefined) {
      finalHeaders.host = parsed.hostname;
    }
    const req = deps.httpsRequestFactory({
      hostname: tcpHostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: finalHeaders,
      servername: parsed.hostname,
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`fetch timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);
    req.on('response', (res) => {
      const responseHeaders = res.headers as Record<
        string,
        string | string[] | undefined
      >;
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
          headers: responseHeaders,
          finalUrl: parsed,
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
    req.end();
  });
}

interface FollowRedirectArgs {
  url: string;
  headers: Record<string, string>;
  deps: Required<FetchUntrustedDeps>;
}

async function fetchWithRedirects(
  args: FollowRedirectArgs,
): Promise<FetchedResponse> {
  const { headers, deps } = args;
  let currentUrl = args.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await validatePublicHttpsUrl(currentUrl, deps);
    let response: FetchedResponse;
    try {
      response = await performHttpsGet({ validated, headers, deps });
    } catch (err) {
      if (err instanceof FetchUntrustedError) throw err;
      const message =
        err instanceof Error ? err.message : 'http request failed';
      throw new FetchUntrustedError('fetch_failure', message);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== 'string' || location.length === 0) {
        throw new FetchUntrustedError(
          'fetch_failure',
          'redirect without Location header',
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FetchUntrustedError(
        'fetch_failure',
        `target returned non-2xx status ${response.status}`,
      );
    }
    return response;
  }
  throw new FetchUntrustedError('fetch_failure', 'too many redirects');
}

function resolveDeps(deps?: FetchUntrustedDeps): Required<FetchUntrustedDeps> {
  return {
    lookup: deps?.lookup ?? defaultLookup,
    httpsRequestFactory: deps?.httpsRequestFactory ?? httpsRequest,
  };
}

function requireEnv(name: string): string {
  const env = readEnvFile([name]);
  const value = env[name];
  if (!value) {
    throw new FetchUntrustedError('fetch_failure', `${name} not configured`);
  }
  return value;
}

async function fetchJsonObject(
  url: string,
  headers: Record<string, string>,
  deps: Required<FetchUntrustedDeps>,
): Promise<Record<string, unknown>> {
  const response = await fetchWithRedirects({ url, headers, deps });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new FetchUntrustedError('fetch_failure', 'response was not json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FetchUntrustedError(
      'fetch_failure',
      'response was not an object',
    );
  }
  return parsed as Record<string, unknown>;
}

interface ParsedNotionId {
  canonicalId: string;
  canonicalUrl: string;
}

function parseNotionInput(input: string): ParsedNotionId {
  const trimmed = input.trim();
  // Bare 32-hex (with or without dashes)
  const stripped = trimmed.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
    const canonicalId = stripped.toLowerCase();
    return {
      canonicalId,
      canonicalUrl: `https://www.notion.so/${canonicalId}`,
    };
  }
  // URL form must contain a 32-hex run somewhere
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FetchUntrustedError('bad_url', 'not a notion id or url');
  }
  if (parsed.hostname !== 'www.notion.so' && parsed.hostname !== 'notion.so') {
    throw new FetchUntrustedError('bad_url', 'not a notion url');
  }
  // Notion URL convention: id is the trailing 32-hex chars of the final path
  // segment (after the slug). Anchor the match at the end so non-id hex chars
  // earlier in the slug can't shadow the real id.
  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  const stripDashes = lastSegment.replace(/-/g, '');
  const m = stripDashes.match(/([0-9a-fA-F]{32})$/);
  if (!m) {
    throw new FetchUntrustedError('bad_url', 'no notion id found in url');
  }
  return {
    canonicalId: m[1].toLowerCase(),
    canonicalUrl: trimmed,
  };
}

async function fetchWebContent(
  url: string,
  deps: Required<FetchUntrustedDeps>,
): Promise<{ raw: string; provenanceUrl: string }> {
  const response = await fetchWithRedirects({
    url,
    headers: {
      accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.8',
      'user-agent': 'nanoclaw-fetch-untrusted/1.0',
    },
    deps,
  });
  return { raw: response.body, provenanceUrl: url };
}

async function fetchGithubIssue(
  url: string,
  deps: Required<FetchUntrustedDeps>,
): Promise<{ raw: string; provenanceUrl: string }> {
  const m = url.match(ISSUE_URL_RE);
  if (!m) {
    throw new FetchUntrustedError(
      'bad_url',
      'github issue url must be /issues/N',
    );
  }
  const [, owner, repo, number] = m;
  const token = requireEnv('GITHUB_TOKEN');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const obj = await fetchJsonObject(
    apiUrl,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted/1.0',
    },
    deps,
  );
  const title = typeof obj.title === 'string' ? obj.title : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  return { raw: `${title}\n\n${body}`, provenanceUrl: url };
}

async function fetchGithubComment(
  url: string,
  deps: Required<FetchUntrustedDeps>,
): Promise<{ raw: string; provenanceUrl: string }> {
  const m = url.match(COMMENT_URL_RE);
  if (!m) {
    throw new FetchUntrustedError(
      'bad_url',
      'github comment url must contain #issuecomment-<id>',
    );
  }
  const [, owner, repo, , commentId] = m;
  const token = requireEnv('GITHUB_TOKEN');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;
  const obj = await fetchJsonObject(
    apiUrl,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nanoclaw-fetch-untrusted/1.0',
    },
    deps,
  );
  const body = typeof obj.body === 'string' ? obj.body : '';
  return { raw: body, provenanceUrl: url };
}

async function fetchNotionPage(
  input: string,
  deps: Required<FetchUntrustedDeps>,
): Promise<{ raw: string; provenanceUrl: string }> {
  const { canonicalId, canonicalUrl } = parseNotionInput(input);
  const token = requireEnv('NOTION_API_KEY');
  const apiUrl = `https://api.notion.com/v1/pages/${canonicalId}`;
  const obj = await fetchJsonObject(
    apiUrl,
    {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      accept: 'application/json',
      'user-agent': 'nanoclaw-fetch-untrusted/1.0',
    },
    deps,
  );
  const properties = obj.properties ?? {};
  return {
    raw: JSON.stringify(properties),
    provenanceUrl: canonicalUrl,
  };
}

function validateInput(input: unknown): FetchUntrustedInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FetchUntrustedError('invalid_params', 'params must be an object');
  }
  const record = input as Record<string, unknown>;
  if (typeof record.url_or_id !== 'string' || record.url_or_id.length === 0) {
    throw new FetchUntrustedError(
      'invalid_params',
      'url_or_id must be a non-empty string',
    );
  }
  if (
    typeof record.source_type !== 'string' ||
    !VALID_SOURCE_TYPES.has(record.source_type as FetchUntrustedSourceType)
  ) {
    throw new FetchUntrustedError(
      'invalid_params',
      `source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`,
    );
  }
  const allowed = new Set(['url_or_id', 'source_type']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new FetchUntrustedError('invalid_params', `unknown param: ${key}`);
    }
  }
  return {
    url_or_id: record.url_or_id,
    source_type: record.source_type as FetchUntrustedSourceType,
  };
}

/**
 * Fetch untrusted content from one of the supported sources, then run the raw
 * bytes through the existing reader pipeline. Returns a ReaderOutput. Raw
 * bytes never escape this function — only the structured output, which has
 * been classified by the reader and bounded by the post-validation caps in
 * reader.ts.
 *
 * Throws FetchUntrustedError on any failure. Callers (reader-rpc) translate
 * to RPC error codes.
 */
export async function fetchUntrusted(
  rawInput: unknown,
  depsInput?: FetchUntrustedDeps,
): Promise<ReaderOutput> {
  const input = validateInput(rawInput);
  const deps = resolveDeps(depsInput);

  let fetched: { raw: string; provenanceUrl: string };
  switch (input.source_type) {
    case 'web_content':
      fetched = await fetchWebContent(input.url_or_id, deps);
      break;
    case 'github_issue':
      fetched = await fetchGithubIssue(input.url_or_id, deps);
      break;
    case 'github_comment':
      fetched = await fetchGithubComment(input.url_or_id, deps);
      break;
    case 'notion_page':
      fetched = await fetchNotionPage(input.url_or_id, deps);
      break;
    default: {
      const _exhaustive: never = input.source_type;
      throw new Error(`unreachable source_type: ${_exhaustive as string}`);
    }
  }

  const sourceMetadata: SourceMetadata = { url: fetched.provenanceUrl };
  try {
    return await readUntrustedContent({
      raw: fetched.raw,
      source: input.source_type,
      sourceMetadata,
    });
  } catch (err) {
    // Mirror handleReadUntrusted: never propagate the upstream message body
    // (which could echo the untrusted input) back to the caller. Log the
    // error internally; the err object itself does not contain credentials
    // because reader.ts deliberately strips them from its thrown errors.
    logger.error({ err }, 'fetch-untrusted: reader pipeline failed');
    throw new FetchUntrustedError('reader_failure', 'reader pipeline failed');
  }
}

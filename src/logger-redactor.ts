/**
 * Fail-closed value-redaction sentinel (sagri-tokyo/sagri-ai#143).
 *
 * Every `logger.*` entrypoint routes its payload through
 * `assertNoSensitiveValues` before serialisation. If any string in the payload
 * matches a known secret shape (Anthropic key, Slack token, GitHub PAT, Notion
 * integration token, AWS access key id, or a `Bearer` header), the log call
 * throws instead of emitting — a secret never reaches stdout/stderr.
 *
 * The thrown `SensitiveValueError` names the offending field and carries a
 * short sha256 preview of the match. It never echoes the raw value, so the
 * exception itself is safe to log (the logger scans it like any other payload
 * and finds only a hash).
 *
 * Complements the existing `checkAnthropicApiKeyLeak` in logger.ts, which scans
 * for the literal configured `ANTHROPIC_API_KEY` value rather than a shape.
 */
import { createHash } from 'crypto';

// Regex-based only, no dependencies (#143 acceptance). Length floors keep the
// shapes specific enough that ordinary prose does not trip them, while staying
// broad within each vendor's prefix (fail-closed: over-match beats under-match).
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  // xoxb/xoxa/xoxp/xoxc/... bot, app, user and legacy Slack tokens.
  { name: 'slack-token', re: /xox[a-z]-[A-Za-z0-9-]{10,}/ },
  { name: 'slack-app-token', re: /xapp-[A-Za-z0-9-]{10,}/ },
  { name: 'github-pat-classic', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat-fine-grained', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  // Legacy `secret_` and current `ntn_` Notion integration-token prefixes.
  // Leading boundary so `mysecret_...` (prefix mid-word) does not match.
  {
    name: 'notion-token',
    re: /(?<![A-Za-z0-9])(?:secret_|ntn_)[A-Za-z0-9]{20,}/,
  },
  // AKIA long-term keys and ASIA STS/temporary credentials (fixed 20-char shape).
  // Boundaries on both sides so the key is not matched inside a longer
  // uppercase/digit run (a base32 blob, an uppercase hash) — a false positive
  // here throws into the caller, so precision is safety-critical.
  {
    name: 'aws-access-key-id',
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/,
  },
  // Require a token-shaped value after `Bearer` so "Bearer prefix missing" and
  // other prose does not throw; real bearer tokens (incl. JWTs) match this.
  { name: 'bearer-header', re: /Bearer\s+[A-Za-z0-9\-_.]{16,}/ },
];

export class SensitiveValueError extends Error {
  readonly field: string;
  readonly pattern: string;
  readonly preview: string;

  constructor(field: string, pattern: string, preview: string) {
    super(
      `refusing to log: field "${field}" matches sensitive pattern ${pattern} (sha256:${preview})`,
    );
    this.name = 'SensitiveValueError';
    this.field = field;
    this.pattern = pattern;
    this.preview = preview;
  }
}

function scanString(value: string, field: string): void {
  for (const { name, re } of PATTERNS) {
    const match = re.exec(value);
    if (match) {
      const preview = createHash('sha256')
        .update(match[0])
        .digest('hex')
        .slice(0, 12);
      throw new SensitiveValueError(field, name, preview);
    }
  }
}

/**
 * Scan a property NAME. `formatData` and `JSON.stringify` emit keys as well as
 * values, so a secret-shaped key leaks just like a value would. The thrown
 * error uses a positional `<key>` label rather than the key itself, so the
 * offending secret is never copied into `SensitiveValueError.field`.
 */
function scanKey(key: string, parentField: string): void {
  for (const { name, re } of PATTERNS) {
    if (re.test(key)) {
      const preview = createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 12);
      throw new SensitiveValueError(
        parentField ? `${parentField}.<key>` : '<key>',
        name,
        preview,
      );
    }
  }
}

/**
 * Recursively scan a log payload and throw on the first sensitive match.
 *
 * Walks strings, arrays, plain objects, and `Error` instances. Both property
 * names and values are scanned, since the logger serialises both. An object
 * that defines `toJSON` is scanned via that method's return value — that is
 * exactly what `JSON.stringify` emits, so a `toJSON` returning a secret with
 * no enumerable string field is still caught. For an Error, `message`/`stack`
 * (what `formatErr` emits) and every own enumerable property (what
 * `JSON.stringify` emits under a non-`err` key) are scanned. Numbers,
 * booleans, null, and undefined carry no string content and are skipped.
 *
 * `seen` guards against circular references (e.g. an `Error` with a circular
 * `cause`): a cycle is skipped rather than recursed into, so the scan cannot
 * stack-overflow on the logging path.
 */
export function assertNoSensitiveValues(
  payload: unknown,
  field = '',
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof payload === 'string') {
    scanString(payload, field || 'value');
    return;
  }
  if (payload instanceof Error) {
    if (seen.has(payload)) return;
    seen.add(payload);
    const base = field || 'err';
    scanString(payload.message, `${base}.message`);
    if (payload.stack) scanString(payload.stack, `${base}.stack`);
    for (const [key, value] of Object.entries(payload)) {
      scanKey(key, base);
      assertNoSensitiveValues(value, `${base}.${key}`, seen);
    }
    return;
  }
  if (Array.isArray(payload)) {
    if (seen.has(payload)) return;
    seen.add(payload);
    payload.forEach((item, index) =>
      assertNoSensitiveValues(item, `${field}[${index}]`, seen),
    );
    return;
  }
  if (payload !== null && typeof payload === 'object') {
    if (seen.has(payload)) return;
    seen.add(payload);
    const toJson = (payload as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      // JSON.stringify emits only the toJSON() result — scan exactly that,
      // not the (unserialised) enumerable properties.
      assertNoSensitiveValues(
        (payload as { toJSON(): unknown }).toJSON(),
        field || 'value',
        seen,
      );
      return;
    }
    for (const [key, value] of Object.entries(payload)) {
      scanKey(key, field);
      assertNoSensitiveValues(value, field ? `${field}.${key}` : key, seen);
    }
  }
}

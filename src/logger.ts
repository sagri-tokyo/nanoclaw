/**
 * Structured logger.
 *
 * Two surfaces:
 *
 *   1. `logger.debug` / `logger.info` / `logger.warn` / `logger.error` /
 *      `logger.fatal`: free-form diagnostics. Coloured single-line text. Used
 *      for startup banners, debug tracing, and anything that is not modeled
 *      as an "action" (a tool invocation, dispatch, or state transition).
 *
 *   2. `logger.action(record)`: schema-validated activity log. One NDJSON
 *      line per call, routed to stdout (info) or stderr (warn/error). Schema
 *      is enforced at runtime via `validateActionRecord` — fail-fast: any
 *      missing/wrong field throws synchronously, never a silent partial
 *      record. Designed for downstream CloudWatch Logs Insights filtering
 *      against the PRD 1.7 schema (sagri-tokyo/sagri-ai#110).
 *
 * Hashing helpers (`hashPayload`, `canonicalJson`) are exported so call
 * sites can hash inputs/outputs without duplicating canonicalisation logic.
 * Bare hex sha256 — no salt, no prefix, no truncation.
 */
import { createHash } from 'crypto';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (typeof dataOrMsg === 'string') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`,
    );
  } else {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`,
    );
  }
}

/**
 * Activity-log record. The shape is fixed; `validateActionRecord` rejects
 * any record that doesn't match. Defined as an interface mirrored by a
 * `REQUIRED_KEYS` array so the closed-schema check catches drift if a new
 * field is added without updating the validator.
 */
export type ActionLevel = 'info' | 'warn' | 'error';
export type ActionOutcome = 'ok' | 'error' | 'timeout' | 'rejected';

export interface ActionRecord {
  ts: string;
  level: ActionLevel;
  session_id: string;
  trigger: string;
  trigger_source: string;
  tool: string;
  inputs_hash: string;
  outputs_hash: string;
  duration_ms: number;
  outcome: ActionOutcome;
  /**
   * Required to be a non-empty string when `outcome` is `'error'` or
   * `'rejected'`; required to be `null` when `outcome` is `'ok'` or
   * `'timeout'`. CloudWatch Logs Insights queries can therefore filter
   * `outcome IN ('error','rejected')` and rely on `error_class` always
   * being populated for those rows.
   */
  error_class: string | null;
  group: string;
}

const REQUIRED_KEYS: ReadonlyArray<keyof ActionRecord> = [
  'ts',
  'level',
  'session_id',
  'trigger',
  'trigger_source',
  'tool',
  'inputs_hash',
  'outputs_hash',
  'duration_ms',
  'outcome',
  'error_class',
  'group',
];

const ALLOWED_LEVELS: ReadonlyArray<ActionLevel> = ['info', 'warn', 'error'];
const ALLOWED_OUTCOMES: ReadonlyArray<ActionOutcome> = [
  'ok',
  'error',
  'timeout',
  'rejected',
];

const HEX_64 = /^[0-9a-f]{64}$/;
// ISO 8601 UTC, milliseconds optional. Matches `new Date().toISOString()`.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// Below this length the env var is presumed to be a stub/test placeholder and
// the sentinel is skipped to avoid flagging coincidental short-string matches.
const MIN_REDACT_TOKEN_LENGTH = 16;

export class ActionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionSchemaError';
  }
}

/**
 * Stable JSON serialisation with sorted keys — used to canonicalise object
 * payloads before hashing so `{a:1,b:2}` and `{b:2,a:1}` hash to the same
 * value. Arrays preserve insertion order. Non-finite numbers serialise as
 * null (matches `JSON.stringify` default).
 *
 * `undefined` is rejected at every position (top-level, object value, array
 * slot). `JSON.stringify` silently drops undefined-valued object keys and
 * coerces undefined array slots to null, which would let
 * `canonicalJson({a: undefined, b: 1})` and `canonicalJson({b: 1})` collide
 * to the same hash. Forensic correlation needs distinct payloads to stay
 * distinct, so we fail-fast instead. Callers must omit absent fields rather
 * than passing `undefined`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new ActionSchemaError(
      'canonicalJson: undefined is not serialisable — omit the field instead',
    );
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

/**
 * sha256 of a payload, returned as bare lowercase hex (64 chars). No salt,
 * no truncation.
 *
 * - Buffer / Uint8Array: hashed as raw bytes.
 * - string: hashed as UTF-8 bytes.
 * - everything else: canonicalised via `canonicalJson` then hashed as UTF-8.
 */
export function hashPayload(payload: unknown): string {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    hash.update(payload);
  } else if (typeof payload === 'string') {
    hash.update(payload, 'utf8');
  } else {
    hash.update(canonicalJson(payload), 'utf8');
  }
  return hash.digest('hex');
}

/**
 * Build an outputs_hash for action records whose call has no real output
 * payload (rejected requests, error paths that never produced a response
 * body). The hash is over a struct of whatever distinguishing context is
 * available — at minimum the `error_class`, optionally a redacted
 * `error_message_preview` (first 200 chars, callers must redact secrets
 * upstream).
 *
 * Replaces the previous `hashPayload('')` pattern, which collapsed every
 * error row across every tool to the same SHA-256 digest of empty bytes
 * and silently broke `WHERE outputs_hash = ?` correlation queries.
 *
 * Callers must pass a non-empty `error_class`. If you genuinely have no
 * error class (e.g. a rejection that isn't an error), invent a stable
 * sentinel string for that case ("EmptyResponse", "NoOp") rather than
 * passing an empty string.
 */
export function hashFailureOutput(failure: {
  error_class: string;
  error_message_preview?: string;
}): string {
  if (
    typeof failure.error_class !== 'string' ||
    failure.error_class.length === 0
  ) {
    throw new ActionSchemaError(
      'hashFailureOutput: error_class must be a non-empty string',
    );
  }
  return hashPayload(failure);
}

function fail(field: string, reason: string): never {
  throw new ActionSchemaError(`ActionRecord field "${field}" ${reason}`);
}

/**
 * Defence-in-depth sentinel. Throws if any string-typed field value contains
 * the literal value of `process.env.ANTHROPIC_API_KEY` as a substring. The
 * canonical convention is that call sites only ever log hashes; this guard
 * catches accidental plaintext leakage (e.g. an error message that quoted a
 * request header) before it reaches stdout/stderr.
 *
 * Reads the env var on every call so a token rotated mid-process is still
 * scanned. Skipped when the env var is unset, empty, or shorter than
 * `MIN_REDACT_TOKEN_LENGTH` — short stubs and test placeholders would yield
 * false positives.
 *
 * Shallow scan: `ActionRecord` is currently all scalar fields. If a nested
 * object field is ever added, this loop will silently skip it — either walk
 * recursively or extend the closed-schema validator to reject the new shape.
 */
function checkAnthropicApiKeyLeak(record: ActionRecord): void {
  const token = process.env.ANTHROPIC_API_KEY;
  if (!token || token.length < MIN_REDACT_TOKEN_LENGTH) return;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.includes(token)) {
      fail(key, 'contains ANTHROPIC_API_KEY value (refusing to log secret)');
    }
  }
}

/**
 * Runtime schema check. Throws `ActionSchemaError` on the first violation.
 * Closed schema: any unknown key is rejected so call sites that drift past
 * the documented shape fail loudly instead of silently emitting partial
 * records.
 */
export function validateActionRecord(record: ActionRecord): void {
  const allowed = new Set<string>(REQUIRED_KEYS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(key, 'is not a known schema field');
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) fail(key, 'is missing');
  }

  if (typeof record.ts !== 'string' || !ISO_8601.test(record.ts)) {
    fail('ts', 'must be an ISO 8601 timestamp');
  }
  if (!ALLOWED_LEVELS.includes(record.level)) {
    fail('level', `must be one of ${ALLOWED_LEVELS.join(', ')}`);
  }
  if (typeof record.session_id !== 'string' || record.session_id.length === 0) {
    fail('session_id', 'must be a non-empty string');
  }
  if (typeof record.trigger !== 'string' || record.trigger.length === 0) {
    fail('trigger', 'must be a non-empty string');
  }
  if (
    typeof record.trigger_source !== 'string' ||
    record.trigger_source.length === 0
  ) {
    fail('trigger_source', 'must be a non-empty string');
  }
  if (typeof record.tool !== 'string' || record.tool.length === 0) {
    fail('tool', 'must be a non-empty string');
  }
  if (
    typeof record.inputs_hash !== 'string' ||
    !HEX_64.test(record.inputs_hash)
  ) {
    fail('inputs_hash', 'must be a 64-char lowercase hex sha256');
  }
  if (
    typeof record.outputs_hash !== 'string' ||
    !HEX_64.test(record.outputs_hash)
  ) {
    fail('outputs_hash', 'must be a 64-char lowercase hex sha256');
  }
  if (
    typeof record.duration_ms !== 'number' ||
    !Number.isFinite(record.duration_ms) ||
    record.duration_ms < 0
  ) {
    fail('duration_ms', 'must be a non-negative finite number');
  }
  if (!ALLOWED_OUTCOMES.includes(record.outcome)) {
    fail('outcome', `must be one of ${ALLOWED_OUTCOMES.join(', ')}`);
  }
  if (record.outcome === 'error' || record.outcome === 'rejected') {
    if (
      typeof record.error_class !== 'string' ||
      record.error_class.length === 0
    ) {
      fail(
        'error_class',
        `must be a non-empty string when outcome=${record.outcome}`,
      );
    }
  } else {
    // outcome is 'ok' or 'timeout' — error_class must be exactly null.
    if (record.error_class !== null) {
      fail('error_class', `must be null when outcome=${record.outcome}`);
    }
  }
  if (typeof record.group !== 'string' || record.group.length === 0) {
    fail('group', 'must be a non-empty string');
  }
  checkAnthropicApiKeyLeak(record);
}

function emitAction(record: ActionRecord): void {
  validateActionRecord(record);
  const stream = record.level === 'info' ? process.stdout : process.stderr;
  stream.write(JSON.stringify(record) + '\n');
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
  /**
   * Emit a structured action record. Fails fast on schema violations.
   *
   * Output is one JSON object per line — no colourisation, no key ordering
   * guarantees beyond what the underlying `JSON.stringify` produces.
   */
  action: (record: ActionRecord) => emitAction(record),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

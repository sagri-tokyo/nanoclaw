/**
 * Tests for the activity-log schema validator + logger.action() emitter.
 *
 * Schema target (sagri-tokyo/sagri-ai#110):
 *   ts: ISO 8601 string
 *   level: "info" | "warn" | "error"
 *   session_id: string
 *   trigger: string
 *   trigger_source: string
 *   tool: string
 *   inputs_hash: bare-hex sha256
 *   outputs_hash: bare-hex sha256
 *   duration_ms: number (non-negative)
 *   outcome: "ok" | "error" | "timeout" | "rejected"
 *   error_class: string | null (string required when outcome=error)
 *   group: string
 *
 * Hashing: sha256(canonical(payload)). Canonical JSON has stable key order so
 * hashes match regardless of object key insertion order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  hashPayload,
  hashFailureOutput,
  canonicalJson,
  validateActionRecord,
  ActionRecord,
  ActionSchemaError,
  formatErr,
  logger,
} from './logger.js';

function validRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    ts: '2026-04-30T12:34:56.789Z',
    level: 'info',
    session_id: 'sess-1',
    trigger: 'slack_mention',
    trigger_source: '#sagri-ai-dev',
    tool: 'message_send',
    inputs_hash: hashPayload('hello'),
    outputs_hash: hashPayload('world'),
    duration_ms: 42,
    outcome: 'ok',
    error_class: null,
    group: 'sagri-ai',
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('serializes objects with sorted keys', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('produces identical output regardless of key order', () => {
    const left = canonicalJson({ a: 1, b: { y: 2, x: 1 } });
    const right = canonicalJson({ b: { x: 1, y: 2 }, a: 1 });
    expect(left).toBe(right);
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested objects with mixed types', () => {
    expect(canonicalJson({ list: [{ b: 2, a: 1 }, 's'], num: 7 })).toBe(
      '{"list":[{"a":1,"b":2},"s"],"num":7}',
    );
  });

  it('serializes null and primitives directly', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(true)).toBe('true');
  });
});

describe('hashPayload', () => {
  it('returns bare hex sha256 of utf-8 bytes for strings', () => {
    const h = hashPayload('hello');
    expect(h).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes UTF-8 bytes for multibyte strings', () => {
    expect(hashPayload('日本語')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalises objects before hashing — key order is irrelevant', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('hashes Buffers as raw bytes (not as their JSON form)', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const h = hashPayload(buf);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(hashPayload('123'));
  });

  // Pin this as EMPTY_STRING_HASH — it is NOT the canonical "empty output"
  // value. Call sites with no real output should hash a meaningful failure
  // payload (e.g. error_class) rather than reusing this digest, otherwise
  // every error row collapses to the same outputs_hash and forensic
  // correlation breaks.
  it('hashes the empty string deterministically (EMPTY_STRING_HASH)', () => {
    expect(hashPayload('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes the empty object deterministically', () => {
    expect(hashPayload({})).toBe(hashPayload({}));
  });

  it('throws on undefined-valued object keys (no silent collision)', () => {
    expect(() => hashPayload({ a: undefined, b: 1 })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
  });

  it('throws on undefined-valued array slots (no silent collision)', () => {
    expect(() => canonicalJson([1, undefined, 2])).toThrow(/undefined/);
  });

  it('throws on top-level undefined', () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
  });

  it('produces distinct hashes for different failure payloads', () => {
    const a = hashPayload({ error_class: 'TargetGroupNotRegistered' });
    const b = hashPayload({ error_class: 'Unauthorized' });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashFailureOutput', () => {
  it('returns a 64-char lowercase hex sha256', () => {
    expect(hashFailureOutput({ error_class: 'Unauthorized' })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('produces DIFFERENT hashes for different error classes', () => {
    // BLOCKER 1 regression guard: every error path used to share
    // hashPayload('') = e3b0c44... which broke forensic correlation.
    // Two different error classes from the same call site MUST hash
    // differently now.
    const a = hashFailureOutput({ error_class: 'Unauthorized' });
    const b = hashFailureOutput({ error_class: 'TaskNotFound' });
    const c = hashFailureOutput({ error_class: 'TargetGroupNotRegistered' });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
    // And none of them collapse to the empty-string sentinel.
    const EMPTY_STRING_HASH =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(a).not.toBe(EMPTY_STRING_HASH);
    expect(b).not.toBe(EMPTY_STRING_HASH);
    expect(c).not.toBe(EMPTY_STRING_HASH);
  });

  it('factors in error_message_preview when present', () => {
    const a = hashFailureOutput({
      error_class: 'HttpError',
      error_message_preview: 'connection refused',
    });
    const b = hashFailureOutput({
      error_class: 'HttpError',
      error_message_preview: 'connection timed out',
    });
    expect(a).not.toBe(b);
  });

  it('throws when error_class is empty or missing', () => {
    expect(() => hashFailureOutput({ error_class: '' })).toThrow(/error_class/);
    expect(() =>
      hashFailureOutput({} as unknown as { error_class: string }),
    ).toThrow(/error_class/);
  });
});

describe('validateActionRecord', () => {
  it('accepts a canonical record', () => {
    expect(() => validateActionRecord(validRecord())).not.toThrow();
  });

  it('rejects missing ts', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).ts;
    expect(() => validateActionRecord(r)).toThrow(/ts/);
  });

  it('rejects non-ISO ts', () => {
    expect(() =>
      validateActionRecord(validRecord({ ts: 'yesterday' })),
    ).toThrow(/ts/);
  });

  it('rejects missing session_id', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).session_id;
    expect(() => validateActionRecord(r)).toThrow(/session_id/);
  });

  it('rejects empty session_id', () => {
    expect(() => validateActionRecord(validRecord({ session_id: '' }))).toThrow(
      /session_id/,
    );
  });

  it('rejects missing trigger', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).trigger;
    expect(() => validateActionRecord(r)).toThrow(/trigger/);
  });

  it('rejects missing trigger_source', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).trigger_source;
    expect(() => validateActionRecord(r)).toThrow(/trigger_source/);
  });

  it('rejects missing tool', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).tool;
    expect(() => validateActionRecord(r)).toThrow(/tool/);
  });

  it('rejects non-hex inputs_hash', () => {
    expect(() =>
      validateActionRecord(validRecord({ inputs_hash: 'sha256:abcd' })),
    ).toThrow(/inputs_hash/);
    expect(() =>
      validateActionRecord(validRecord({ inputs_hash: 'not-a-hash' })),
    ).toThrow(/inputs_hash/);
  });

  it('rejects non-hex outputs_hash', () => {
    expect(() =>
      validateActionRecord(validRecord({ outputs_hash: 'XYZ' })),
    ).toThrow(/outputs_hash/);
  });

  it('rejects non-numeric duration_ms', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ duration_ms: 'fast' as unknown as number }),
      ),
    ).toThrow(/duration_ms/);
  });

  it('rejects negative duration_ms', () => {
    expect(() =>
      validateActionRecord(validRecord({ duration_ms: -1 })),
    ).toThrow(/duration_ms/);
  });

  it('rejects non-finite duration_ms', () => {
    expect(() =>
      validateActionRecord(validRecord({ duration_ms: Infinity })),
    ).toThrow(/duration_ms/);
  });

  it('rejects unknown level', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ level: 'debug' as unknown as 'info' }),
      ),
    ).toThrow(/level/);
  });

  it('rejects unknown outcome', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'maybe' as unknown as 'ok' }),
      ),
    ).toThrow(/outcome/);
  });

  it('accepts each documented outcome with the contract-correct error_class', () => {
    // outcome=ok and outcome=timeout: error_class MUST be null
    for (const outcome of ['ok', 'timeout'] as const) {
      expect(() =>
        validateActionRecord(validRecord({ outcome, error_class: null })),
      ).not.toThrow();
    }
    // outcome=error and outcome=rejected: error_class MUST be a non-empty string
    for (const outcome of ['error', 'rejected'] as const) {
      expect(() =>
        validateActionRecord(
          validRecord({ outcome, error_class: 'BoomError' }),
        ),
      ).not.toThrow();
    }
  });

  it('rejects missing group', () => {
    const r = validRecord();
    delete (r as Partial<ActionRecord>).group;
    expect(() => validateActionRecord(r)).toThrow(/group/);
  });

  it('accepts null error_class on ok outcome', () => {
    expect(() =>
      validateActionRecord(validRecord({ outcome: 'ok', error_class: null })),
    ).not.toThrow();
  });

  it('requires error_class to be a non-empty string when outcome is error', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'error', error_class: null }),
      ),
    ).toThrow(/error_class/);
    expect(() =>
      validateActionRecord(validRecord({ outcome: 'error', error_class: '' })),
    ).toThrow(/error_class/);
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'error', error_class: 'TypeError' }),
      ),
    ).not.toThrow();
  });

  it('requires error_class to be a non-empty string when outcome is rejected', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'rejected', error_class: null }),
      ),
    ).toThrow(/error_class/);
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'rejected', error_class: '' }),
      ),
    ).toThrow(/error_class/);
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'rejected', error_class: 'Unauthorized' }),
      ),
    ).not.toThrow();
  });

  it('requires error_class to be null when outcome is ok', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'ok', error_class: 'BoomError' }),
      ),
    ).toThrow(/error_class/);
  });

  it('requires error_class to be null when outcome is timeout', () => {
    expect(() =>
      validateActionRecord(
        validRecord({ outcome: 'timeout', error_class: 'BoomError' }),
      ),
    ).toThrow(/error_class/);
  });

  it('rejects extra unknown fields (closed schema)', () => {
    const r = {
      ...validRecord(),
      extra_field: 'oops',
    } as unknown as ActionRecord;
    expect(() => validateActionRecord(r)).toThrow(/extra_field/);
  });
});

describe('formatErr JSON escaping (sagri-tokyo/sagri-ai#157)', () => {
  // Each case is an error whose `message` contains a character class the
  // previous string-interpolation implementation would have left unescaped,
  // producing log lines that JSON.parse refused. The fix replaces manual
  // interpolation with JSON.stringify so each case round-trips losslessly.
  const corruptingCases: ReadonlyArray<{ name: string; message: string }> = [
    { name: 'double quote', message: 'unexpected " in payload' },
    { name: 'newline', message: 'line1\nline2' },
    { name: 'backslash', message: 'path\\to\\file' },
    { name: 'control character (U+0007 BEL)', message: 'bell:here' },
    { name: 'tab', message: 'col1\tcol2' },
  ];

  for (const { name, message } of corruptingCases) {
    it(`emits parseable JSON when message contains ${name}`, () => {
      const err = new Error(message);
      const out = formatErr(err);
      expect(() => JSON.parse(out)).not.toThrow();
      const parsed = JSON.parse(out) as {
        type: string;
        message: string;
        stack: string | undefined;
      };
      expect(parsed.message).toBe(message);
      expect(parsed.type).toBe('Error');
    });
  }

  it('emits parseable JSON when stack contains corrupting characters', () => {
    const err = new Error('outer');
    err.stack = 'Error: outer\n    at "file"\\with\ttab\n';
    const parsed = JSON.parse(formatErr(err)) as {
      type: string;
      message: string;
      stack: string;
    };
    expect(parsed.stack).toBe('Error: outer\n    at "file"\\with\ttab\n');
    expect(parsed.message).toBe('outer');
  });

  it('emits parseable JSON for the combined Notion-style failure mode', () => {
    // Realistic regression: a Notion/Anthropic response body interpolated
    // into an Error message — quotes, backslashes, and newlines together.
    const message =
      'Notion API: {"error":"validation_error","details":"bad path \\\\u200b\\nfield: \\"title\\""}';
    const parsed = JSON.parse(formatErr(new Error(message))) as {
      message: string;
    };
    expect(parsed.message).toBe(message);
  });

  it('uses the Error subclass constructor name as type', () => {
    class HttpError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'HttpError';
      }
    }
    const parsed = JSON.parse(formatErr(new HttpError('boom "quoted"'))) as {
      type: string;
      message: string;
    };
    expect(parsed.type).toBe('HttpError');
    expect(parsed.message).toBe('boom "quoted"');
  });

  it('falls back to JSON.stringify for non-Error values', () => {
    expect(formatErr('plain string')).toBe(JSON.stringify('plain string'));
    expect(formatErr({ code: 'ENOENT' })).toBe(
      JSON.stringify({ code: 'ENOENT' }),
    );
    expect(formatErr(null)).toBe('null');
  });

  it('produces a parseable line inside the diagnostic log surface (logger.error)', () => {
    // formatErr is reused by the diagnostic path via formatData. Even though
    // the surrounding text isn't pure JSON, the err payload itself must be
    // a valid JSON fragment that downstream parsers can extract.
    const captured: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    try {
      const err = new Error('quoted "thing"\nnext line\\path');
      logger.error({ err }, 'boom');
      expect(captured).toHaveLength(1);
      // Extract the err JSON fragment from the formatted line. The line
      // shape is `... err: {<json>}` where the JSON starts at the first `{`
      // following `err:` and runs to end-of-line (minus the trailing newline).
      const line = captured[0];
      const marker = 'err\x1b[39m: ';
      const start = line.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const fragment = line.slice(start + marker.length).replace(/\n$/, '');
      const parsed = JSON.parse(fragment) as {
        type: string;
        message: string;
      };
      expect(parsed.message).toBe('quoted "thing"\nnext line\\path');
      expect(parsed.type).toBe('Error');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('logger.action emission', () => {
  let writes: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('emits one NDJSON line per action', () => {
    logger.action(validRecord());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\n$/);
    const parsed = JSON.parse(writes[0]);
    expect(parsed).toEqual({
      ts: '2026-04-30T12:34:56.789Z',
      level: 'info',
      session_id: 'sess-1',
      trigger: 'slack_mention',
      trigger_source: '#sagri-ai-dev',
      tool: 'message_send',
      inputs_hash: hashPayload('hello'),
      outputs_hash: hashPayload('world'),
      duration_ms: 42,
      outcome: 'ok',
      error_class: null,
      group: 'sagri-ai',
    });
  });

  it('routes info to stdout and warn/error to stderr', () => {
    logger.action(validRecord({ level: 'info' }));
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    logger.action(
      validRecord({
        level: 'error',
        outcome: 'error',
        error_class: 'BoomError',
      }),
    );
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('throws synchronously on invalid records (fail fast)', () => {
    expect(() => logger.action(validRecord({ inputs_hash: 'bogus' }))).toThrow(
      /inputs_hash/,
    );
  });
});

describe('logger.action ANTHROPIC_API_KEY redaction sentinel', () => {
  const TOKEN = 'sk-ant-test-key-1234567890';
  let originalKey: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = TOKEN;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('throws when token substring appears in tool', () => {
    expect(() =>
      logger.action(validRecord({ tool: `prefix-${TOKEN}-suffix` })),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('throws when token substring appears in trigger_source', () => {
    expect(() => logger.action(validRecord({ trigger_source: TOKEN }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('throws when token substring appears in error_class', () => {
    expect(() =>
      logger.action(
        validRecord({
          level: 'error',
          outcome: 'error',
          error_class: `BoomError(${TOKEN})`,
        }),
      ),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('throws when token substring appears in session_id', () => {
    expect(() => logger.action(validRecord({ session_id: TOKEN }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not fire when env var is unset', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => logger.action(validRecord({ tool: TOKEN }))).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it('does not fire when env var is empty', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(() => logger.action(validRecord({ tool: TOKEN }))).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it('does not fire when env var is shorter than 16 chars', () => {
    process.env.ANTHROPIC_API_KEY = 'short-key';
    expect(() =>
      logger.action(validRecord({ tool: 'short-key-something' })),
    ).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it('does not fire when only the sha256 hex of the token appears (hashes are fine)', () => {
    expect(() =>
      logger.action(
        validRecord({
          inputs_hash: hashPayload(TOKEN),
          outputs_hash: hashPayload(TOKEN),
        }),
      ),
    ).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it('throws ActionSchemaError, the same class as other validator failures', () => {
    expect(() => logger.action(validRecord({ tool: TOKEN }))).toThrow(
      ActionSchemaError,
    );
    expect(() =>
      logger.action(validRecord({ inputs_hash: 'not-a-hash' })),
    ).toThrow(ActionSchemaError);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

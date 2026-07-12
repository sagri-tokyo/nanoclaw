/**
 * Tests for the fail-closed value-redaction sentinel (sagri-tokyo/sagri-ai#143).
 *
 * Pins one live-shaped example per secret pattern, asserts the exception names
 * the offending field without echoing the raw value, and checks the logger
 * entrypoints route through the sentinel (throw + no write) before serialising.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  assertNoSensitiveValues,
  SensitiveValueError,
} from './logger-redactor.js';
import { logger } from './logger.js';

// Slack-shaped fixtures are assembled from fragments so no contiguous token
// literal sits in the source — otherwise GitHub push protection rejects the
// commit. The runtime string still exercises the regex.
const SLACK_BOT = 'xox' + 'b-1234567890-0987654321-AbCdEfGhIjKlMnOp';

// One synthetic-but-shaped example per pattern. None are real credentials.
const SAMPLES: ReadonlyArray<[string, string]> = [
  ['anthropic-key', 'sk-ant-api03-AbCdEf0123456789ghijklmnop'],
  ['slack-token', SLACK_BOT],
  ['slack-app-token', 'xapp-1-A01234567-1234567890-abcdef0123456789'],
  ['github-pat-classic', 'ghp_AbCdEf0123456789AbCdEf0123456789abcd'],
  [
    'github-pat-fine-grained',
    'github_pat_11ABCDEFG0abcdefg1234567_XyZ0123456789',
  ],
  ['notion-token', 'secret_AbCdEf0123456789AbCdEf0123456789abcdefgh'],
  ['notion-token', 'ntn_AbCdEf0123456789AbCdEf0123456789abcdefgh'],
  ['aws-access-key-id', 'AKIAIOSFODNN7EXAMPLE'],
  ['aws-access-key-id', 'ASIAIOSFODNN7EXAMPLE'],
  ['bearer-header', 'Authorization: Bearer abcdef0123456789ghij.token'],
];

// Prose that mentions a pattern keyword but carries no token-shaped value.
// These must NOT throw: a false positive here aborts a real log line.
const BENIGN: ReadonlyArray<string> = [
  'missing Bearer prefix in the Authorization header',
  'expected a Bearer token but got none',
  'the secret handshake is not a token',
];

describe('assertNoSensitiveValues pattern coverage', () => {
  for (const [pattern, sample] of SAMPLES) {
    it(`throws on ${pattern}`, () => {
      try {
        assertNoSensitiveValues(sample, 'field');
        throw new Error(`expected SensitiveValueError for ${pattern}`);
      } catch (err) {
        if (!(err instanceof SensitiveValueError)) throw err;
        expect(err.pattern).toBe(pattern);
        expect(err.field).toBe('field');
      }
    });
  }

  it('reports the nested field path of the offending value', () => {
    try {
      assertNoSensitiveValues({
        outer: { inner: ['fine', 'AKIAIOSFODNN7EXAMPLE'] },
      });
      throw new Error('expected SensitiveValueError');
    } catch (err) {
      if (!(err instanceof SensitiveValueError)) throw err;
      expect(err.field).toBe('outer.inner[1]');
    }
  });

  it('never echoes the raw secret in the exception', () => {
    const secret = 'sk-ant-api03-AbCdEf0123456789ghijklmnop';
    try {
      assertNoSensitiveValues(secret, 'tool');
      throw new Error('expected SensitiveValueError');
    } catch (err) {
      if (!(err instanceof SensitiveValueError)) throw err;
      expect(err.message).not.toContain(secret);
      expect(err.preview).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('scans Error message and stack', () => {
    const err = new Error(`boom ${SLACK_BOT}`);
    expect(() => assertNoSensitiveValues(err, 'err')).toThrow(
      SensitiveValueError,
    );
  });

  it('scans an Error own enumerable property (SDK-style config)', () => {
    const err = new Error('request failed');
    Object.assign(err, {
      config: { headers: { Authorization: 'Bearer abcdef0123456789ghij.tok' } },
    });
    try {
      assertNoSensitiveValues(err, 'err');
      throw new Error('expected SensitiveValueError');
    } catch (caught) {
      if (!(caught instanceof SensitiveValueError)) throw caught;
      expect(caught.field).toBe('err.config.headers.Authorization');
    }
  });

  for (const prose of BENIGN) {
    it(`does not throw on benign prose: "${prose}"`, () => {
      expect(() => assertNoSensitiveValues(prose, 'msg')).not.toThrow();
    });
  }

  it('does not match an AWS-key shape embedded in a longer alnum run', () => {
    // AKIA... followed/preceded by more uppercase-alnum is a blob, not a key.
    expect(() =>
      assertNoSensitiveValues('BLOBAKIAIOSFODNN7EXAMPLE0123456789', 'msg'),
    ).not.toThrow();
    expect(() =>
      assertNoSensitiveValues('AKIAIOSFODNN7EXAMPLEEXTRA', 'msg'),
    ).not.toThrow();
  });

  it('does not stack-overflow on a circular payload', () => {
    const cyclic: Record<string, unknown> = { name: 'ok' };
    cyclic.self = cyclic;
    expect(() => assertNoSensitiveValues(cyclic)).not.toThrow();
  });

  it('passes clean payloads unchanged', () => {
    expect(() =>
      assertNoSensitiveValues({
        session_id: 'sess-1',
        count: 42,
        nested: { ok: true, list: ['a', 'b'] },
        note: 'the secret handshake is not a token',
      }),
    ).not.toThrow();
  });
});

describe('logger entrypoints route through the sentinel', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('logger.info throws and does not write when a data value leaks', () => {
    expect(() =>
      logger.info(
        { token: 'ghp_AbCdEf0123456789AbCdEf0123456789abcd' },
        'boot',
      ),
    ).toThrow(SensitiveValueError);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('logger.error throws and does not write when the message leaks', () => {
    expect(() =>
      logger.error('Authorization: Bearer leaked.token.value'),
    ).toThrow(SensitiveValueError);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logger.info emits normally for a clean payload', () => {
    logger.info({ session_id: 'sess-1' }, 'started');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});

import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_SOURCES,
  decideWrite,
  parseFrontmatter,
  validateProvenance,
} from './memory-gate.js';

const VALID = {
  name: 'AWS Secrets',
  description: 'Where sagri secrets live',
  type: 'reference',
  source: 'admin_commit',
  trigger: 'user said "remember this"',
  session_id: '550e8400-e29b-41d4-a716-446655440000',
  timestamp: '2026-04-20T10:00:00Z',
  author_model: 'claude-opus-4-7',
};

function topicBody(overrides: Record<string, unknown> = {}): string {
  const merged = { ...VALID, ...overrides };
  const lines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`);
  return ['---', ...lines, '---', '', 'body text'].join('\n');
}

describe('parseFrontmatter', () => {
  it('returns null when no frontmatter fence present', () => {
    expect(parseFrontmatter('no fence here')).toBeNull();
  });

  it('returns null when opening fence is not on first line', () => {
    expect(parseFrontmatter('\n---\nkey: val\n---')).toBeNull();
  });

  it('parses simple key-value pairs', () => {
    const content = '---\nfoo: bar\nbaz: qux\n---\nbody';
    expect(parseFrontmatter(content)).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('handles values containing colons', () => {
    const content = '---\nurl: https://example.com/x\n---';
    expect(parseFrontmatter(content)).toEqual({ url: 'https://example.com/x' });
  });

  it('throws on unterminated frontmatter', () => {
    expect(() => parseFrontmatter('---\nkey: val\nbody with no close')).toThrow(
      /unterminated frontmatter/i,
    );
  });
});

describe('validateProvenance', () => {
  it('accepts a fully-formed record', () => {
    expect(() => validateProvenance(VALID)).not.toThrow();
  });

  it.each([
    'source',
    'trigger',
    'session_id',
    'timestamp',
    'author_model',
  ] as const)('rejects missing %s', (field) => {
    const record: Record<string, unknown> = { ...VALID };
    delete record[field];
    expect(() => validateProvenance(record)).toThrow(
      new RegExp(`missing.*${field}`, 'i'),
    );
  });

  it('rejects unknown source', () => {
    expect(() => validateProvenance({ ...VALID, source: 'telegram' })).toThrow(
      /source.*not in enum/i,
    );
  });

  it('rejects malformed session_id', () => {
    expect(() =>
      validateProvenance({ ...VALID, session_id: 'not-a-uuid' }),
    ).toThrow(/session_id.*uuid/i);
  });

  it('rejects malformed timestamp', () => {
    expect(() =>
      validateProvenance({ ...VALID, timestamp: '2026-04-20' }),
    ).toThrow(/timestamp.*iso/i);
  });

  it('rejects empty trigger', () => {
    expect(() => validateProvenance({ ...VALID, trigger: '' })).toThrow(
      /trigger.*empty/i,
    );
  });
});

describe('ADMIN_SOURCES', () => {
  it('matches the schema $defs list', () => {
    expect(ADMIN_SOURCES).toEqual(['admin_commit', 'notion_brief', 'cli']);
  });
});

describe('decideWrite', () => {
  const memoryDir = '/workspace/global/memory';

  it('allows writes outside the memory directory', () => {
    const decision = decideWrite({
      filePath: '/workspace/group/scratch.md',
      content: 'anything',
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('allows writes to MEMORY.md without frontmatter', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'MEMORY.md'),
      content: '- [topic](file.md) — hook\n',
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('allows topic write with valid admin provenance', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'aws_secrets.md'),
      content: topicBody(),
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('rejects topic write missing frontmatter', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'raw.md'),
      content: 'just a body, no frontmatter',
      memoryDir,
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toMatch(/frontmatter/i);
  });

  it('rejects topic write missing required field', () => {
    const body = topicBody();
    const content = body.replace(/^source: .+$/m, '');
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content,
      memoryDir,
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toMatch(/missing.*source/i);
  });

  it('rejects non-admin source (slack_message)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody({ source: 'slack_message' }),
      memoryDir,
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toMatch(/non-admin source.*slack_message/i);
  });

  it('rejects non-admin source (github_issue)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody({ source: 'github_issue' }),
      memoryDir,
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toMatch(/non-admin source.*github_issue/i);
  });

  it('normalises trailing slash on memory dir', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody(),
      memoryDir: memoryDir + '/',
    });
    expect(decision).toEqual({ allow: true });
  });

  it('treats paths above memory dir as outside (prefix attack)', () => {
    const decision = decideWrite({
      filePath: '/workspace/global/memory-evil/x.md',
      content: 'no frontmatter',
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });
});

import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_SOURCES,
  decideWrite,
  Decision,
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

function topicBody(overrides: Record<string, string> = {}): string {
  const merged = { ...VALID, ...overrides };
  const lines = Object.entries(merged).map(([k, v]) => {
    if (typeof v !== 'string')
      throw new Error(`topicBody: non-string value for ${k}`);
    return `${k}: ${v}`;
  });
  return ['---', ...lines, '---', '', 'body text'].join('\n');
}

function expectDenied(decision: Decision): { allow: false; reason: string } {
  if (decision.allow) throw new Error('expected denial, got allow');
  return decision;
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

  it('strips UTF-8 BOM before detecting opening fence', () => {
    const content = '\uFEFF---\nkey: val\n---\n';
    expect(parseFrontmatter(content)).toEqual({ key: 'val' });
  });

  it('rejects duplicate keys in frontmatter', () => {
    const content = '---\nsource: admin_commit\nsource: cli\n---\n';
    expect(() => parseFrontmatter(content)).toThrow(/duplicate.*source/i);
  });

  it('throws on a frontmatter line with no colon', () => {
    expect(() => parseFrontmatter('---\njust text\n---\n')).toThrow(
      /malformed frontmatter/i,
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

  it('rejects impossible timestamp values (month 99)', () => {
    expect(() =>
      validateProvenance({ ...VALID, timestamp: '9999-99-99T99:99:99Z' }),
    ).toThrow(/timestamp.*invalid/i);
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
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('rejects topic write missing required field', () => {
    const body = topicBody();
    const content = body.replace(/^source: .+$/m, '');
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content,
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/missing.*source/i);
  });

  it('rejects non-admin source (slack_message)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody({ source: 'slack_message' }),
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/non-admin source.*slack_message/i);
  });

  it('rejects non-admin source (github_issue)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody({ source: 'github_issue' }),
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/non-admin source.*github_issue/i);
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

  it('resolves relative traversal inside memory dir path', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, '..', 'memory', 'x.md'),
      content: topicBody(),
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('resolves traversal escape attempts', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, '..', 'escape', 'x.md'),
      content: 'no frontmatter',
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('collapses double slashes in file path', () => {
    const decision = decideWrite({
      filePath: memoryDir + '//x.md',
      content: topicBody(),
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('treats the memory dir itself as outside (write target must be a file under it)', () => {
    const decision = decideWrite({
      filePath: memoryDir,
      content: 'whatever',
      memoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('rejects non-absolute filePath', () => {
    expect(() =>
      decideWrite({
        filePath: 'relative/path.md',
        content: topicBody(),
        memoryDir,
      }),
    ).toThrow(/absolute/i);
  });

  it('rejects non-absolute memoryDir', () => {
    expect(() =>
      decideWrite({
        filePath: path.join(memoryDir, 'x.md'),
        content: topicBody(),
        memoryDir: 'relative/memory',
      }),
    ).toThrow(/absolute/i);
  });
});

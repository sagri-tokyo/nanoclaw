import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('rejects writes to MEMORY.md without frontmatter (whitelist removed — sagri-ai#78)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'MEMORY.md'),
      content: '- [topic](file.md) — hook\n',
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('rejects writes to MEMORY.md in a subdir without frontmatter', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'subdir', 'MEMORY.md'),
      content: '- [topic](file.md) — hook\n',
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
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
    expect(expectDenied(decision).reason).toMatch(
      /non-admin source.*slack_message/i,
    );
  });

  it('rejects non-admin source (github_issue)', () => {
    const decision = decideWrite({
      filePath: path.join(memoryDir, 'x.md'),
      content: topicBody({ source: 'github_issue' }),
      memoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(
      /non-admin source.*github_issue/i,
    );
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

describe('decideWrite symlink resolution (sagri-ai#74)', () => {
  let tmpRoot: string;
  let realMemoryDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memgate-'));
    realMemoryDir = path.join(tmpRoot, 'memory');
    fs.mkdirSync(realMemoryDir);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('denies Write through a symlink that dereferences into memory dir', () => {
    // Attack: attacker creates a symlink elsewhere pointing at memory/, then
    // Writes through the symlink. Path string looks "outside" memory but the
    // fs follows the symlink and the file lands inside.
    const symlinkRoot = path.join(tmpRoot, 'elsewhere');
    fs.symlinkSync(realMemoryDir, symlinkRoot);
    const decision = decideWrite({
      filePath: path.join(symlinkRoot, 'poison.md'),
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('allows Write through a symlink inside memory dir that points outside', () => {
    // Inverse: a symlink inside memory/ pointing elsewhere. Write through it
    // lands outside memory, so the gate correctly allows (write is out of
    // scope — not poisoning memory).
    const outsideTarget = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outsideTarget);
    fs.symlinkSync(outsideTarget, path.join(realMemoryDir, 'escape'));
    const decision = decideWrite({
      filePath: path.join(realMemoryDir, 'escape', 'x.md'),
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('denies Write when memoryDir itself is a symlink', () => {
    // Operational case: container-runner may bind-mount memory dir via a
    // symlinked path. The gate should canonicalize memoryDir too, not just
    // filePath, so prefix matching works on real paths.
    const linkedDir = path.join(tmpRoot, 'linked-memory');
    fs.symlinkSync(realMemoryDir, linkedDir);
    const decision = decideWrite({
      filePath: path.join(realMemoryDir, 'x.md'),
      content: 'no frontmatter',
      memoryDir: linkedDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('resolves parent when target file does not exist yet', () => {
    // Write creates a new file. realpathSync on the file itself ENOENTs;
    // must fall through to the parent. Confirm symlink on the parent is
    // still followed.
    const symlinkRoot = path.join(tmpRoot, 'elsewhere2');
    fs.symlinkSync(realMemoryDir, symlinkRoot);
    const decision = decideWrite({
      filePath: path.join(symlinkRoot, 'brand-new.md'),
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('denies Write when leaf is a dangling symlink pointing into memory dir', () => {
    // Attack: the leaf itself is a symlink whose target does not exist yet.
    // realpathSync fails because the target is absent, so a naive fallback
    // walks up to the parent and loses the symlink-ness — path looks
    // "outside" memory. Kernel open(O_CREAT) follows the symlink and lands
    // inside memory without provenance. Canonicalize must readlink
    // dangling-symlink leaves instead of treating them as regular
    // non-existent files.
    const dangling = path.join(tmpRoot, 'dangling-leaf');
    const targetInsideMemory = path.join(realMemoryDir, 'poison.md');
    fs.symlinkSync(targetInsideMemory, dangling);
    const decision = decideWrite({
      filePath: dangling,
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('denies Write when leaf is a relative dangling symlink into memory dir', () => {
    // Same attack, relative-target variant. Canonicalize must resolve the
    // relative target against the symlink's parent dir, not cwd.
    const dangling = path.join(tmpRoot, 'rel-dangling');
    fs.symlinkSync(path.join('memory', 'poison.md'), dangling);
    const decision = decideWrite({
      filePath: dangling,
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });

  it('throws on symlink loops rather than failing open', () => {
    // Two symlinks pointing at each other. realpathSync surfaces ELOOP and
    // canonicalize must propagate — silently returning the unresolved path
    // would let an ELOOP-configured memoryDir bypass the containment check
    // (the comparison is a string match; there's no kernel write to backstop
    // the failure).
    const loopA = path.join(tmpRoot, 'loop-a');
    const loopB = path.join(tmpRoot, 'loop-b');
    fs.symlinkSync(loopB, loopA);
    fs.symlinkSync(loopA, loopB);
    expect(() =>
      decideWrite({
        filePath: loopA,
        content: 'no frontmatter',
        memoryDir: realMemoryDir,
      }),
    ).toThrow(/ELOOP/);
  });

  it('denies Write through a multi-hop dangling symlink chain into memory dir', () => {
    // /tmp/hop1 -> /tmp/hop2 -> /workspace/.../poison.md, none of which
    // exist as real files. canonicalize must walk both manual hops, then
    // realpath the parent of the final target. Guards against the
    // single-hop tests passing while a multi-hop chain regresses.
    const finalTarget = path.join(realMemoryDir, 'poison.md');
    const hop2 = path.join(tmpRoot, 'hop2');
    const hop1 = path.join(tmpRoot, 'hop1');
    fs.symlinkSync(finalTarget, hop2);
    fs.symlinkSync(hop2, hop1);
    const decision = decideWrite({
      filePath: hop1,
      content: 'no frontmatter',
      memoryDir: realMemoryDir,
    });
    expect(expectDenied(decision).reason).toMatch(/frontmatter/i);
  });
});

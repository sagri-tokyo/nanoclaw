import { describe, expect, it } from 'vitest';

import {
  CurrentContentReader,
  evaluate,
  formatDenyResponse,
  HookOutput,
  HookPayload,
  parsePayload,
} from './memory-gate-hook.js';

function expectDeny(result: HookOutput): string {
  if (result.kind !== 'deny')
    throw new Error(`expected deny, got ${result.kind}`);
  return result.reason;
}

const memoryDir = '/workspace/global/memory';

const VALID_TOPIC = [
  '---',
  'name: test',
  'description: t',
  'type: reference',
  'source: admin_commit',
  'trigger: t',
  'session_id: 550e8400-e29b-41d4-a716-446655440000',
  'timestamp: 2026-04-20T10:00:00Z',
  'author_model: claude-opus-4-7',
  '---',
  'body',
].join('\n');

function write(filePath: string, content: string): HookPayload {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

function edit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): HookPayload {
  return {
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
    },
  };
}

function multiEdit(filePath: string, edits: unknown): HookPayload {
  return {
    tool_name: 'MultiEdit',
    tool_input: { file_path: filePath, edits },
  };
}

function readerOf(currentContent: string): CurrentContentReader {
  return () => currentContent;
}

describe('evaluate', () => {
  it('allows tool calls other than Write/Edit/MultiEdit', () => {
    expect(
      evaluate(
        {
          tool_name: 'Read',
          tool_input: { file_path: `${memoryDir}/x.md` },
        },
        memoryDir,
      ),
    ).toEqual({ kind: 'allow' });
  });

  it('allows Write outside memory dir', () => {
    expect(evaluate(write('/workspace/group/x.md', 'y'), memoryDir)).toEqual({
      kind: 'allow',
    });
  });

  it('denies Write to MEMORY.md without frontmatter (whitelist removed — sagri-ai#78)', () => {
    const result = evaluate(
      write(`${memoryDir}/MEMORY.md`, '- link'),
      memoryDir,
    );
    expect(expectDeny(result)).toMatch(/memory-gate.*frontmatter/i);
  });

  it('allows Write of valid admin topic', () => {
    expect(
      evaluate(write(`${memoryDir}/admin.md`, VALID_TOPIC), memoryDir),
    ).toEqual({ kind: 'allow' });
  });

  it('denies Write missing frontmatter', () => {
    const result = evaluate(
      write(`${memoryDir}/bad.md`, 'body only'),
      memoryDir,
    );
    expect(expectDeny(result)).toMatch(/memory-gate.*frontmatter/i);
  });

  it('denies Write with non-admin source', () => {
    const content = VALID_TOPIC.replace(
      'source: admin_commit',
      'source: slack_message',
    );
    const result = evaluate(write(`${memoryDir}/x.md`, content), memoryDir);
    expect(expectDeny(result)).toMatch(/non-admin.*slack_message/i);
  });

  it('denies Write with no tool_input fields (file_path missing)', () => {
    const result = evaluate({ tool_name: 'Write', tool_input: {} }, memoryDir);
    expect(expectDeny(result)).toMatch(/missing file_path/i);
  });

  it('denies Write with file_path but no content', () => {
    const result = evaluate(
      {
        tool_name: 'Write',
        tool_input: { file_path: `${memoryDir}/x.md` },
      },
      memoryDir,
    );
    expect(expectDeny(result)).toMatch(/missing content/i);
  });

  it('denies Write with non-string file_path', () => {
    const result = evaluate(
      {
        tool_name: 'Write',
        tool_input: { file_path: undefined, content: 'x' },
      },
      memoryDir,
    );
    expect(expectDeny(result)).toMatch(/missing file_path/i);
  });
});

describe('evaluate — Edit', () => {
  it('allows Edit outside memory dir without consulting the reader', () => {
    const reader: CurrentContentReader = () => {
      throw new Error('reader should not be called for outside-memory edits');
    };
    expect(
      evaluate(edit('/workspace/group/other.md', 'a', 'b'), memoryDir, reader),
    ).toEqual({ kind: 'allow' });
  });

  it('allows Edit that preserves valid provenance', () => {
    const result = evaluate(
      edit(`${memoryDir}/admin.md`, 'body', 'updated body'),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies Edit that removes required provenance field', () => {
    const result = evaluate(
      edit(`${memoryDir}/admin.md`, 'source: admin_commit\n', ''),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/missing source|source/i);
  });

  it('denies Edit that changes source from admin_commit to slack_message', () => {
    const result = evaluate(
      edit(
        `${memoryDir}/admin.md`,
        'source: admin_commit',
        'source: slack_message',
      ),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/non-admin.*slack_message/i);
  });

  it('denies Edit with non-string old_string', () => {
    const result = evaluate(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: `${memoryDir}/admin.md`,
          old_string: undefined,
          new_string: 'x',
        },
      },
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/missing old_string or new_string/i);
  });

  it('denies Edit with non-boolean replace_all', () => {
    const result = evaluate(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: `${memoryDir}/admin.md`,
          old_string: 'a',
          new_string: 'b',
          replace_all: 'yes' as unknown as boolean,
        },
      },
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/replace_all must be a boolean/i);
  });

  it('denies Edit when file does not exist and result has no frontmatter', () => {
    const result = evaluate(
      edit(`${memoryDir}/new.md`, '', 'plain body\n'),
      memoryDir,
      () => null,
    );
    expect(expectDeny(result)).toMatch(/frontmatter/i);
  });

  it('respects replace_all: true when removing every source line', () => {
    const doubled = `${VALID_TOPIC}\n${VALID_TOPIC}`;
    const result = evaluate(
      edit(`${memoryDir}/admin.md`, 'source: admin_commit', '', true),
      memoryDir,
      readerOf(doubled),
    );
    expect(expectDeny(result)).toMatch(/source/i);
  });

  it('denies Edit with empty old_string prepending non-frontmatter to admin file', () => {
    // Simulated result is newString + current. parseFrontmatter requires
    // `---\n` at the very start of the buffer; prepending non-frontmatter
    // content means the simulation no longer parses as valid memory and
    // is denied. Guards against an attempted bypass where an attacker
    // sends `old_string: ''` to splice content in front of valid
    // provenance.
    const result = evaluate(
      edit(`${memoryDir}/admin.md`, '', 'poisoned body without frontmatter\n'),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/frontmatter/i);
  });
});

describe('evaluate — MultiEdit', () => {
  it('allows MultiEdit outside memory dir', () => {
    expect(
      evaluate(
        multiEdit('/workspace/group/x.md', [
          { old_string: 'a', new_string: 'b' },
        ]),
        memoryDir,
        readerOf('abc'),
      ),
    ).toEqual({ kind: 'allow' });
  });

  it('allows MultiEdit whose intermediate state is invalid but final state is valid', () => {
    // The gate validates final on-disk content. Intermediate states never
    // hit disk (claude-code applies all edits in memory before writing), so
    // a reorder-and-restore sequence is harmless.
    const result = evaluate(
      multiEdit(`${memoryDir}/admin.md`, [
        {
          old_string: 'source: admin_commit',
          new_string: 'source: slack_message',
        },
        {
          old_string: 'source: slack_message',
          new_string: 'source: admin_commit',
        },
        { old_string: 'body', new_string: 'body2' },
      ]),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies MultiEdit whose final state drops provenance', () => {
    const result = evaluate(
      multiEdit(`${memoryDir}/admin.md`, [
        { old_string: 'source: admin_commit\n', new_string: '' },
        { old_string: 'body', new_string: 'body2' },
      ]),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/source/i);
  });

  it('denies MultiEdit with non-array edits', () => {
    const result = evaluate(
      multiEdit(`${memoryDir}/admin.md`, 'not an array'),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/edits must be an array/i);
  });

  it('denies MultiEdit with empty edits array', () => {
    const result = evaluate(
      multiEdit(`${memoryDir}/admin.md`, []),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/non-empty/i);
  });

  it('denies MultiEdit with malformed entry', () => {
    const result = evaluate(
      multiEdit(`${memoryDir}/admin.md`, [
        { old_string: 'a', new_string: 'b' },
        { old_string: 42, new_string: 'b' },
      ]),
      memoryDir,
      readerOf(VALID_TOPIC),
    );
    expect(expectDeny(result)).toMatch(/edits\[1\]\.old_string/);
  });
});

describe('parsePayload', () => {
  it('parses a well-formed payload', () => {
    const parsed = parsePayload(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/x', content: 'y' },
      }),
    );
    expect(parsed.tool_name).toBe('Write');
    expect(parsed.tool_input.file_path).toBe('/x');
  });

  it('throws on non-JSON input', () => {
    expect(() => parsePayload('not json')).toThrow();
  });

  it('throws when tool_name is missing', () => {
    expect(() => parsePayload(JSON.stringify({ tool_input: {} }))).toThrow(
      /tool_name/,
    );
  });

  it('throws when tool_name is non-string', () => {
    expect(() =>
      parsePayload(JSON.stringify({ tool_name: 42, tool_input: {} })),
    ).toThrow(/tool_name/);
  });

  it('throws when tool_input is missing', () => {
    expect(() => parsePayload(JSON.stringify({ tool_name: 'Write' }))).toThrow(
      /tool_input/,
    );
  });

  it('throws when payload is not an object', () => {
    expect(() => parsePayload(JSON.stringify(null))).toThrow(/object/);
    expect(() => parsePayload(JSON.stringify('str'))).toThrow(/object/);
  });
});

describe('formatDenyResponse', () => {
  it('emits claude PreToolUse protocol JSON', () => {
    const out = JSON.parse(formatDenyResponse('because reasons'));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'because reasons',
      },
    });
  });
});

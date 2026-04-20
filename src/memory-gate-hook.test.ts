import { describe, expect, it } from 'vitest';

import {
  evaluate,
  formatDenyResponse,
  HookPayload,
} from './memory-gate-hook.js';

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

describe('evaluate', () => {
  it('allows non-Write tool calls', () => {
    expect(
      evaluate(
        {
          tool_name: 'Edit',
          tool_input: { file_path: `${memoryDir}/x.md`, content: 'y' },
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

  it('allows Write to MEMORY.md index', () => {
    expect(
      evaluate(write(`${memoryDir}/MEMORY.md`, '- link'), memoryDir),
    ).toEqual({ kind: 'allow' });
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
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') throw new Error('unreachable');
    expect(result.reason).toMatch(/memory-gate.*frontmatter/i);
  });

  it('denies Write with non-admin source', () => {
    const content = VALID_TOPIC.replace(
      'source: admin_commit',
      'source: slack_message',
    );
    const result = evaluate(write(`${memoryDir}/x.md`, content), memoryDir);
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') throw new Error('unreachable');
    expect(result.reason).toMatch(/non-admin.*slack_message/i);
  });

  it('denies Write with missing tool_input fields', () => {
    const result = evaluate(
      { tool_name: 'Write', tool_input: {} },
      memoryDir,
    );
    expect(result.kind).toBe('deny');
    if (result.kind !== 'deny') throw new Error('unreachable');
    expect(result.reason).toMatch(/missing file_path or content/i);
  });

  it('denies Write with non-string file_path', () => {
    const result = evaluate(
      {
        tool_name: 'Write',
        tool_input: { file_path: undefined, content: 'x' },
      },
      memoryDir,
    );
    expect(result.kind).toBe('deny');
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

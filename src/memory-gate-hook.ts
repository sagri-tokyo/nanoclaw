#!/usr/bin/env node
// PreToolUse hook: enforces memory provenance on Write / Edit / MultiEdit
// calls targeting SAGRI_MEMORY_DIR. For Edit and MultiEdit, the gate
// simulates the resulting on-disk content and applies the same provenance
// checks used for Write. This closes the laundering bypass described in
// sagri-ai#61 — where an admin-provenanced topic could be written via Write
// and then have its `source` field stripped or mutated via Edit without
// re-triggering the gate.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideWrite, isInsideMemoryDir } from './memory-gate.js';

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface HookPayload {
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    edits?: unknown;
  };
}

export type HookOutput = { kind: 'allow' } | { kind: 'deny'; reason: string };

// Returns the current file content, or `null` when the file does not exist
// (ENOENT). Any other I/O failure should throw — this signal is reserved
// strictly for "file not found", so downstream code can treat `null` as
// "simulate against an empty buffer" for new-file edits.
export type CurrentContentReader = (filePath: string) => string | null;

export function parsePayload(raw: string): HookPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object')
    throw new Error('hook payload: not an object');
  const p = parsed as Record<string, unknown>;
  if (typeof p.tool_name !== 'string')
    throw new Error('hook payload: tool_name missing or not a string');
  if (!p.tool_input || typeof p.tool_input !== 'object')
    throw new Error('hook payload: tool_input missing or not an object');
  return {
    tool_name: p.tool_name,
    tool_input: p.tool_input as HookPayload['tool_input'],
  };
}

const defaultReader: CurrentContentReader = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

function applyEdit(
  current: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  // Empty old_string is handled explicitly. MultiEdit's first-edit empty
  // old_string is documented as "create new file" (current === ''), which
  // reduces to newString. For non-empty current, String.prototype.replace
  // with '' prepends, and `split('').join(new)` would interleave new
  // between every character — a distinct, nonsense result. Unifying both
  // cases as `newString + current` keeps behavior predictable regardless
  // of `replaceAll`, and the gate still validates the simulated result
  // against decideWrite (which rejects anything that does not start with
  // valid frontmatter, so prepended non-frontmatter content denies).
  if (oldString === '') return newString + current;
  if (replaceAll) return current.split(oldString).join(newString);
  const idx = current.indexOf(oldString);
  // No-match is a no-op: claude-code errors at runtime and no file change
  // occurs. Simulating with unchanged content is safe — the gate either
  // allowed the prior state or it was created under a prior policy, and
  // either way nothing is written.
  if (idx === -1) return current;
  return (
    current.slice(0, idx) + newString + current.slice(idx + oldString.length)
  );
}

function parseEdits(raw: unknown): EditSpec[] {
  if (!Array.isArray(raw)) throw new Error('MultiEdit edits must be an array');
  if (raw.length === 0) throw new Error('MultiEdit edits must be non-empty');
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object')
      throw new Error(`MultiEdit edits[${index}] must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.old_string !== 'string')
      throw new Error(`MultiEdit edits[${index}].old_string must be a string`);
    if (typeof e.new_string !== 'string')
      throw new Error(`MultiEdit edits[${index}].new_string must be a string`);
    const replaceAll = e.replace_all;
    if (replaceAll !== undefined && typeof replaceAll !== 'boolean')
      throw new Error(
        `MultiEdit edits[${index}].replace_all must be a boolean`,
      );
    return {
      old_string: e.old_string,
      new_string: e.new_string,
      replace_all: replaceAll === true,
    };
  });
}

// Produces either the final on-disk content a Write / Edit / MultiEdit
// would leave behind, or a `deny` HookOutput if the payload is malformed.
// Returning `null` means the tool call is outside the hook's scope (e.g.
// reading a non-edit tool, or an Edit/MultiEdit targeting a path outside
// memoryDir). Called by `evaluate`; factored out so the branching logic
// does not interleave with the single downstream `decideWrite` call.
function simulateFinalContent(
  toolName: string,
  input: HookPayload['tool_input'],
  filePath: string,
  memoryDir: string,
  readCurrentContent: CurrentContentReader,
): { kind: 'content'; value: string } | { kind: 'allow' } | HookOutput {
  if (toolName === 'Write') {
    if (typeof input.content !== 'string')
      return {
        kind: 'deny',
        reason: 'memory-gate: Write payload missing content',
      };
    return { kind: 'content', value: input.content };
  }

  if (toolName === 'Edit') {
    if (
      typeof input.old_string !== 'string' ||
      typeof input.new_string !== 'string'
    )
      return {
        kind: 'deny',
        reason: 'memory-gate: Edit payload missing old_string or new_string',
      };
    if (
      input.replace_all !== undefined &&
      typeof input.replace_all !== 'boolean'
    )
      return {
        kind: 'deny',
        reason: 'memory-gate: Edit replace_all must be a boolean',
      };
    if (!isInsideMemoryDir(filePath, memoryDir)) return { kind: 'allow' };
    const current = readCurrentContent(filePath) ?? '';
    const value = applyEdit(
      current,
      input.old_string,
      input.new_string,
      input.replace_all === true,
    );
    return { kind: 'content', value };
  }

  // MultiEdit
  let edits: EditSpec[];
  try {
    edits = parseEdits(input.edits);
  } catch (err) {
    return { kind: 'deny', reason: `memory-gate: ${(err as Error).message}` };
  }
  if (!isInsideMemoryDir(filePath, memoryDir)) return { kind: 'allow' };
  let content = readCurrentContent(filePath) ?? '';
  for (const edit of edits) {
    content = applyEdit(
      content,
      edit.old_string,
      edit.new_string,
      edit.replace_all === true,
    );
  }
  return { kind: 'content', value: content };
}

export function evaluate(
  payload: HookPayload,
  memoryDir: string,
  readCurrentContent: CurrentContentReader = defaultReader,
): HookOutput {
  const { tool_name: toolName, tool_input: input } = payload;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit')
    return { kind: 'allow' };

  const filePath = input.file_path;
  if (typeof filePath !== 'string')
    return {
      kind: 'deny',
      reason: `memory-gate: ${toolName} payload missing file_path`,
    };

  const simulated = simulateFinalContent(
    toolName,
    input,
    filePath,
    memoryDir,
    readCurrentContent,
  );
  if (simulated.kind === 'allow') return { kind: 'allow' };
  if (simulated.kind === 'deny') return simulated;

  const decision = decideWrite({
    filePath,
    content: simulated.value,
    memoryDir,
  });
  if (decision.allow) return { kind: 'allow' };
  return { kind: 'deny', reason: `memory-gate: ${decision.reason}` };
}

export function formatDenyResponse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const memoryDir = process.env.SAGRI_MEMORY_DIR;
  if (!memoryDir) {
    process.stderr.write('memory-gate-hook: SAGRI_MEMORY_DIR not set\n');
    process.stdout.write(
      formatDenyResponse('memory-gate: SAGRI_MEMORY_DIR not configured'),
    );
    process.exit(2);
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);
  const result = evaluate(payload, memoryDir);
  if (result.kind === 'deny') {
    process.stdout.write(formatDenyResponse(result.reason));
    process.exit(2);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) void main();

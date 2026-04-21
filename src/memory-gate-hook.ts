#!/usr/bin/env node
// PreToolUse hook: enforces memory provenance on Write calls targeting SAGRI_MEMORY_DIR.
// Edit/MultiEdit not covered; tracked as follow-up.
import { fileURLToPath } from 'node:url';

import { decideWrite } from './memory-gate.js';

export interface HookPayload {
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
  };
}

export type HookOutput = { kind: 'allow' } | { kind: 'deny'; reason: string };

export function parsePayload(raw: string): HookPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object')
    throw new Error('hook payload: not an object');
  const p = parsed as Record<string, unknown>;
  if (typeof p.tool_name !== 'string')
    throw new Error('hook payload: tool_name missing or not a string');
  if (!p.tool_input || typeof p.tool_input !== 'object')
    throw new Error('hook payload: tool_input missing or not an object');
  return { tool_name: p.tool_name, tool_input: p.tool_input as HookPayload['tool_input'] };
}

export function evaluate(payload: HookPayload, memoryDir: string): HookOutput {
  if (payload.tool_name !== 'Write') return { kind: 'allow' };

  const { file_path: filePath, content } = payload.tool_input;

  if (typeof filePath !== 'string' || typeof content !== 'string')
    return {
      kind: 'deny',
      reason: 'memory-gate: Write payload missing file_path or content',
    };

  const decision = decideWrite({ filePath, content, memoryDir });
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

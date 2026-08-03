import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Per-capability-profile tool allowlist (sagri-ai#649, closing the #312 TODO).
 *
 * `operator` is the interactive assistant profile: it holds no org-write token,
 * so every write already has to route through the host-executed `org_action`
 * gate, and the human driving it needs the full research and subagent surface.
 *
 * `trusted-writer` is the opposite trade. It runs only the four registered
 * ScheduledTask prompts (notion-poller, dsm-experiment-poller,
 * dsm-experiment-submitter, raw-ingest) and it is the profile that has the
 * Notion and GitHub tokens mounted, so it gets the strict subset: no raw
 * WebFetch (untrusted bytes must arrive laundered via `fetch_untrusted`, per
 * the D4.1 reader/actor split), no subagent teams, and none of the scheduler
 * administration tools — an injected prompt must not be able to reprogram or
 * cancel the fleet's own cron entries while holding a write credential.
 *
 * The lists below are mirrored by the reviewed manifest at
 * `container/agent-runner/tool-allowlist.json`; `tool-allowlist.test.ts` fails
 * CI when the two disagree.
 */
export const toolAllowlistByProfile = {
  operator: [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__pause_task',
    'mcp__nanoclaw__resume_task',
    'mcp__nanoclaw__cancel_task',
    'mcp__nanoclaw__update_task',
    'mcp__nanoclaw__register_group',
    'mcp__nanoclaw__fetch_untrusted',
    'mcp__nanoclaw__fetch_untrusted_list',
    'mcp__nanoclaw__org_action',
    'mcp__nanoclaw__report_outcome',
  ],
  'trusted-writer': [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__fetch_untrusted',
    'mcp__nanoclaw__fetch_untrusted_list',
    'mcp__nanoclaw__org_action',
    'mcp__nanoclaw__report_outcome',
  ],
} as const;

export type CapabilityProfile = keyof typeof toolAllowlistByProfile;

export const TOOL_ALLOWLIST_MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tool-allowlist.json',
);

/**
 * An absent profile resolves to `operator`, matching the host: `buildContainerPlan`
 * resolves the same absence the same way, so a container with no declared profile
 * was mounted without either write token.
 */
export function allowedToolsFor(
  profile: CapabilityProfile | undefined,
): string[] {
  const resolved = profile ?? 'operator';
  const tools = toolAllowlistByProfile[resolved];
  if (tools === undefined) {
    throw new Error(`unknown capability profile: ${resolved}`);
  }
  return [...tools];
}

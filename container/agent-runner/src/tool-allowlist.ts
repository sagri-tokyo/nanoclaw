/**
 * Per-capability-profile tool allowlist (sagri-ai#649, closing the sagri-ai#312
 * TODO).
 *
 * `operator` is the interactive assistant profile: it holds no org-write token,
 * so every write already has to route through the host-executed `org_action`
 * gate, and the human driving it needs the full research and subagent surface.
 *
 * `trusted-writer` is the profile the Notion and GitHub tokens are mounted for.
 * It backs the registered ScheduledTask prompts: notion-poller,
 * dsm-experiment-poller and dsm-experiment-submitter today, raw-ingest once its
 * infra flag lands. It drops the reach those prompts never use: WebFetch and
 * WebSearch, subagent teams, NotebookEdit, and the scheduler administration
 * tools. `research-assistant` is why WebSearch goes too: it gathers evidence
 * with curl through the reader RPC, so a search tool would be an unlaundered
 * read straight into the token-holding container.
 *
 * A granted-but-unused tool would mean this list was never really reviewed, so
 * each one that stays has a reason:
 *   Bash                    every prompt runs shell blocks
 *   Read Write Edit         raw-ingest writes and re-reads its dumps
 *   Glob Grep               local workspace search
 *   Skill                   org-actions, notion-writer, dsm-experiment
 *   TodoWrite ToolSearch    agent-internal bookkeeping, no external reach
 *   send_message            operator progress outside the structured reply
 *   fetch_untrusted_list    the laundered enumeration path, used by all four
 *   fetch_untrusted         the laundered per-item read, used by raw-ingest
 *   org_action              notion-poller's write-back contract
 *   report_outcome          host-enforced. A tick that reports nothing is
 *                           logged failed (`src/task-scheduler.ts`), so a
 *                           scheduled task cannot run without it
 * The file tools grant nothing `Bash` does not already reach, and `Bash` has to
 * stay, so they are here for ergonomics rather than capability.
 *
 * What that subset is and is not worth: it narrows what an injected prompt
 * reaches for, and it is not a containment boundary. Both profiles keep `Bash`,
 * the image ships curl, and container egress is unrestricted, so dropping
 * WebFetch does not make laundered reads the only way bytes arrive
 * (sagri-ai#86). Nor does denying `trusted-writer` the scheduler tools protect
 * the cron entries: `operator` keeps them, and the host authorizes a main-group
 * container to update any task's prompt (`src/ipc.ts`, the `!isMain &&` guard),
 * which is a cross-profile escalation this file cannot close (sagri-ai#651).
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

/**
 * An absent profile resolves to `operator`, matching the host: `buildContainerPlan`
 * resolves the same absence the same way, so a container with no declared profile
 * was mounted without either write token.
 *
 * The parameter is `string`, not `CapabilityProfile`, because that is what the
 * caller has: `capabilityProfile` arrives as unvalidated stdin JSON. Hence
 * `hasOwn` rather than an `undefined` check, since a value like `constructor`
 * resolves through the prototype and would throw a TypeError instead of naming
 * the input.
 */
export function allowedToolsFor(profile: string | undefined): string[] {
  const resolved = profile ?? 'operator';
  if (!Object.hasOwn(toolAllowlistByProfile, resolved)) {
    throw new Error(`unknown capability profile: ${resolved}`);
  }
  return [...toolAllowlistByProfile[resolved as CapabilityProfile]];
}

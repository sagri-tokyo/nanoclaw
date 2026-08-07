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
 * Two kinds of entry stay on the `trusted-writer` list, and they are worth
 * telling apart. These have a named consumer today:
 *   Bash                    every prompt runs shell blocks
 *   Skill                   org-actions, notion-writer, dsm-experiment
 *   Read Write Edit         raw-ingest writes and re-reads its dumps
 *   fetch_untrusted_list    the laundered enumeration path, used by all four
 *   fetch_untrusted         the laundered per-item read, used by raw-ingest
 *   org_action              notion-poller's write-back contract
 *
 * These have none, and ride along because they add no reach over `Bash`, which
 * has to stay: Glob, Grep, TodoWrite, ToolSearch, send_message. Denying them
 * would buy nothing an attacker could not do with a shell.
 *
 * `report_outcome` is the honest exception. The host derives a scheduled run's
 * status from it and logs a silent tick as failed, but only for `reply_mode =
 * structured` (`deriveStructuredRunError`, `src/task-scheduler.ts`), and every
 * registered task today runs the default text mode and never calls it. It is
 * granted for the structured-mode tasks this profile is meant to carry, not
 * because anything uses it yet.
 *
 * How this is enforced matters, because the obvious reading is wrong, and the
 * two options each cover half the surface.
 *
 * Built-ins go through `tools`, the SDK's positive base set, which disables
 * every built-in it omits. The SDK's `allowedTools` is not that option: it only
 * auto-approves without prompting, and the runner sets `permissionMode:
 * 'bypassPermissions'`, so a name's absence from it removes nothing.
 *
 * MCP tools go through `disallowedTools`, because `tools` does not gate them. An
 * `mcp__` name in `tools` is accepted and every other MCP tool stays available
 * anyway, so `deniedToolsFor` has to keep reaching `disallowedTools`; dropping
 * it as redundant would hand `trusted-writer` the scheduler surface back.
 *
 * Omission is therefore the whole grant, which narrows `operator` as well as
 * `trusted-writer`: the plan-mode, worktree, cron, remote-trigger and
 * `AskUserQuestion` built-ins are off for both. That is deliberate. Every
 * container runs headless under `bypassPermissions` with no human at a terminal
 * to answer a question or approve a plan, and nanoclaw schedules through its own
 * MCP tools rather than the SDK's cron. `tool-allowlist.test.ts` pins the list
 * against a captured SDK surface, so a version that adds a built-in fails CI
 * until someone decides which profile should hold it (sagri-ai#668).
 *
 * What that subset is and is not worth: it narrows what an injected prompt
 * reaches for, and it is not a containment boundary. Both profiles keep `Bash`,
 * the image ships curl, and container egress is unrestricted, so dropping
 * WebFetch does not make laundered reads the only way bytes arrive
 * (sagri-ai#86). Nor does denying the scheduler tools protect the cron entries.
 * Those tools deliver by writing a JSON file into the `/workspace/ipc` mount,
 * and `Bash` writes that file just as well, so the denial takes them off the
 * model's menu without taking them out of the container's reach. The host does
 * recompute `isMain` from the directory path, so a forged file cannot claim to
 * be the main group, but a task already running there can still rewrite any
 * task's prompt (sagri-ai#651).
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

/**
 * The tools this profile does not get, as `disallowedTools` wants them.
 *
 * Taken against `operator` because that is the widest profile, so the result is
 * what this profile gives up relative to the full surface. `operator` returns an
 * empty list here, which is not the same as denying nothing: `tools` still holds
 * it to the built-ins it names.
 *
 * The built-in names here are already redundant with `tools`, which disables
 * them by omission. They stay because the `mcp__` names are not: `tools` does
 * not gate MCP tools, so this list is the only thing denying them.
 */
export function deniedToolsFor(profile: string | undefined): string[] {
  const granted = new Set(allowedToolsFor(profile));
  return toolAllowlistByProfile.operator.filter((tool) => !granted.has(tool));
}

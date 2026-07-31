import fs from 'fs';
import path from 'path';

import { loadEnvIntoProcess } from './env.js';
import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  READER_RPC_PORT,
  SLACK_THREAD_CONTEXT_LIMIT,
  SLACK_THREAD_FOLLOWUPS,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { startReaderRpc } from './reader-rpc.js';
import { judgeShouldReply } from './reader.js';
import { buildPromptWithOptionalFiles } from './file-prompt.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  getProxyBindHost,
} from './container-runtime.js';
import {
  getAllChats,
  botRepliedInThread,
  getAllRegisteredGroups,
  deleteSession,
  deleteAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue, abortActionRecord, abortMessage } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { handleInboundMessage } from './inbound.js';
import { connectChannel } from './channel-startup.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessagesViaReader,
  formatOutbound,
  isTriggerRequired,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { loadApproverAllowlist } from './approver-allowlist.js';
import { parseApprovalIntent } from './approval-trigger.js';
import { executeOrgAction, resolveNotionTarget } from './org-action-clients.js';
import { requireEnv } from './fetch-untrusted.js';
import { expirePendingActions } from './db.js';
import {
  driveOrgActionRequest,
  handleApprovalReply,
  reDriveApprovedActions,
  type OrgActionGateDeps,
} from './org-action-handler.js';
import {
  addRunRequesters,
  clearRunRequestersForGroup,
  getRunRequesters,
} from './run-requesters.js';
import { startSessionCleanup } from './session-cleanup.js';
import { requestSessionReset, takeSessionReset } from './session-reset.js';
import { formatErrorWrap, startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { hashPayload, logger } from './logger.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/**
 * Forget a group's session everywhere it is held. The requester attribution goes
 * with it: a session the agent will not resume can no longer put anyone's
 * instruction in context, and leaving the set behind would strand it (see
 * `run-requesters.ts`).
 */
function dropSession(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
  clearRunRequestersForGroup(groupFolder);
  // Any reset owed to this group is already satisfied, whatever asked for it.
  // Leaving it parked would fire a second drop at the next launch and log a
  // gate reset for a run that had nothing to reset.
  takeSessionReset(groupFolder);
}

/**
 * The group's session id for the run about to launch, dropping it first if the
 * org-action gate asked for a reset (sagri-ai#629). Named for the write, not the
 * read: calling it clears the group's session and its requester attribution.
 * Scoped to one group on purpose; `session-reset.ts` says why a global flush
 * would be wrong.
 */
function sessionForNextRun(groupFolder: string): string | undefined {
  if (takeSessionReset(groupFolder)) {
    dropSession(groupFolder);
    logger.info(
      { groupFolder },
      'Applying the org-action gate session reset — this run starts fresh',
    );
  }
  return sessions[groupFolder];
}

const channels: Channel[] = [];
const queue = new GroupQueue();
const activeThreadByChatJid = new Map<string, string | undefined>();
const queuedThreadFollowupCandidates = new Map<string, string>();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  // Sessions do not survive the process, because their requester attribution
  // does not (sagri-ai#629). Resuming one the host can no longer attribute would
  // refuse every gated action in that group with no way back.
  const carriedOver = deleteAllSessions();
  if (carriedOver > 0) {
    logger.info(
      { groupCount: carriedOver },
      'Dropped sessions carried across a restart — attribution does not survive the process',
    );
  }
  sessions = {};
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

interface ThreadFollowupCandidate {
  threadId: string;
}

interface ExplicitTriggerMessage {
  // The Slack thread the trigger lives in, or undefined for a top-level
  // message. Drives whether thread context is fetched (SLACK_THREAD_FOLLOWUPS).
  threadId?: string;
  // The trigger's own ts. Always the reply anchor, so an outbound never falls
  // back to the channel's mutable lastThreadTs map.
  anchorTs: string;
}

function isAllowedTriggerMessage(
  chatJid: string,
  msg: NewMessage,
  allowlistCfg: ReturnType<typeof loadSenderAllowlist>,
): boolean {
  return (
    msg.is_from_me === true ||
    isTriggerAllowed(chatJid, msg.sender, allowlistCfg)
  );
}

function isEligibleHumanMessage(
  chatJid: string,
  msg: NewMessage,
  allowlistCfg: ReturnType<typeof loadSenderAllowlist>,
): boolean {
  return (
    msg.is_from_me !== true &&
    msg.is_bot_message !== true &&
    isTriggerAllowed(chatJid, msg.sender, allowlistCfg)
  );
}

/** @internal - exported for testing */
export function findExplicitTriggerMessage(
  chatJid: string,
  msgs: NewMessage[],
  group: RegisteredGroup,
): ExplicitTriggerMessage | null {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const message = msgs[i];
    if (
      triggerPattern.test(message.content.trim()) &&
      isAllowedTriggerMessage(chatJid, message, allowlistCfg)
    ) {
      return { threadId: message.thread_id, anchorTs: message.id };
    }
  }
  return null;
}

// The most recent non-bot message in a batch: the one a human actually sent,
// used both to attribute a run and to anchor its processing indicator. Skipping
// bot messages keeps a trailing bot echo from being treated as the trigger.
export function newestHumanMessage(
  messages: NewMessage[],
): NewMessage | undefined {
  return [...messages].reverse().find((m) => !m.is_bot_message);
}

/**
 * Distinct human senders of a prompt batch, in first-seen order (sagri-ai#296).
 * See `org-action-handler.ts` for why the approval gate needs all of them.
 *
 * @internal - exported for testing
 */
export function humanSenders(messages: NewMessage[]): string[] {
  return [
    ...new Set(messages.filter((m) => !m.is_bot_message).map((m) => m.sender)),
  ];
}

/**
 * Reply anchor for a batch with no explicit trigger (a requiresTrigger:false
 * group that proceeds anyway): the newest human message's thread, else its own
 * ts. Skips trailing bot messages so the anchor tracks the human being
 * answered. The bot-skip is belt-and-suspenders at the current call site —
 * getMessagesSince already filters bot rows — but keeps the helper correct for
 * any future caller passing unfiltered messages.
 *
 * @internal - exported for testing
 */
export function newestHumanThreadAnchor(
  messages: NewMessage[],
): string | undefined {
  const anchor = newestHumanMessage(messages);
  return anchor?.thread_id ?? anchor?.id;
}

/**
 * Is the newest allow-listed human message in `msgs` a reply in a thread the
 * bot has already posted in? Such a no-mention follow-up is a candidate for
 * the should-reply judge. Returns the thread id, or null. Gated by
 * SLACK_THREAD_FOLLOWUPS.
 */
function threadFollowupCandidate(
  chatJid: string,
  msgs: NewMessage[],
): ThreadFollowupCandidate | null {
  if (!SLACK_THREAD_FOLLOWUPS) return null;
  const allowlistCfg = loadSenderAllowlist();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!isEligibleHumanMessage(chatJid, m, allowlistCfg)) continue;
    if (
      m.thread_id &&
      botRepliedInThread(chatJid, m.thread_id, ASSISTANT_NAME)
    ) {
      return { threadId: m.thread_id };
    }
    return null; // newest eligible message isn't a bot-thread follow-up
  }
  return null;
}

function consumeQueuedThreadFollowupCandidate(
  chatJid: string,
  msgs: NewMessage[],
): ThreadFollowupCandidate | null {
  const threadId = queuedThreadFollowupCandidates.get(chatJid);
  if (!threadId) return null;

  queuedThreadFollowupCandidates.delete(chatJid);

  const allowlistCfg = loadSenderAllowlist();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!isEligibleHumanMessage(chatJid, m, allowlistCfg)) continue;
    return m.thread_id === threadId ? { threadId } : null;
  }
  return null;
}

/**
 * Render a thread compactly and ask the should-reply judge. Fails closed
 * (returns false) on any judge error so a no-mention candidate is not answered
 * on uncertainty.
 */
async function runShouldReplyJudge(
  chatJid: string,
  threadId: string,
  thread: NewMessage[],
): Promise<boolean> {
  const rendered = thread
    .map(
      (m) =>
        `${m.is_bot_message ? ASSISTANT_NAME : m.sender_name}: ${m.content}`,
    )
    .join('\n')
    .slice(0, 8000);
  try {
    const verdict = await judgeShouldReply(rendered, ASSISTANT_NAME);
    logger.info(
      {
        chatJid,
        threadId,
        should_reply: verdict.should_reply,
        reason_hash: hashPayload(verdict.reason),
        reason_length: verdict.reason.length,
      },
      'Thread follow-up judge verdict',
    );
    return verdict.should_reply;
  } catch (err) {
    logger.warn(
      { chatJid, threadId, err },
      'should-reply judge failed; not replying',
    );
    return false;
  }
}

/** Merge thread history with the missed batch (dedupe by id, chronological, capped). */
function mergeThreadContext(
  thread: NewMessage[],
  missed: NewMessage[],
): NewMessage[] {
  const byId = new Map<string, NewMessage>();
  for (const m of thread) byId.set(m.id, m);
  for (const m of missed) byId.set(m.id, m);
  return [...byId.values()]
    .sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    )
    .slice(-SLACK_THREAD_CONTEXT_LIMIT);
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Explicit @mention trigger (today's behaviour). No-trigger groups always
  // proceed, but thread targeting only follows the actual trigger.
  const explicitTrigger = findExplicitTriggerMessage(
    chatJid,
    missedMessages,
    group,
  );
  const triggered = !isTriggerRequired(group) || explicitTrigger !== null;

  // Anchor the reply to the triggering message's own ts, so sendMessage never
  // falls back to the channel's live lastThreadTs map (which a faster
  // concurrent request can overwrite while this one runs). Thread context for
  // the prompt is a separate concern, opt-in behind SLACK_THREAD_FOLLOWUPS and
  // only for a trigger that actually lives inside a thread.
  let targetThreadId: string | undefined =
    explicitTrigger?.threadId ?? explicitTrigger?.anchorTs;
  let useThreadContext = false;
  if (SLACK_THREAD_FOLLOWUPS && explicitTrigger?.threadId) {
    useThreadContext = true;
  } else if (!triggered) {
    const candidate =
      consumeQueuedThreadFollowupCandidate(chatJid, missedMessages) ??
      threadFollowupCandidate(chatJid, missedMessages);
    if (!candidate) return true; // not a trigger and not a follow-up — keep as context
    targetThreadId = candidate.threadId;
    useThreadContext = true;
  }

  // A requiresTrigger:false group proceeds without a matching @mention, so no
  // explicit trigger anchors the reply. Fall back to the newest human message's
  // own ts — never the live lastThreadTs map.
  if (!targetThreadId) {
    targetThreadId = newestHumanThreadAnchor(missedMessages);
  }

  // Fetch thread context once (used by the judge and/or the prompt).
  let threadMessages: NewMessage[] | null = null;
  if (useThreadContext && targetThreadId && channel.fetchThread) {
    try {
      const t = await channel.fetchThread(
        chatJid,
        targetThreadId,
        SLACK_THREAD_CONTEXT_LIMIT,
      );
      threadMessages = t.length > 0 ? t : null;
    } catch (err) {
      logger.warn({ chatJid, targetThreadId, err }, 'Thread fetch failed');
      threadMessages = null;
    }
  }

  // No-mention follow-up: ask the judge before responding. Fail closed if the
  // thread couldn't be fetched. Consume the cursor on a no/failure so the same
  // batch is not re-judged forever.
  if (!triggered) {
    const decided =
      targetThreadId && threadMessages
        ? await runShouldReplyJudge(chatJid, targetThreadId, threadMessages)
        : false;
    if (!decided) {
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }
  }

  // Build the prompt: full laundered thread when available (original question
  // + the bot's own prior replies), else the missed-message batch. Append any
  // laundered file attachments (opt-in; no-op when the flag is off).
  const promptMessages =
    threadMessages && threadMessages.length > 0
      ? mergeThreadContext(threadMessages, missedMessages)
      : missedMessages;
  const basePrompt = await formatMessagesViaReader(promptMessages, TIMEZONE);
  const prompt = await buildPromptWithOptionalFiles(
    promptMessages,
    channel,
    basePrompt,
  );

  // OTel enduser.id (RFC 0001 Phase 1): the human who triggered this run — the
  // most recent non-bot sender in the prompt batch. Undefined when the batch
  // carries no human message; for an interactive run the telemetry layer then
  // disables telemetry for that spawn (no trace reaches Langfuse) rather than
  // fabricating identity. The namespaced unattributed placeholder applies only
  // to scheduled tasks.
  const triggeringUserId = newestHumanMessage(promptMessages)?.sender;

  // Requester attribution for the org-action approval gate (sagri-ai#296), over
  // the same prompt the agent acts on. Merged thread context counts: an
  // instruction the agent reads from a thread drove the write whether or not its
  // author sent one of this batch's new messages.
  const requesterIds = humanSenders(promptMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.debug(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  const actionStart = Date.now();
  const interactiveRunId = `interactive-${group.folder}-${actionStart}`;
  const inputsHash = hashPayload(prompt);
  let aggregatedOutput = '';

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Anchor the processing indicator to the message that triggered this run: the
  // explicit @mention when there is one, else the newest human message in the
  // batch. Never the channel's live lastThreadTs (a concurrent message races it).
  const reactionTs =
    explicitTrigger?.anchorTs ?? newestHumanMessage(missedMessages)?.id;
  await channel.setTyping?.(chatJid, true, reactionTs);
  let hadError = false;
  let outputSentToUser = false;

  activeThreadByChatJid.set(chatJid, targetThreadId);
  try {
    const output = await runAgent(
      group,
      prompt,
      chatJid,
      triggeringUserId,
      requesterIds,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.debug(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          aggregatedOutput += raw;
          if (text) {
            await channel.sendMessage(
              chatJid,
              formatErrorWrap(text, {
                runId: interactiveRunId,
                now: new Date(),
              }),
              targetThreadId
                ? { target: { kind: 'thread', id: targetThreadId } }
                : undefined,
            );
            outputSentToUser = true;
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'success') {
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    const sessionId = sessions[group.folder] || group.folder;
    const failed = output === 'error' || hadError;
    logger.action({
      ts: new Date().toISOString(),
      level: failed ? 'error' : 'info',
      session_id: sessionId,
      trigger: 'slack',
      trigger_source: chatJid,
      tool: 'message_handle',
      inputs_hash: inputsHash,
      outputs_hash: hashPayload(aggregatedOutput),
      duration_ms: Date.now() - actionStart,
      outcome: failed ? 'error' : 'ok',
      error_class: failed ? 'AgentError' : null,
      group: group.folder,
    });

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor —
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  } finally {
    activeThreadByChatJid.delete(chatJid);
    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  triggeringUserId: string | undefined,
  requesterIds: string[],
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessionForNextRun(group.folder);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        triggeringUserId,
        requesterIds,
        // Interactive (operator-triggered) messages never get the org-write
        // tokens; all writes route through the host-executed org_action gate
        // (sagri-ai#312).
        capabilityProfile: 'operator',
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        dropSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const needsTrigger = isTriggerRequired(group);
          const explicitTrigger = findExplicitTriggerMessage(
            chatJid,
            groupMessages,
            group,
          );

          // For trigger-required groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            if (!explicitTrigger) {
              // No explicit @mention. In thread-followups mode, a reply in a
              // thread the bot is part of is a candidate — hand it to
              // processGroupMessages (which runs the should-reply judge and
              // assembles thread context). Never pipe a non-explicit batch to
              // an active container.
              const candidate = threadFollowupCandidate(chatJid, groupMessages);
              if (candidate) {
                queuedThreadFollowupCandidates.set(chatJid, candidate.threadId);
                queue.enqueueMessageCheck(chatJid);
              }
              continue;
            }
          }

          if (SLACK_THREAD_FOLLOWUPS && activeThreadByChatJid.has(chatJid)) {
            const activeThreadId = activeThreadByChatJid.get(chatJid);
            const hasDifferentThread = groupMessages.some(
              (m) => m.thread_id !== activeThreadId,
            );
            if (hasDifferentThread) {
              queue.enqueueMessageCheck(chatJid);
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = await formatMessagesViaReader(
            messagesToSend,
            TIMEZONE,
          );
          const piped = await buildPromptWithOptionalFiles(
            messagesToSend,
            channel,
            formatted,
          );

          if (queue.sendMessage(chatJid, piped)) {
            // A piped batch skips a fresh launch, so add its senders here
            // (sagri-ai#296); see addRunRequesters.
            addRunRequesters(group.folder, humanSenders(messagesToSend));
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Ack the piped human message too, so it's cleared with the rest at
            // run end. Skip a trailing bot echo (same filter as the run-start
            // anchor) so the hourglass never lands on the assistant's own message.
            channel
              .setTyping?.(
                chatJid,
                true,
                newestHumanMessage(messagesToSend)?.id,
              )
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Load .env into process.env so host env forwarding can resolve var values.
  // Values already set in the environment (e.g. from the shell) take precedence.
  loadEnvIntoProcess();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  const proxyBindHost = getProxyBindHost();
  logger.info(
    { host: proxyBindHost },
    'Credential proxy and reader RPC bind address resolved',
  );

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    proxyBindHost,
  );

  // Start reader RPC (containers launder untrusted fetches through this)
  const readerRpcServer = await startReaderRpc(READER_RPC_PORT, proxyBindHost);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    readerRpcServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Kill-switch real wiring (sagri-tokyo/sagri-ai#129). Asks the queue to
  // docker-stop the active container for the channel and posts a single
  // confirmation back through the channel that delivered the trigger.
  async function handleAbort(chatJid: string, _msg: NewMessage): Promise<void> {
    const startedAt = Date.now();
    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'Abort intent: no channel owns JID');
      return;
    }
    const result = queue.abort(chatJid);
    await channel.sendMessage(chatJid, abortMessage(result));
    logger.action(abortActionRecord(chatJid, result, Date.now() - startedAt));
  }

  // Org-action approval gate (D2.4). Dependencies are re-read per call so an
  // operator edit to the approver allowlist takes effect without a restart. The
  // host owns NOTION_API_KEY / GITHUB_TOKEN in its own process.env (the same
  // accessor the read fetchers use); the container never holds the write client.
  const orgActionDeps: OrgActionGateDeps = {
    approvers: () => loadApproverAllowlist(),
    requestSessionReset,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'org-action: no channel owns JID for prompt');
        return;
      }
      await channel.sendMessage(jid, text);
    },
    executeAction:
      process.env.NANOCLAW_STUB_ORG_WRITES === '1'
        ? async (request) => {
            // Log identity only, not canonical_args: an arg carrying a
            // secret-shaped value would trip the redaction sentinel and reject
            // the (suppressed) stub write. The hash keeps args correlatable.
            // canonical_args is JSON.parse-sourced, so hashPayload cannot throw
            // on undefined/BigInt here.
            logger.warn(
              {
                action: request.action,
                target_ref: request.target_ref,
                canonical_args_hash: hashPayload(request.canonical_args),
              },
              'org-action STUB: external write suppressed (NANOCLAW_STUB_ORG_WRITES=1)',
            );
          }
        : async (request) =>
            executeOrgAction(request, {
              notionApiKey: requireEnv('NOTION_API_KEY'),
              githubToken: requireEnv('GITHUB_TOKEN'),
              sendDigest: async (channelId, text) => {
                const jid = `slack:${channelId}`;
                const channel = findChannel(channels, jid);
                if (!channel) {
                  throw new Error(`org-action digest: no channel owns ${jid}`);
                }
                await channel.sendMessage(jid, text);
              },
            }),
    // Host-side Notion name resolution (sagri-ai#346). The operator container
    // has no NOTION_API_KEY after sagri-ai#312, so it cannot resolve a page
    // name to an id in-container; the host (which holds the token) does it
    // before classification. A read, so it runs even under the write stub.
    resolveNotionTarget: (query) =>
      resolveNotionTarget(query, {
        notionApiKey: requireEnv('NOTION_API_KEY'),
      }),
    now: () => new Date().toISOString(),
    ttlMs: 24 * 60 * 60 * 1000,
  };

  // Synchronous classify (skip storeMessage) + fire-and-forget execution.
  function handleApproval(chatJid: string, msg: NewMessage): boolean {
    if (!parseApprovalIntent(msg.content)) return false;
    Promise.resolve(handleApprovalReply(chatJid, msg, orgActionDeps)).catch(
      (err) =>
        logger.error({ err, chatJid }, 'org-action approval handler error'),
    );
    return true;
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      handleInboundMessage(chatJid, msg, {
        registeredGroups: () => registeredGroups,
        storeMessage,
        handleAbort,
        handleRemoteControl,
        handleApproval,
        loadSenderAllowlist,
      });
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    await connectChannel(channel, channelName, channels);
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    sessionForNextRun,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      // topLevel: cron output has no message to reply to (see SendOptions.target).
      if (text)
        await channel.sendMessage(jid, text, {
          target: { kind: 'topLevel' },
        });
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, options);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    onOrgAction: async (record, sourceGroup, chatJid) => {
      // ipc.ts hard-rejects every malformed field (reversibility/stakes_hint
      // outside their enums, non-object canonical_args, non-string[]
      // citation_refs) before this handler is called, so the record arrives
      // fully typed. No coercion: a coerced value would pass the gate, consume
      // the approval, then drop or mis-tier the write silently (the footgun
      // ipc.ts names). requesterIds is host-attributed, never taken from the
      // record; see run-requesters.ts.
      await driveOrgActionRequest(
        {
          action: record.action,
          target_ref: record.target_ref,
          target_query: record.target_query,
          reversibility: record.reversibility,
          stakes_hint: record.stakes_hint,
          citation_refs: record.citation_refs,
          canonical_args: record.canonical_args,
        },
        {
          sourceGroup,
          chatJid,
          requesterIds: getRunRequesters(sourceGroup),
        },
        orgActionDeps,
      );
    },
  });

  // Boot re-drive of approved-but-unconsumed org-actions, then a periodic TTL
  // sweep marking expired pending rows. Exactly-once is preserved by the atomic
  // consume inside reDriveApprovedActions. A failure here is fail-fast: it
  // propagates to the top-level startup crash handler so the abandoned rows are
  // retried on restart rather than silently skipped.
  await reDriveApprovedActions(orgActionDeps);
  expirePendingActions(new Date().toISOString());
  setInterval(
    () => {
      const expired = expirePendingActions(new Date().toISOString());
      if (expired > 0) {
        logger.info({ expired }, 'org-action TTL sweep marked rows expired');
      }
    },
    5 * 60 * 1000,
  ).unref();

  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

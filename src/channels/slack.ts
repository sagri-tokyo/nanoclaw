import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { hashPayload, logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API accepts up to 4000 chars, but the rendered UI
// inserts an avatar/timestamp row around ~3500 chars and can split a chunk
// mid-mrkdwn span (e.g. inside `*bold*`). 3500 leaves margin and forces
// breaks on natural boundaries before the UI does it for us.
const MAX_MESSAGE_LENGTH = 3500;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

// Split `text` into chunks no longer than `max`, preferring natural boundaries
// in this order: paragraph break, line break, space, then a hard cut.
// Boundaries earlier than half the limit are rejected so we don't emit a
// tiny chunk followed by a near-full one.
export function splitForSlack(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const minBoundary = Math.floor(max / 2);
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    const window = remaining.slice(0, max);
    let breakAt = window.lastIndexOf('\n\n');
    let separatorLength = 2;
    if (breakAt < minBoundary) {
      breakAt = window.lastIndexOf('\n');
      separatorLength = 1;
    }
    if (breakAt < minBoundary) {
      breakAt = window.lastIndexOf(' ');
      separatorLength = 1;
    }
    if (breakAt < minBoundary) {
      breakAt = max;
      separatorLength = 0;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt + separatorLength);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    threadTs?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastThreadTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;

      // Track thread context so outbound replies go to the correct thread.
      // NanoClaw processes one message at a time per group (sequential queue),
      // so storing the most recent thread_ts per channel is sufficient.
      const threadTs = (msg as GenericMessageEvent).thread_ts;
      if (threadTs) {
        this.lastThreadTs.set(jid, threadTs);
      } else {
        this.lastThreadTs.set(jid, msg.ts);
      }
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot
      // is @mentioned. After prepending, strip the raw `<@UBOTID>` (with any
      // surrounding whitespace) so the rewritten content keeps the canonical
      // `^@<NAME>\s+<rest>` shape the kill-switch parser requires
      // (sagri-tokyo/sagri-ai#128).
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          const stripPattern = new RegExp(`\\s*<@${this.botUserId}>\\s*`, 'g');
          const stripped = content.replace(stripPattern, ' ').trim();
          content =
            stripped.length > 0
              ? `@${ASSISTANT_NAME} ${stripped}`
              : `@${ASSISTANT_NAME}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        is_dm: !isGroup,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.lastThreadTs.get(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    const startTime = Date.now();
    const inputsHash = hashPayload(text);
    try {
      await this.postChunks(channelId, text, threadTs);
      logger.action({
        ts: new Date().toISOString(),
        level: 'info',
        session_id: jid,
        trigger: 'slack',
        trigger_source: jid,
        tool: 'message_send',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(text),
        duration_ms: Date.now() - startTime,
        outcome: 'ok',
        error_class: null,
        group: jid,
      });
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
      logger.action({
        ts: new Date().toISOString(),
        level: 'error',
        session_id: jid,
        trigger: 'slack',
        trigger_source: jid,
        tool: 'message_send',
        inputs_hash: inputsHash,
        outputs_hash: hashPayload(''),
        duration_ms: Date.now() - startTime,
        outcome: 'error',
        error_class: err instanceof Error ? err.constructor.name : 'Error',
        group: jid,
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.postChunks(channelId, item.text, item.threadTs);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  private async postChunks(
    channelId: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    for (const chunk of splitForSlack(text, MAX_MESSAGE_LENGTH)) {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: threadTs,
      });
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});

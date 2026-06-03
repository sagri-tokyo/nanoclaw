import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  SLACK_FILE_INGESTION,
  SLACK_FILE_MAX_BYTES,
  SLACK_FILE_MAX_COUNT,
} from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import {
  fetchWithRedirects,
  resolveDeps,
  FetchUntrustedHttp4xx,
  type FetchUntrustedDeps,
} from '../fetch-untrusted.js';
import { hashFailureOutput, hashPayload, logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  FileRef,
  MessageFileBundle,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendOptions,
} from '../types.js';

// Typed file-fetch failure carrying a skip reason the prompt assembler renders
// into a <file_skipped> marker. Keeps the user's request running on a per-file
// download/resolve failure.
export class FileFetchError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

// Only send the bot token to Slack-owned hosts. Cross-origin redirects also
// strip the Authorization header in fetch-untrusted, so this is defense in depth.
function isSlackFileHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'slack.com' || host.endsWith('.slack.com');
  } catch {
    return false;
  }
}

// Map raw Slack file objects to metadata-only FileRefs, capped at maxCount.
// Refs may be incomplete (Slack Connect `file_access: "check_file_info"` omits
// url/mime); fetchFileContent resolves the rest via files.info at download time.
export function extractFileBundle(
  rawFiles: unknown,
  maxCount: number,
): MessageFileBundle | undefined {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) return undefined;
  const refs: FileRef[] = [];
  let omitted = 0;
  for (const f of rawFiles) {
    if (!f || typeof f !== 'object') continue;
    const fo = f as Record<string, unknown>;
    if (typeof fo.id !== 'string' || fo.id.length === 0) continue;
    if (refs.length >= maxCount) {
      omitted++;
      continue;
    }
    const ref: FileRef = { id: fo.id };
    if (typeof fo.name === 'string') ref.name = fo.name;
    if (typeof fo.mimetype === 'string') ref.mimetype = fo.mimetype;
    if (typeof fo.size === 'number') ref.size = fo.size;
    if (typeof fo.url_private_download === 'string') {
      ref.url_private_download = fo.url_private_download;
    } else if (typeof fo.url_private === 'string') {
      ref.url_private_download = fo.url_private;
    }
    if (typeof fo.file_access === 'string') ref.file_access = fo.file_access;
    refs.push(ref);
  }
  if (refs.length === 0) return undefined;
  return omitted > 0 ? { refs, omitted_count: omitted } : { refs };
}

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
  // Test seam: inject SSRF lookup / https factory for file downloads.
  fetchDeps?: FetchUntrustedDeps;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  // Kept in host memory only (never process.env) so file downloads can send it
  // as an Authorization header — never placed in prompts, DB rows, or errors.
  private botToken: string;
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
    this.botToken = botToken;

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
      // file_share carries attachments (a file uploaded with a comment). Accept
      // it ONLY when ingestion is enabled — otherwise flag-off behaviour must
      // stay byte-identical to before (file_share dropped entirely, even with a
      // text comment). bot_message is always kept so we track our own output.
      if (
        subtype &&
        subtype !== 'bot_message' &&
        !(SLACK_FILE_INGESTION && subtype === 'file_share')
      )
        return;

      // After filtering, event is GenericMessageEvent | BotMessageEvent (or a
      // file_share, shaped like GenericMessageEvent with a `files` array).
      const msg = event as HandledMessageEvent;

      // Capture attachments only when ingestion is enabled. A files-only message
      // (no text) is still delivered so it can be context/processed; with the
      // flag off, the original text-required behaviour is preserved exactly.
      const rawFiles = (msg as { files?: unknown[] }).files;
      const hasFiles =
        SLACK_FILE_INGESTION && Array.isArray(rawFiles) && rawFiles.length > 0;

      if (!msg.text && !hasFiles) return;

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

      const userId = msg.user;
      const botId = msg.bot_id;
      const isSlackBotMessage = !!botId;
      const isOwnBotMessage = !!this.botUserId && userId === this.botUserId;

      let senderName: string;
      if (isOwnBotMessage) {
        senderName = ASSISTANT_NAME;
      } else if (userId) {
        senderName = (await this.resolveUserName(userId)) || userId;
      } else {
        senderName = botId || 'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot
      // is @mentioned. After prepending, strip the raw `<@UBOTID>` (with any
      // surrounding whitespace) so the rewritten content keeps the canonical
      // `^@<NAME>\s+<rest>` shape the kill-switch parser requires
      // (sagri-tokyo/sagri-ai#128).
      let content = msg.text || '';
      if (this.botUserId && !isOwnBotMessage && !isSlackBotMessage) {
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

      // Attachments only from human messages (never our own / other bots).
      const fileBundle =
        hasFiles && !isOwnBotMessage && !isSlackBotMessage
          ? extractFileBundle(rawFiles, SLACK_FILE_MAX_COUNT)
          : undefined;

      // Files-only message: give it neutral, non-trigger content so it survives
      // the content-not-empty DB filter and flows through the normal trigger
      // path (an explicit @mention is still required to act on attachments).
      if (content.length === 0 && fileBundle) {
        const n = fileBundle.refs.length;
        content = `[shared ${n} file${n === 1 ? '' : 's'}]`;
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: userId || botId || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isOwnBotMessage,
        is_bot_message: isOwnBotMessage,
        is_dm: !isGroup,
        thread_id: threadTs,
        files: fileBundle,
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

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = opts?.threadId ?? this.lastThreadTs.get(jid);

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
      const posted = await this.postChunks(channelId, text, threadTs);
      logger.action({
        ts: new Date().toISOString(),
        level: 'info',
        session_id: jid,
        trigger: 'slack',
        trigger_source: jid,
        tool: 'message_send',
        inputs_hash: inputsHash,
        // The "output" of a message_send is the resulting Slack message
        // identifier list (ts + channel per chunk) — NOT the input text,
        // which would make inputs_hash and outputs_hash collide. This lets
        // an operator pivot from a log row to the actual posted message via
        // its ts.
        outputs_hash: hashPayload(posted),
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
      const errorClass = err instanceof Error ? err.constructor.name : 'Error';
      logger.action({
        ts: new Date().toISOString(),
        level: 'error',
        session_id: jid,
        trigger: 'slack',
        trigger_source: jid,
        tool: 'message_send',
        inputs_hash: inputsHash,
        outputs_hash: hashFailureOutput({
          error_class: errorClass,
          error_message_preview:
            err instanceof Error ? err.message.slice(0, 200) : '',
        }),
        duration_ms: Date.now() - startTime,
        outcome: 'error',
        error_class: errorClass,
        group: jid,
      });
    }
  }

  /**
   * Fetch a thread's full message history via conversations.replies (oldest
   * first, includes the parent). Requires the bot to be a member of the
   * channel and the appropriate history scope; throws on API error so callers
   * can fail closed.
   */
  async fetchThread(
    jid: string,
    threadId: string,
    limit: number,
  ): Promise<NewMessage[]> {
    const channelId = jid.replace(/^slack:/, '');
    const result = await this.app.client.conversations.replies({
      channel: channelId,
      ts: threadId,
      limit,
    });
    const replyMessages = result.messages || [];
    const uniqueUserIds = new Set<string>();
    for (const m of replyMessages) {
      const userId = (m as { user?: string }).user;
      const isOwnBot = !!this.botUserId && userId === this.botUserId;
      if (userId && !isOwnBot) uniqueUserIds.add(userId);
    }

    const resolvedNames = new Map<string, string | undefined>();
    await Promise.all(
      [...uniqueUserIds].map(async (userId) => {
        resolvedNames.set(userId, await this.resolveUserName(userId));
      }),
    );

    const out: NewMessage[] = [];
    for (const m of replyMessages) {
      const ts = typeof m.ts === 'string' ? m.ts : '';
      if (!ts) continue;
      const text = typeof m.text === 'string' ? m.text : '';
      const userId = (m as { user?: string }).user;
      const botId = (m as { bot_id?: string }).bot_id;
      const isOwnBot = !!this.botUserId && userId === this.botUserId;
      const fileBundle =
        SLACK_FILE_INGESTION && !isOwnBot
          ? extractFileBundle(
              (m as { files?: unknown[] }).files,
              SLACK_FILE_MAX_COUNT,
            )
          : undefined;
      // A files-only reply (no text) is a real follow-up — keep it with the
      // same neutral synthetic content as inbound capture so the should-reply
      // judge sees the latest reply. Skip only genuinely empty messages
      // (e.g. join notices) so they don't pollute thread context.
      let content = text;
      if (content.length === 0) {
        if (!fileBundle) continue;
        const n = fileBundle.refs.length;
        content = `[shared ${n} file${n === 1 ? '' : 's'}]`;
      }
      const senderName = isOwnBot
        ? ASSISTANT_NAME
        : userId
          ? resolvedNames.get(userId) || userId
          : botId || 'unknown';
      out.push({
        id: ts,
        chat_jid: jid,
        sender: userId || botId || '',
        sender_name: senderName,
        content,
        timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
        is_from_me: isOwnBot,
        is_bot_message: isOwnBot,
        thread_id: threadId,
        files: fileBundle,
      });
    }
    return out;
  }

  /**
   * Download one attached file's bytes. Resolves incomplete refs (Slack Connect
   * `file_access: "check_file_info"`, or a ref missing url/mime) via files.info,
   * then GETs `url_private_download` with the bot token through the shared
   * SSRF-guarded fetcher (HTTPS-only, public-address, redirect-revalidated,
   * byte-capped). Only Slack hosts receive the token. Throws FileFetchError with
   * a skip reason on any failure so the caller can render <file_skipped> and
   * keep the user's request running. Raw bytes are returned for the host
   * sanitizer; they never reach the actor unsanitized.
   */
  async fetchFileContent(
    file: FileRef,
  ): Promise<{ bytes: Buffer; file: FileRef; mimetype: string }> {
    let resolved = file;
    if (
      !resolved.url_private_download ||
      !resolved.mimetype ||
      resolved.file_access === 'check_file_info'
    ) {
      let info: { file?: unknown };
      try {
        info = await this.app.client.files.info({ file: file.id });
      } catch {
        throw new FileFetchError(
          'files_info_failed',
          'could not resolve file metadata',
        );
      }
      const sf =
        info.file && typeof info.file === 'object'
          ? (info.file as Record<string, unknown>)
          : undefined;
      if (sf) {
        const download =
          typeof sf.url_private_download === 'string'
            ? sf.url_private_download
            : typeof sf.url_private === 'string'
              ? sf.url_private
              : resolved.url_private_download;
        resolved = {
          id: file.id,
          name: typeof sf.name === 'string' ? sf.name : resolved.name,
          mimetype:
            typeof sf.mimetype === 'string' ? sf.mimetype : resolved.mimetype,
          size: typeof sf.size === 'number' ? sf.size : resolved.size,
          url_private_download: download,
          file_access:
            typeof sf.file_access === 'string'
              ? sf.file_access
              : resolved.file_access,
        };
      }
    }

    const url = resolved.url_private_download;
    if (!url) {
      throw new FileFetchError('no_download_url', 'file has no download url');
    }
    if (!isSlackFileHost(url)) {
      throw new FileFetchError(
        'untrusted_host',
        'file url is not on a slack host',
      );
    }

    const deps = resolveDeps(this.opts.fetchDeps);
    try {
      const resp = await fetchWithRedirects({
        url,
        headers: {
          authorization: `Bearer ${this.botToken}`,
          'user-agent': 'nanoclaw-slack-file-ingestion/1.0',
        },
        deps,
        maxBytes: SLACK_FILE_MAX_BYTES,
      });
      return {
        bytes: resp.bodyBytes,
        file: resolved,
        mimetype: resolved.mimetype || '',
      };
    } catch (err) {
      // 401/403 almost always means the app lacks files:read (or access to the
      // file). Surface a specific operator-actionable reason; never leak the
      // token or the private URL in the error.
      if (
        err instanceof FetchUntrustedHttp4xx &&
        (err.httpStatus === 401 || err.httpStatus === 403)
      ) {
        throw new FileFetchError(
          'slack_files_read_denied',
          'slack files:read scope missing or no access to file',
        );
      }
      throw new FileFetchError('download_failed', 'file download failed');
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
  ): Promise<Array<{ ts: string; channel: string }>> {
    const posted: Array<{ ts: string; channel: string }> = [];
    for (const chunk of splitForSlack(text, MAX_MESSAGE_LENGTH)) {
      const response = await this.app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: threadTs,
      });
      // Slack's chat.postMessage returns ts (message timestamp, the canonical
      // message identifier) and channel on success. The output of a
      // message_send is the resulting message identifier, not the input
      // text — record that for forensic correlation.
      posted.push({
        ts: typeof response.ts === 'string' ? response.ts : '',
        channel:
          typeof response.channel === 'string' ? response.channel : channelId,
      });
    }
    return posted;
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

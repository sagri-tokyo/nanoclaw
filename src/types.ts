export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (elevated mount/visibility privileges; does not affect trigger gating)
}

// Reference to a Slack file attachment. Metadata only — never bytes. A ref may
// start incomplete (e.g. just `{ id }` for Slack Connect `file_access:
// "check_file_info"`); the Slack adapter resolves the rest via files.info at
// download time. Persisted as JSON in `messages.files` (sagri-tokyo/sagri-ai#264).
export interface FileRef {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  file_access?: string;
}

// The set of file refs attached to one message, plus a count of refs dropped at
// capture time when an event exceeded the per-message cap.
export interface MessageFileBundle {
  refs: FileRef[];
  omitted_count?: number;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  // Slack `bot_id` of the sender, when the message came from any bot/webhook
  // (not just our own user). Carried so the approval classifier can never treat
  // a third-party bot message as a human approver (D2.4). `is_bot_message` is
  // set true whenever this is present.
  bot_id?: string;
  files?: MessageFileBundle;
  // True when the source is a 1:1 DM (Slack `channel_type === 'im'`,
  // WhatsApp/Telegram personal chats). Channels populate this so the
  // host-side abort-trigger parser can branch on bare-verb acceptance.
  is_dm?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

// A held org-action awaiting approval (D2.4). Host-minted, host-owned. The
// token is never serialized into any agent-readable IPC/tasks file — only into
// messages.db and the host-posted Slack prompt.
export type PendingActionState =
  | 'pending'
  | 'approved'
  | 'consumed'
  | 'denied'
  | 'expired';

export interface PendingActionRow {
  token: string;
  source_group: string;
  chat_jid: string;
  action: string;
  target_ref: string;
  reversibility: 'reversible' | 'draft';
  stakes_hint: 'safe' | 'gated';
  citation_refs: string;
  canonical_args: string;
  summary: string;
  requester: string;
  state: PendingActionState;
  created_at: string;
  expires_at: string;
  approved_by: string | null;
  consumed_at: string | null;
}

// Per-task capability profile (sagri-ai#312). Fail-closed: an absent value
// resolves to `operator`, which denies the container the Notion/GitHub write
// tokens and forces writes through the host-executed `org_action` gate. Only
// the poller ScheduledTasks opt in to `trusted-writer`.
export type CapabilityProfile = 'operator' | 'trusted-writer';

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  runbook_url?: string | null;
  failure_post_threshold?: number;
  capability_profile?: CapabilityProfile;
  reply_mode?: ReplyMode;
}

// How a scheduled task's outcome reaches chat. `text` (the default) posts the
// agent's final message verbatim — the legacy path, where prose the model
// writes IS the Slack post. `structured` suppresses that post entirely and
// posts only host-rendered lines built from `report_outcome` records.
export type ReplyMode = 'text' | 'structured';

export interface TaskOutcomeRow {
  task_id: string;
  entity_id: string;
  status: string;
  error_class: string | null;
  detail: Record<string, string> | null;
  group_folder: string;
  recorded_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

// Options for an outbound send. `target` picks the reply anchor: a specific
// thread id (more reliable than a channel's "most recent thread" heuristic
// when multiple threads in one channel are active or queued), or an explicit
// top-level post that bypasses the lastThreadTs fallback — used by senders
// that reply to no message (scheduled-task cron output) so they don't staple
// onto whichever human last spoke in the channel (sagri-ai#371). Absent
// `target` falls back to the channel's lastThreadTs.
export interface SendOptions {
  target?: { kind: 'thread'; id: string } | { kind: 'topLevel' };
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, opts?: SendOptions): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: processing indicator bracketing an interactive run; `messageTs`
  // anchors it to the triggering message (Slack reacts to it), ignored by
  // channels that don't need an anchor.
  setTyping?(jid: string, isTyping: boolean, messageTs?: string): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: fetch a thread's full message history (e.g. Slack
  // conversations.replies). Channels without threads leave this undefined.
  fetchThread?(
    jid: string,
    threadId: string,
    limit: number,
  ): Promise<NewMessage[]>;
  // Optional: download one attached file's bytes (resolving incomplete refs via
  // the platform API as needed). Returns raw bytes plus the resolved ref/mime;
  // the host sanitizes before anything reaches the actor. Slack-only for now.
  fetchFileContent?(
    file: FileRef,
  ): Promise<{ bytes: Buffer; file: FileRef; mimetype: string }>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

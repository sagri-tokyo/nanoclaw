import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  FileRef,
  MessageFileBundle,
  NewMessage,
  PendingActionRow,
  RegisteredGroup,
  ScheduledTask,
  TaskOutcomeRow,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      thread_id TEXT,
      files TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      runbook_url TEXT,
      failure_post_threshold INTEGER NOT NULL DEFAULT 2,
      capability_profile TEXT NOT NULL DEFAULT 'operator',
      reply_mode TEXT NOT NULL DEFAULT 'text'
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      token TEXT PRIMARY KEY,
      source_group TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      action TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      reversibility TEXT NOT NULL,
      stakes_hint TEXT NOT NULL,
      citation_refs TEXT NOT NULL,
      canonical_args TEXT NOT NULL,
      summary TEXT NOT NULL,
      requester TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_by TEXT,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actions_state
      ON pending_actions(state, expires_at);

    CREATE TABLE IF NOT EXISTS task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_class TEXT,
      detail TEXT,
      group_folder TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_outcomes_key
      ON task_outcomes(task_id, entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_outcomes_recent
      ON task_outcomes(task_id, recorded_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(
        `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ? ESCAPE '\\'`,
      )
      .run(`${escapeLikePattern(ASSISTANT_NAME)}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Add thread_id column for thread-aware triggering/context (migration).
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(chat_jid, thread_id)`,
  );

  // Add files column (JSON MessageFileBundle, metadata only) for Slack file
  // ingestion (migration). No index — never queried by files.
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN files TEXT`);
  } catch {
    /* column already exists */
  }

  // Add runbook_url column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN runbook_url TEXT`);
  } catch {
    /* column already exists */
  }

  // Add failure_post_threshold column if it doesn't exist (migration for
  // existing DBs). New rows default to 2 via the column DEFAULT; existing
  // rows get 2 from the ALTER. See sagri-tokyo/sagri-ai#254.
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN failure_post_threshold INTEGER NOT NULL DEFAULT 2`,
    );
  } catch {
    /* column already exists */
  }

  // Add capability_profile column if it doesn't exist (migration for existing
  // DBs). Fail-closed: existing rows and new rows default to 'operator', which
  // denies the container the org-write tokens. Poller tasks are re-registered
  // as 'trusted-writer' out of band. See sagri-tokyo/sagri-ai#312.
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN capability_profile TEXT NOT NULL DEFAULT 'operator'`,
    );
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.includes('duplicate column name')
      )
    ) {
      throw error;
    }
  }

  // Add reply_mode column if it doesn't exist (migration for existing DBs).
  // Existing and new rows default to 'text', which keeps the legacy
  // post-the-final-message behaviour until a task is explicitly flipped to
  // 'structured' via `register-task --reply-mode`.
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'text'`,
    );
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.includes('duplicate column name')
      )
    ) {
      throw error;
    }
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
    msg.thread_id ?? null,
    msg.files ? JSON.stringify(msg.files) : null,
  );
}

/**
 * Parse the JSON `files` column into a typed MessageFileBundle. Tolerant:
 * returns undefined for null/empty/malformed/non-array, and drops malformed
 * refs (a ref must at least have a string id). Called at the read boundary so
 * `NewMessage.files` is correctly typed for consumers.
 */
export function parseFilesColumn(raw: unknown): MessageFileBundle | undefined {
  let value: unknown = raw;
  if (value == null) return undefined;
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.refs)) return undefined;
  const refs: FileRef[] = [];
  for (const r of rec.refs) {
    if (!r || typeof r !== 'object') continue;
    const ref = r as Record<string, unknown>;
    if (typeof ref.id !== 'string' || ref.id.length === 0) continue;
    const out: FileRef = { id: ref.id };
    if (typeof ref.name === 'string') out.name = ref.name;
    if (typeof ref.mimetype === 'string') out.mimetype = ref.mimetype;
    if (typeof ref.size === 'number') out.size = ref.size;
    if (typeof ref.url_private_download === 'string')
      out.url_private_download = ref.url_private_download;
    if (typeof ref.file_access === 'string') out.file_access = ref.file_access;
    refs.push(out);
  }
  const bundle: MessageFileBundle = { refs };
  if (typeof rec.omitted_count === 'number') {
    bundle.omitted_count = rec.omitted_count;
  }
  return bundle;
}

// Replace each row's raw JSON `files` column with a parsed bundle (or undefined)
// so callers receive a correctly-typed NewMessage. The SELECTs cast rows to
// NewMessage[], where `files` is otherwise the raw DB string at runtime.
function hydrateFiles(rows: NewMessage[]): NewMessage[] {
  for (const row of rows) {
    row.files = parseFilesColumn(
      (row as unknown as Record<string, unknown>).files,
    );
  }
  return rows;
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

// Escape LIKE metacharacters (\ % _) in a literal prefix so it can't act as a
// wildcard, paired with `ESCAPE '\'` in the query. Hardening for bot-prefix
// matching (greptile #61 P2): the prefix is a trusted config value today, but a
// name containing % or _ would otherwise match unintended rows.
function escapeLikePattern(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             thread_id, files
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ? ESCAPE '\\'
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(
      lastTimestamp,
      ...jids,
      `${escapeLikePattern(botPrefix)}:%`,
      limit,
    ) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: hydrateFiles(rows), newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             thread_id, files
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ? ESCAPE '\\'
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(
      chatJid,
      sinceTimestamp,
      `${escapeLikePattern(botPrefix)}:%`,
      limit,
    ) as NewMessage[];
  return hydrateFiles(rows);
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ? ESCAPE '\\')`,
    )
    .get(chatJid, `${escapeLikePattern(botPrefix)}:%`) as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? undefined;
}

/**
 * Has the bot already posted in this thread? Used to decide whether a
 * no-mention reply in the thread is a candidate for the should-reply judge.
 * This intentionally trusts only the structured own-bot flag. A content prefix
 * is not enough here because user-authored messages can start with the
 * assistant name.
 */
export function botRepliedInThread(
  chatJid: string,
  threadId: string,
  _botPrefix: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND thread_id = ? AND is_bot_message = 1
       LIMIT 1`,
    )
    .get(chatJid, threadId);
  return row !== undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at, runbook_url, failure_post_threshold, capability_profile, reply_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.runbook_url ?? null,
    task.failure_post_threshold ?? 2,
    task.capability_profile ?? 'operator',
    task.reply_mode ?? 'text',
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'runbook_url'
      | 'failure_post_threshold'
      | 'capability_profile'
      | 'reply_mode'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.runbook_url !== undefined) {
    fields.push('runbook_url = ?');
    values.push(updates.runbook_url ?? null);
  }
  if (updates.failure_post_threshold !== undefined) {
    fields.push('failure_post_threshold = ?');
    values.push(updates.failure_post_threshold);
  }
  if (updates.capability_profile !== undefined) {
    fields.push('capability_profile = ?');
    values.push(updates.capability_profile);
  }
  if (updates.reply_mode !== undefined) {
    fields.push('reply_mode = ?');
    values.push(updates.reply_mode);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint). Outcomes go too: their
  // uniqueness key is (task_id, entity_id, status), so a row surviving its task
  // would silently swallow the first post of a task later registered under the
  // same id.
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM task_outcomes WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/**
 * Return the `status` values of the most recent `limit` `task_run_logs` rows
 * for `taskId`, newest-first. Used by the scheduler's consecutive-failure
 * suppression gate (sagri-tokyo/sagri-ai#254).
 */
export function getRecentTaskRunStatuses(
  taskId: string,
  limit: number,
): Array<'success' | 'error'> {
  const rows = db
    .prepare(
      `SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<{ status: 'success' | 'error' }>;
  return rows.map((row) => row.status);
}

/**
 * End of the run before last for `taskId`, or `''` when the task has run fewer
 * than twice. `task_run_logs.run_at` is stamped when a run finishes, so the row
 * at offset 1 is the end of run N-2 while run N is still in flight: everything
 * recorded at or after it belongs to run N-1 or run N.
 */
function previousRunCutoff(taskId: string): string {
  const row = db
    .prepare(
      `SELECT run_at FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC, id DESC LIMIT 1 OFFSET 1`,
    )
    .get(taskId) as { run_at: string } | undefined;
  return row?.run_at ?? '';
}

/**
 * Record one structured task outcome. Returns true when the host should post
 * it, which is whenever the same `(task_id, entity_id, status)` was not already
 * reported on the previous run. A job that stays `submitted` across twenty
 * consecutive ticks therefore still produces exactly one Slack line, because
 * each tick's record lands one run after the last.
 *
 * The window is what keeps dedupe from becoming permanent silence: keyed on
 * existence alone, only the first outage of a task's life would ever post. A
 * repeat that follows a gap (a recovery, a re-submission, a later outage) is
 * news.
 *
 * A repeat refreshes the row rather than inserting beside it, so the table
 * grows with entities handled rather than with ticks, and the refreshed
 * `recorded_at` keeps the record inside the current run's window, which is
 * where the scheduler reads a structured run's status from.
 */
export function recordTaskOutcome(row: TaskOutcomeRow): boolean {
  const existing = db
    .prepare(
      `SELECT id, recorded_at FROM task_outcomes WHERE task_id = ? AND entity_id = ? AND status = ?`,
    )
    .get(row.task_id, row.entity_id, row.status) as
    | { id: number; recorded_at: string }
    | undefined;

  if (existing) {
    const reportedOnPreviousRun =
      existing.recorded_at >= previousRunCutoff(row.task_id);
    db.prepare(
      `UPDATE task_outcomes SET error_class = ?, detail = ?, recorded_at = ? WHERE id = ?`,
    ).run(
      row.error_class,
      row.detail === null ? null : JSON.stringify(row.detail),
      row.recorded_at,
      existing.id,
    );
    return !reportedOnPreviousRun;
  }

  db.prepare(
    `
    INSERT INTO task_outcomes (task_id, entity_id, status, error_class, detail, group_folder, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    row.task_id,
    row.entity_id,
    row.status,
    row.error_class,
    row.detail === null ? null : JSON.stringify(row.detail),
    row.group_folder,
    row.recorded_at,
  );
  return true;
}

/**
 * Statuses recorded for `taskId` at or after `sinceIso`, oldest-first. The
 * scheduler uses this to derive a structured run's `task_run_logs` status,
 * which in that mode cannot be read off the reply text.
 */
export function getTaskOutcomesSince(
  taskId: string,
  sinceIso: string,
): Array<{ status: string; error_class: string | null }> {
  return db
    .prepare(
      `SELECT status, error_class FROM task_outcomes WHERE task_id = ? AND recorded_at >= ? ORDER BY recorded_at, id`,
    )
    .all(taskId, sinceIso) as Array<{
    status: string;
    error_class: string | null;
  }>;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Pending org-action accessors (D2.4 approval gate) ---

export function createPendingAction(rowInput: PendingActionRow): void {
  db.prepare(
    `INSERT INTO pending_actions
      (token, source_group, chat_jid, action, target_ref, reversibility,
       stakes_hint, citation_refs, canonical_args, summary, requester, state,
       created_at, expires_at, approved_by, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowInput.token,
    rowInput.source_group,
    rowInput.chat_jid,
    rowInput.action,
    rowInput.target_ref,
    rowInput.reversibility,
    rowInput.stakes_hint,
    rowInput.citation_refs,
    rowInput.canonical_args,
    rowInput.summary,
    rowInput.requester,
    rowInput.state,
    rowInput.created_at,
    rowInput.expires_at,
    rowInput.approved_by,
    rowInput.consumed_at,
  );
}

export function getPendingAction(token: string): PendingActionRow | undefined {
  return db
    .prepare('SELECT * FROM pending_actions WHERE token = ?')
    .get(token) as PendingActionRow | undefined;
}

/**
 * Transition a row from `pending` to `approved`, recording the approver. Returns
 * true only when exactly one `pending` row changed. The `expires_at >= now`
 * guard rejects a row whose TTL elapsed before the sweep flipped it to
 * `expired`, closing the window where a late approval could still execute. The
 * boundary matches the sweep (`expires_at < now` expires).
 */
export function approvePendingAction(
  token: string,
  approverId: string,
  now: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_actions SET state = 'approved', approved_by = ?
       WHERE token = ? AND state = 'pending' AND expires_at >= ?`,
    )
    .run(approverId, token, now);
  return result.changes === 1;
}

/**
 * Atomic single-use consume. Returns true only on the one statement that flips
 * an `approved` row to `consumed`; every later call returns false. This is the
 * exactly-once execution gate (ADR-0002 decision 4).
 */
export function consumePendingAction(
  token: string,
  consumedAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_actions SET state = 'consumed', consumed_at = ?
       WHERE token = ? AND state = 'approved'`,
    )
    .run(consumedAt, token);
  return result.changes === 1;
}

/**
 * Reverse a consume after the host write failed: flip `consumed` back to
 * `approved` and clear `consumed_at` so boot re-drive retries it. Without this a
 * thrown `executeAction` strands the row in `consumed`, where
 * `getApprovedUnconsumed` never sees it again — approved but never executed.
 * Returns true only on the statement that re-arms a `consumed` row.
 */
export function reArmConsumedAction(token: string): boolean {
  const result = db
    .prepare(
      `UPDATE pending_actions SET state = 'approved', consumed_at = NULL
       WHERE token = ? AND state = 'consumed'`,
    )
    .run(token);
  return result.changes === 1;
}

export function denyPendingAction(token: string): boolean {
  const result = db
    .prepare(
      `UPDATE pending_actions SET state = 'denied'
       WHERE token = ? AND state = 'pending'`,
    )
    .run(token);
  return result.changes === 1;
}

/**
 * Mark every still-`pending` row whose TTL has passed as `expired`. Approved
 * rows are never swept (an approval awaiting execution must survive). Returns
 * the number of rows expired.
 */
export function expirePendingActions(now: string): number {
  const result = db
    .prepare(
      `UPDATE pending_actions SET state = 'expired'
       WHERE state = 'pending' AND expires_at < ?`,
    )
    .run(now);
  return result.changes;
}

/** Rows approved but not yet consumed — re-driven on boot for exactly-once. */
export function getApprovedUnconsumed(): PendingActionRow[] {
  return db
    .prepare(
      `SELECT * FROM pending_actions WHERE state = 'approved'
       ORDER BY created_at`,
    )
    .all() as PendingActionRow[];
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('adds failure_post_threshold with default 2 to existing scheduled_tasks rows', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-db-thr-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      // Legacy schema: scheduled_tasks WITHOUT failure_post_threshold.
      legacyDb.exec(`
        CREATE TABLE scheduled_tasks (
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
          created_at TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO scheduled_tasks
           (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-task',
          'slack_main',
          'C123@slack',
          'legacy work',
          'cron',
          '*/15 * * * *',
          '2026-05-15T00:00:00.000Z',
          'active',
          '2026-05-15T00:00:00.000Z',
        );
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getTaskById, createTask, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const migrated = getTaskById('legacy-task');
      expect(migrated).toBeDefined();
      expect(migrated!.failure_post_threshold).toBe(2);

      // New rows created post-migration also default to 2.
      createTask({
        id: 'post-migration-task',
        group_folder: 'slack_main',
        chat_jid: 'C123@slack',
        prompt: 'new work',
        script: null,
        schedule_type: 'cron',
        schedule_value: '*/15 * * * *',
        context_mode: 'isolated',
        next_run: '2026-05-15T01:00:00.000Z',
        status: 'active',
        created_at: '2026-05-15T01:00:00.000Z',
      });
      const fresh = getTaskById('post-migration-task');
      expect(fresh!.failure_post_threshold).toBe(2);

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});

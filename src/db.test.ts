import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  botRepliedInThread,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  parseFilesColumn,
  getRecentTaskRunStatuses,
  getTaskById,
  logTaskRun,
  setRegisteredGroup,
  setSession,
  _getAllSessions,
  deleteAllSessions,
  storeChatMetadata,
  storeMessage,
  updateTask,
  recordTaskOutcome,
  getTaskOutcomesSince,
} from './db.js';
import { formatMessages } from './router.js';
import type { TaskOutcomeRow } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- thread_id persistence + botRepliedInThread ---

describe('thread_id + botRepliedInThread', () => {
  it('persists thread_id through storeMessage and getMessagesSince', () => {
    storeChatMetadata('slack:C1', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'slack:C1',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      thread_id: 'T1',
    });
    const msgs = getMessagesSince('slack:C1', '', 'sagri-ai', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_id).toBe('T1');
  });

  it('returns false until the bot posts in the thread, then true', () => {
    storeChatMetadata('slack:C1', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'h1',
      chat_jid: 'slack:C1',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'question',
      timestamp: '2024-01-01T00:00:01.000Z',
      thread_id: 'T1',
    });
    expect(botRepliedInThread('slack:C1', 'T1', 'sagri-ai')).toBe(false);

    storeMessage({
      id: 'b1',
      chat_jid: 'slack:C1',
      sender: 'BOT',
      sender_name: 'sagri-ai',
      content: 'answer',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_bot_message: true,
      thread_id: 'T1',
    });
    expect(botRepliedInThread('slack:C1', 'T1', 'sagri-ai')).toBe(true);
    // A different thread the bot hasn't touched stays false.
    expect(botRepliedInThread('slack:C1', 'T2', 'sagri-ai')).toBe(false);
  });

  it('does not treat user-authored assistant prefixes as bot replies', () => {
    storeChatMetadata('slack:C2', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'u2',
      chat_jid: 'slack:C2',
      sender: 'U2',
      sender_name: 'Mallory',
      content: 'sagri-ai: hi there',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_bot_message: false,
      thread_id: 'T9',
    });
    expect(botRepliedInThread('slack:C2', 'T9', 'sagri-ai')).toBe(false);
  });
});

// --- files (MessageFileBundle) persistence + parseFilesColumn ---

describe('files bundle persistence', () => {
  const bundle = {
    refs: [
      { id: 'F1', name: 'a.csv', mimetype: 'text/csv', size: 10 },
      { id: 'F2' },
    ],
    omitted_count: 1,
  };

  it('round-trips a files bundle through getMessagesSince', () => {
    storeChatMetadata('slack:C1', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'mf1',
      chat_jid: 'slack:C1',
      sender: 'U1',
      sender_name: 'Alice',
      content: '@bot here are files',
      timestamp: '2024-01-01T00:00:01.000Z',
      files: bundle,
    });
    const msgs = getMessagesSince('slack:C1', '', 'sagri-ai', 10);
    expect(msgs[0].files).toEqual(bundle);
  });

  it('round-trips a files bundle through getNewMessages', () => {
    storeChatMetadata('slack:C1', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'mf2',
      chat_jid: 'slack:C1',
      sender: 'U1',
      sender_name: 'Alice',
      content: '@bot file',
      timestamp: '2024-01-01T00:00:02.000Z',
      files: {
        refs: [{ id: 'F3', name: 'b.json', mimetype: 'application/json' }],
      },
    });
    const { messages } = getNewMessages(['slack:C1'], '', 'sagri-ai', 10);
    expect(messages[0].files?.refs[0]).toMatchObject({ id: 'F3' });
  });

  it('leaves files undefined when none were attached', () => {
    storeChatMetadata('slack:C1', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'mf3',
      chat_jid: 'slack:C1',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'no files',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
    const msgs = getMessagesSince('slack:C1', '', 'sagri-ai', 10);
    expect(msgs[0].files).toBeUndefined();
  });
});

describe('parseFilesColumn', () => {
  it('returns undefined for null/empty/malformed/non-array', () => {
    expect(parseFilesColumn(null)).toBeUndefined();
    expect(parseFilesColumn('')).toBeUndefined();
    expect(parseFilesColumn('{not json')).toBeUndefined();
    expect(parseFilesColumn('[1,2,3]')).toBeUndefined();
    expect(parseFilesColumn(JSON.stringify({ nope: 1 }))).toBeUndefined();
  });

  it('drops refs without a string id and keeps valid ones', () => {
    const raw = JSON.stringify({
      refs: [{ id: 'F1', name: 'ok.csv' }, { name: 'noid' }, { id: 42 }],
      omitted_count: 2,
    });
    const parsed = parseFilesColumn(raw);
    expect(parsed?.refs).toHaveLength(1);
    expect(parsed?.refs[0]).toMatchObject({ id: 'F1', name: 'ok.csv' });
    expect(parsed?.omitted_count).toBe(2);
  });
});

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('scheduled_tasks runbook_url', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
    createTask({
      id: 'task-runbook',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Do work.',
      script: null,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: '2026-05-15T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-15T00:00:00.000Z',
      ...overrides,
    });
  }

  it('persists runbook_url when provided to createTask', () => {
    makeTask({ runbook_url: 'https://www.notion.so/Runbook-x' });
    const stored = getTaskById('task-runbook');
    expect(stored).toBeDefined();
    expect(stored!.runbook_url).toBe('https://www.notion.so/Runbook-x');
  });

  it('persists null runbook_url when not provided', () => {
    makeTask();
    const stored = getTaskById('task-runbook');
    expect(stored).toBeDefined();
    expect(stored!.runbook_url).toBeNull();
  });

  it('updates runbook_url via updateTask', () => {
    makeTask();
    updateTask('task-runbook', { runbook_url: 'https://example.com/runbook' });
    const stored = getTaskById('task-runbook');
    expect(stored!.runbook_url).toBe('https://example.com/runbook');
  });

  it('clears runbook_url when set to null via updateTask', () => {
    makeTask({ runbook_url: 'https://example.com/runbook' });
    updateTask('task-runbook', { runbook_url: null });
    const stored = getTaskById('task-runbook');
    expect(stored!.runbook_url).toBeNull();
  });
});

describe('scheduled_tasks failure_post_threshold', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
    createTask({
      id: 'task-threshold',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Do work.',
      script: null,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: '2026-05-15T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-15T00:00:00.000Z',
      ...overrides,
    });
  }

  it('defaults failure_post_threshold to 2 when omitted at createTask', () => {
    makeTask();
    const stored = getTaskById('task-threshold');
    expect(stored!.failure_post_threshold).toBe(2);
  });

  it('persists an explicit failure_post_threshold at createTask', () => {
    makeTask({ failure_post_threshold: 4 });
    const stored = getTaskById('task-threshold');
    expect(stored!.failure_post_threshold).toBe(4);
  });

  it('updates failure_post_threshold via updateTask', () => {
    makeTask();
    updateTask('task-threshold', { failure_post_threshold: 1 });
    const stored = getTaskById('task-threshold');
    expect(stored!.failure_post_threshold).toBe(1);
  });
});

describe('getRecentTaskRunStatuses', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function seedTask(id: string): void {
    createTask({
      id,
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'p',
      script: null,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: '2026-05-15T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-15T00:00:00.000Z',
    });
  }

  function logRun(
    taskId: string,
    status: 'success' | 'error',
    runAt: string,
  ): void {
    logTaskRun({
      task_id: taskId,
      run_at: runAt,
      duration_ms: 100,
      status,
      result: status === 'success' ? 'ok' : null,
      error: status === 'error' ? 'boom' : null,
    });
  }

  it('returns rows newest-first', () => {
    seedTask('t');
    logRun('t', 'success', '2026-05-15T00:00:00.000Z');
    logRun('t', 'error', '2026-05-15T00:05:00.000Z');
    logRun('t', 'error', '2026-05-15T00:10:00.000Z');
    const statuses = getRecentTaskRunStatuses('t', 5);
    expect(statuses).toEqual(['error', 'error', 'success']);
  });

  it('respects the limit', () => {
    seedTask('t');
    logRun('t', 'success', '2026-05-15T00:00:00.000Z');
    logRun('t', 'error', '2026-05-15T00:05:00.000Z');
    logRun('t', 'error', '2026-05-15T00:10:00.000Z');
    expect(getRecentTaskRunStatuses('t', 2)).toEqual(['error', 'error']);
  });

  it('returns an empty array when the task has no run rows', () => {
    expect(getRecentTaskRunStatuses('no-such-task', 5)).toEqual([]);
  });

  it('returns an empty array when limit is zero', () => {
    seedTask('t');
    logRun('t', 'error', '2026-05-15T00:00:00.000Z');
    expect(getRecentTaskRunStatuses('t', 0)).toEqual([]);
  });

  it('filters by task_id', () => {
    seedTask('t');
    seedTask('other');
    logRun('t', 'error', '2026-05-15T00:00:00.000Z');
    logRun('other', 'success', '2026-05-15T00:05:00.000Z');
    expect(getRecentTaskRunStatuses('t', 5)).toEqual(['error']);
  });
});

describe('task outcome dedupe store', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function outcome(overrides: Partial<TaskOutcomeRow> = {}): TaskOutcomeRow {
    return {
      task_id: 'dsm-experiment-submitter',
      entity_id: 'exp-001',
      status: 'submitted',
      error_class: null,
      detail: null,
      group_folder: 'slack_main',
      recorded_at: '2026-07-24T01:00:00.000Z',
      ...overrides,
    };
  }

  it('reports the first record of a key as newly recorded', () => {
    expect(recordTaskOutcome(outcome())).toBe(true);
  });

  it('reports a repeat of the same (task, entity, status) as already recorded', () => {
    recordTaskOutcome(outcome());
    expect(
      recordTaskOutcome(outcome({ recorded_at: '2026-07-24T02:00:00.000Z' })),
    ).toBe(false);
  });

  // Runs are the unit dedupe collapses over: a job that stays `submitted` for
  // twenty consecutive ticks is one piece of news, but the same status
  // returning after the task ran without reporting it is a new one. Keyed on
  // existence alone, the second outage of a task's life would never post.
  function seedTask(): void {
    createTask({
      id: 'dsm-experiment-submitter',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Poll and report.',
      script: null,
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2026-07-24T01:00:00.000Z',
      status: 'active',
      created_at: '2026-07-24T00:00:00.000Z',
      reply_mode: 'structured',
    });
  }

  function finishRun(runAt: string): void {
    logTaskRun({
      task_id: 'dsm-experiment-submitter',
      run_at: runAt,
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
  }

  it('collapses a repeat reported on the run right after it', () => {
    seedTask();
    recordTaskOutcome(outcome({ recorded_at: '2026-07-24T01:00:00.000Z' }));
    finishRun('2026-07-24T01:01:00.000Z');
    recordTaskOutcome(outcome({ recorded_at: '2026-07-24T02:00:00.000Z' }));
    finishRun('2026-07-24T02:01:00.000Z');
    expect(
      recordTaskOutcome(outcome({ recorded_at: '2026-07-24T03:00:00.000Z' })),
    ).toBe(false);
  });

  it('posts the same status again when it returns after runs that did not report it', () => {
    const outage = (recordedAt: string) =>
      outcome({
        entity_id: 'unknown',
        status: 'failed',
        error_class: 'upstream_query_failed',
        recorded_at: recordedAt,
      });

    seedTask();
    expect(recordTaskOutcome(outage('2026-07-24T01:00:00.000Z'))).toBe(true);
    finishRun('2026-07-24T01:01:00.000Z');
    expect(recordTaskOutcome(outage('2026-07-24T02:00:00.000Z'))).toBe(false);
    finishRun('2026-07-24T02:01:00.000Z');
    // Two runs recover; the upstream is healthy so neither reports the outage.
    finishRun('2026-07-24T03:01:00.000Z');
    finishRun('2026-07-24T04:01:00.000Z');
    expect(recordTaskOutcome(outage('2026-07-24T05:00:00.000Z'))).toBe(true);
  });

  it('refreshes error_class on a collapsed repeat so the run window sees the latest', () => {
    recordTaskOutcome(
      outcome({
        status: 'failed',
        error_class: 'skill_failed_transient',
        recorded_at: '2026-07-24T01:00:00.000Z',
      }),
    );
    recordTaskOutcome(
      outcome({
        status: 'failed',
        error_class: 'skill_failed',
        recorded_at: '2026-07-24T02:00:00.000Z',
      }),
    );
    expect(
      getTaskOutcomesSince(
        'dsm-experiment-submitter',
        '2026-07-24T02:00:00.000Z',
      ),
    ).toEqual([{ status: 'failed', error_class: 'skill_failed' }]);
  });

  it('treats a status change for the same entity as a new record', () => {
    recordTaskOutcome(outcome());
    expect(
      recordTaskOutcome(
        outcome({
          status: 'complete',
          recorded_at: '2026-07-24T02:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('treats the same status for a different entity as a new record', () => {
    recordTaskOutcome(outcome());
    expect(recordTaskOutcome(outcome({ entity_id: 'exp-002' }))).toBe(true);
  });

  it('treats the same status for a different task as a new record', () => {
    recordTaskOutcome(outcome());
    expect(recordTaskOutcome(outcome({ task_id: 'dsm-poller' }))).toBe(true);
  });

  it('returns the statuses recorded for a task at or after a timestamp', () => {
    recordTaskOutcome(outcome({ recorded_at: '2026-07-24T01:00:00.000Z' }));
    recordTaskOutcome(
      outcome({
        entity_id: 'exp-002',
        status: 'failed',
        error_class: 'skill_failed',
        recorded_at: '2026-07-24T03:00:00.000Z',
      }),
    );
    expect(
      getTaskOutcomesSince(
        'dsm-experiment-submitter',
        '2026-07-24T02:00:00.000Z',
      ),
    ).toEqual([{ status: 'failed', error_class: 'skill_failed' }]);
  });

  it('refreshes recorded_at on a deduped repeat so the current run still sees it', () => {
    recordTaskOutcome(outcome({ recorded_at: '2026-07-24T01:00:00.000Z' }));
    recordTaskOutcome(outcome({ recorded_at: '2026-07-24T03:00:00.000Z' }));
    expect(
      getTaskOutcomesSince(
        'dsm-experiment-submitter',
        '2026-07-24T02:00:00.000Z',
      ),
    ).toEqual([{ status: 'submitted', error_class: null }]);
  });

  it('excludes other tasks from the window query', () => {
    recordTaskOutcome(outcome({ task_id: 'dsm-poller' }));
    expect(
      getTaskOutcomesSince(
        'dsm-experiment-submitter',
        '2026-07-24T00:00:00.000Z',
      ),
    ).toEqual([]);
  });

  it("drops a deleted task's outcomes so a re-registered id still posts", () => {
    createTask({
      id: 'dsm-experiment-submitter',
      group_folder: 'slack_main',
      chat_jid: 'C123@slack',
      prompt: 'Poll and report.',
      script: null,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: '2026-07-24T01:00:00.000Z',
      status: 'active',
      created_at: '2026-07-24T00:00:00.000Z',
      reply_mode: 'structured',
    });
    recordTaskOutcome(outcome());
    deleteTask('dsm-experiment-submitter');
    expect(recordTaskOutcome(outcome())).toBe(true);
  });
});

describe('deleteAllSessions (sagri-ai#629)', () => {
  it('forgets every group, so a restart resumes nothing it cannot attribute', () => {
    setSession('dev', 'session-abc');
    setSession('ops', 'session-xyz');
    expect(_getAllSessions()).toStrictEqual({
      dev: 'session-abc',
      ops: 'session-xyz',
    });

    deleteAllSessions();

    expect(_getAllSessions()).toStrictEqual({});
  });
});

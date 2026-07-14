import { describe, it, expect } from 'vitest';

import {
  findExplicitTriggerMessage,
  newestHumanMessage,
  newestHumanThreadAnchor,
} from './index.js';
import { NewMessage, RegisteredGroup } from './types.js';

const GROUP: RegisteredGroup = {
  name: 'Dev',
  folder: 'dev',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

function message(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'ts-0',
    chat_jid: 'C1',
    sender: 'U1',
    sender_name: 'User',
    content: 'hi',
    timestamp: '2024-01-01T00:00:00.000Z',
    is_from_me: true,
    ...overrides,
  };
}

describe('findExplicitTriggerMessage thread anchor', () => {
  it('carries a top-level trigger own ts as the anchor and no thread', () => {
    const trigger = message({
      id: 'ts-trigger',
      content: '@Andy deploy status?',
      thread_id: undefined,
    });

    const result = findExplicitTriggerMessage('C1', [trigger], GROUP);

    expect(result).toStrictEqual({
      threadId: undefined,
      anchorTs: 'ts-trigger',
    });
  });

  it('carries the real thread and own ts for an in-thread trigger', () => {
    const trigger = message({
      id: 'ts-reply',
      content: '@Andy more detail?',
      thread_id: 'ts-thread-root',
    });

    const result = findExplicitTriggerMessage('C1', [trigger], GROUP);

    expect(result).toStrictEqual({
      threadId: 'ts-thread-root',
      anchorTs: 'ts-reply',
    });
  });
});

describe('newestHumanMessage', () => {
  it('returns the newest non-bot message so the reaction anchors to its own ts', () => {
    const found = newestHumanMessage([
      message({ id: 'ts-old' }),
      message({ id: 'ts-new', thread_id: 'ts-root' }),
    ]);

    expect(found?.id).toBe('ts-new');
  });

  it('skips a trailing bot echo so the hourglass never lands on the bot message', () => {
    const found = newestHumanMessage([
      message({ id: 'ts-human' }),
      message({ id: 'ts-bot', is_bot_message: true }),
    ]);

    expect(found?.id).toBe('ts-human');
  });

  it('returns undefined for a bot-only batch', () => {
    expect(
      newestHumanMessage([message({ id: 'ts-bot', is_bot_message: true })]),
    ).toBeUndefined();
  });
});

describe('newestHumanThreadAnchor', () => {
  it('anchors a requiresTrigger:false batch to the newest human own ts', () => {
    const anchor = newestHumanThreadAnchor([
      message({ id: 'ts-old' }),
      message({ id: 'ts-new', thread_id: undefined }),
    ]);

    expect(anchor).toBe('ts-new');
  });

  it('prefers the newest human thread root when present', () => {
    const anchor = newestHumanThreadAnchor([
      message({ id: 'ts-new', thread_id: 'ts-root' }),
    ]);

    expect(anchor).toBe('ts-root');
  });

  it('skips a trailing bot message and anchors to the human before it', () => {
    const anchor = newestHumanThreadAnchor([
      message({ id: 'ts-human' }),
      message({ id: 'ts-bot', is_bot_message: true }),
    ]);

    expect(anchor).toBe('ts-human');
  });

  it('returns undefined when no human message exists', () => {
    const anchor = newestHumanThreadAnchor([
      message({ id: 'ts-bot', is_bot_message: true }),
    ]);

    expect(anchor).toBeUndefined();
  });
});

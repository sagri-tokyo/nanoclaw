import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Sagri-AI',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { handleInboundMessage, type InboundDeps } from './inbound.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

function buildMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'slack:C0123456789',
    sender: 'U_USER_456',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    is_dm: false,
    ...overrides,
  };
}

const REGISTERED_GROUP: RegisteredGroup = {
  name: 'Test Channel',
  folder: 'test-channel',
  trigger: '@Sagri-AI',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('handleInboundMessage — abort intercept', () => {
  let storeMessage: InboundDeps['storeMessage'];
  let handleAbort: InboundDeps['handleAbort'];
  let handleRemoteControl: InboundDeps['handleRemoteControl'];
  let registeredGroups: Record<string, RegisteredGroup>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeMessage = vi.fn() as InboundDeps['storeMessage'];
    handleAbort = vi.fn(async () => undefined) as InboundDeps['handleAbort'];
    handleRemoteControl = vi.fn(
      async () => undefined,
    ) as InboundDeps['handleRemoteControl'];
    registeredGroups = { 'slack:C0123456789': REGISTERED_GROUP };
  });

  it('intercepts @Sagri-AI stop in a registered channel and skips storeMessage', () => {
    const msg = buildMessage({ content: '@Sagri-AI stop', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(storeMessage).not.toHaveBeenCalled();
    expect(handleAbort).toHaveBeenCalledWith('slack:C0123456789', msg);
  });

  it('intercepts bare stop in a DM and skips storeMessage', () => {
    const msg = buildMessage({
      chat_jid: 'slack:D9876543210',
      content: 'stop',
      is_dm: true,
    });

    handleInboundMessage('slack:D9876543210', msg, {
      registeredGroups: () => ({ 'slack:D9876543210': REGISTERED_GROUP }),
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(storeMessage).not.toHaveBeenCalled();
    expect(handleAbort).toHaveBeenCalledTimes(1);
  });

  it('intercepts /stop in any channel type and skips storeMessage', () => {
    const msg = buildMessage({ content: '/stop', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(storeMessage).not.toHaveBeenCalled();
    expect(handleAbort).toHaveBeenCalledTimes(1);
  });

  it('does not intercept bare stop in a registered channel (not DM)', () => {
    const msg = buildMessage({ content: 'stop', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(handleAbort).not.toHaveBeenCalled();
    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('passes ordinary messages through to storeMessage', () => {
    const msg = buildMessage({
      content: '@Sagri-AI run analysis',
      is_dm: false,
    });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(handleAbort).not.toHaveBeenCalled();
    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('runs abort intercept AFTER the sender-allowlist gate when sender is allowed', () => {
    const msg = buildMessage({
      content: '@Sagri-AI stop',
      is_dm: false,
      sender: 'U_USER_456',
    });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: ['U_USER_456'], mode: 'drop' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(handleAbort).toHaveBeenCalledTimes(1);
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('still routes /remote-control to handleRemoteControl ahead of abort intercept', () => {
    const msg = buildMessage({ content: '/remote-control', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(handleRemoteControl).toHaveBeenCalledTimes(1);
    expect(handleAbort).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('still drops messages from non-allowlisted senders in drop mode (non-abort path unchanged)', () => {
    const msg = buildMessage({ content: 'hello there', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: ['someone-else'], mode: 'drop' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(handleAbort).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  describe('abort intent from unauthorised sender', () => {
    const dropConfig = {
      default: {
        allow: ['U_OTHER_USER'] as string[],
        mode: 'drop' as const,
      },
      chats: {},
      logDenied: false,
    };

    it('drops mention-form abort silently (does not call handleAbort or storeMessage)', () => {
      const msg = buildMessage({
        content: '@Sagri-AI stop',
        is_dm: false,
        sender: 'U_UNAUTHORISED',
      });

      handleInboundMessage('slack:C0123456789', msg, {
        registeredGroups: () => registeredGroups,
        storeMessage,
        handleAbort,
        handleRemoteControl,
        loadSenderAllowlist: () => dropConfig,
      });

      expect(handleAbort).not.toHaveBeenCalled();
      expect(storeMessage).not.toHaveBeenCalled();
    });

    it('drops slash-form abort silently in a registered channel', () => {
      const msg = buildMessage({
        content: '/stop',
        is_dm: false,
        sender: 'U_UNAUTHORISED',
      });

      handleInboundMessage('slack:C0123456789', msg, {
        registeredGroups: () => registeredGroups,
        storeMessage,
        handleAbort,
        handleRemoteControl,
        loadSenderAllowlist: () => dropConfig,
      });

      expect(handleAbort).not.toHaveBeenCalled();
      expect(storeMessage).not.toHaveBeenCalled();
    });

    it('drops bare-verb abort silently in a DM', () => {
      const msg = buildMessage({
        chat_jid: 'slack:D9876543210',
        content: 'stop',
        is_dm: true,
        sender: 'U_UNAUTHORISED',
      });

      handleInboundMessage('slack:D9876543210', msg, {
        registeredGroups: () => ({ 'slack:D9876543210': REGISTERED_GROUP }),
        storeMessage,
        handleAbort,
        handleRemoteControl,
        loadSenderAllowlist: () => dropConfig,
      });

      expect(handleAbort).not.toHaveBeenCalled();
      expect(storeMessage).not.toHaveBeenCalled();
    });

    it('drops cancel verb silently when sender is not on allowlist', () => {
      const msg = buildMessage({
        content: '@Sagri-AI cancel',
        is_dm: false,
        sender: 'U_UNAUTHORISED',
      });

      handleInboundMessage('slack:C0123456789', msg, {
        registeredGroups: () => registeredGroups,
        storeMessage,
        handleAbort,
        handleRemoteControl,
        loadSenderAllowlist: () => dropConfig,
      });

      expect(handleAbort).not.toHaveBeenCalled();
      expect(storeMessage).not.toHaveBeenCalled();
    });

    it('drops abort verb silently when sender is not on allowlist', () => {
      const msg = buildMessage({
        content: '/abort',
        is_dm: false,
        sender: 'U_UNAUTHORISED',
      });

      handleInboundMessage('slack:C0123456789', msg, {
        registeredGroups: () => registeredGroups,
        storeMessage,
        handleAbort,
        handleRemoteControl,
        loadSenderAllowlist: () => dropConfig,
      });

      expect(handleAbort).not.toHaveBeenCalled();
      expect(storeMessage).not.toHaveBeenCalled();
    });
  });

  it('logs when an abort intent is intercepted', () => {
    const msg = buildMessage({ content: '/stop', is_dm: false });

    handleInboundMessage('slack:C0123456789', msg, {
      registeredGroups: () => registeredGroups,
      storeMessage,
      handleAbort,
      handleRemoteControl,
      loadSenderAllowlist: () => ({
        default: { allow: '*', mode: 'trigger' },
        chats: {},
        logDenied: false,
      }),
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'slack:C0123456789' }),
      expect.stringContaining('Abort intent intercepted'),
    );
  });
});

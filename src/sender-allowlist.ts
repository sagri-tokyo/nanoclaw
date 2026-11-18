import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

/**
 * Fail-CLOSED fallback (sagri-ai#709): a missing, unreadable, or invalid config
 * file denies every sender and drops their messages before storage. Running
 * open on a broken config would let anyone in a registered channel drive the
 * agent and plant prompt context. Mirrors approver-allowlist.ts.
 */
const DENY_ENTRY: ChatAllowlistEntry = { allow: [], mode: 'drop' };

function denyAllConfig(): SenderAllowlistConfig {
  return { default: { ...DENY_ENTRY, allow: [] }, chats: {}, logDenied: true };
}

// Every message reloads the file, so log each distinct failure once instead of
// once per message. Reset when a valid file loads, so a regression re-alerts.
let lastFailure: string | null = null;

function failClosed(
  reason: string,
  filePath: string,
  err?: unknown,
): SenderAllowlistConfig {
  const key = `${filePath}:${reason}`;
  if (lastFailure !== key) {
    lastFailure = key;
    logger.error(
      err === undefined
        ? { path: filePath, reason }
        : { err, path: filePath, reason },
      'sender-allowlist: config unusable — failing closed (all non-bot messages dropped)',
    );
  }
  return denyAllConfig();
}

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return failClosed(
      code === 'ENOENT' ? 'missing' : 'unreadable',
      filePath,
      code === 'ENOENT' ? undefined : err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failClosed('invalid JSON', filePath);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failClosed('not a JSON object', filePath);
  }
  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    return failClosed('invalid or missing default entry', filePath);
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        // Deny this chat rather than fall through to a (possibly wider)
        // default: a typo in a per-chat restriction must not open the chat.
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: invalid chat entry — denying all senders in this chat',
        );
        chats[jid] = { ...DENY_ENTRY, allow: [] };
      }
    }
  }

  lastFailure = null;
  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

/**
 * Keep only messages that may enter the agent's prompt (sagri-ai#709). A
 * non-allowlisted sender cannot trigger the agent, and must not be able to
 * plant instructions that ride along when an allowed sender triggers it either:
 * in `trigger` mode their messages are still stored, so they would otherwise be
 * concatenated into the next prompt as context. The bot's own messages and
 * other bot rows pass through (they are not human senders the allowlist
 * governs; `getMessagesSince` already excludes bot rows from new batches).
 */
export function filterPromptMessages<
  T extends {
    sender: string;
    is_from_me?: boolean | number;
    is_bot_message?: boolean | number;
  },
>(chatJid: string, msgs: T[], cfg: SenderAllowlistConfig): T[] {
  // Truthy, not `=== true`: rows read back from SQLite carry the flags as 0/1
  // (storeMessage writes `? 1 : 0` and the reads don't convert), so a strict
  // boolean check would drop the bot's own stored messages.
  return msgs.filter(
    (m) =>
      Boolean(m.is_from_me) ||
      Boolean(m.is_bot_message) ||
      isSenderAllowed(chatJid, m.sender, cfg),
  );
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

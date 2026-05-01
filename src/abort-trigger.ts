/**
 * Kill-switch trigger parser.
 *
 * Pure textual classifier: given a message body and an `isDm` flag (true
 * when the source is a 1:1 DM), decide whether the message is an abort
 * request that should be intercepted before reaching the agent.
 *
 * This module knows nothing about the DB, the channel adapter, or the
 * container runtime. The intercept point in `index.ts` turns a positive
 * parse into action.
 *
 * Recognition rules (case-insensitive, whole-message after trim):
 *
 *   1. Slash command:  `/stop` | `/cancel` | `/abort`
 *      Accepted in any channel type, regardless of DM/group.
 *
 *   2. Mention prefix: `@<ASSISTANT_NAME> stop` | `... cancel` | `... abort`
 *      Accepted in any channel type. The Slack channel adapter rewrites
 *      `<@UBOTID>` mentions into this form before delivery.
 *
 *   3. Bare verb:      `stop` | `cancel` | `abort`
 *      Only when `isDm=true`. Same model as message dispatch: in DMs
 *      every message is implicitly directed at the bot, so the mention
 *      prefix is unnecessary.
 *
 * Substring / embedded matches are rejected. "please stop ignoring me"
 * and "aborted yesterday" return null even in a DM.
 */

import { ASSISTANT_NAME } from './config.js';

const ABORT_VERBS: readonly string[] = ['stop', 'cancel', 'abort'];
const SLASH_VERBS: readonly string[] = ['/stop', '/cancel', '/abort'];

export interface AbortIntent {
  intent: 'abort';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MENTION_VERB_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\s+(${ABORT_VERBS.join('|')})$`,
  'i',
);

export function parseAbortIntent(
  content: string,
  isDm: boolean,
): AbortIntent | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  const lower = trimmed.toLowerCase();

  if (SLASH_VERBS.includes(lower)) {
    return { intent: 'abort' };
  }

  if (MENTION_VERB_PATTERN.test(trimmed)) {
    return { intent: 'abort' };
  }

  if (isDm && ABORT_VERBS.includes(lower)) {
    return { intent: 'abort' };
  }

  return null;
}

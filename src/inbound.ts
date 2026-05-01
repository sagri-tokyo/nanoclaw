/**
 * Host-side inbound message dispatcher.
 *
 * Extracted from `index.ts`'s `channelOpts.onMessage` so the dispatch
 * order can be unit-tested without bringing up the full main() startup.
 *
 * Order of checks (must remain stable):
 *
 *   1. `/remote-control` and `/remote-control-end` — slash commands the
 *      host already intercepts before storage. Untouched.
 *   2. Sender-allowlist drop mode — gates everything that follows. Abort
 *      shares the dispatch allowlist (sagri-tokyo/sagri-ai#129 AC: "no
 *      additional ACL — the allowlist is already the gate for who can
 *      talk to the bot"), so a sender that drop-mode would silence can
 *      not kill an active task either.
 *   3. Abort intent (`parseAbortIntent`) — intercepted before storage so
 *      the message never reaches the agent inside the container we are
 *      about to kill.
 *   4. `storeMessage` — ordinary delivery path.
 */

import { parseAbortIntent } from './abort-trigger.js';
import { logger } from './logger.js';
import {
  isSenderAllowed,
  shouldDropMessage,
  type SenderAllowlistConfig,
} from './sender-allowlist.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export interface InboundDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  storeMessage: (msg: NewMessage) => void;
  handleAbort: (chatJid: string, msg: NewMessage) => void | Promise<void>;
  handleRemoteControl: (
    command: string,
    chatJid: string,
    msg: NewMessage,
  ) => void | Promise<void>;
  loadSenderAllowlist: () => SenderAllowlistConfig;
}

export function handleInboundMessage(
  chatJid: string,
  msg: NewMessage,
  deps: InboundDeps,
): void {
  const trimmed = msg.content.trim();

  if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
    Promise.resolve(deps.handleRemoteControl(trimmed, chatJid, msg)).catch(
      (err) => logger.error({ err, chatJid }, 'Remote control command error'),
    );
    return;
  }

  if (
    !msg.is_from_me &&
    !msg.is_bot_message &&
    deps.registeredGroups()[chatJid]
  ) {
    const cfg = deps.loadSenderAllowlist();
    if (
      shouldDropMessage(chatJid, cfg) &&
      !isSenderAllowed(chatJid, msg.sender, cfg)
    ) {
      if (cfg.logDenied) {
        logger.debug(
          { chatJid, sender: msg.sender },
          'sender-allowlist: dropping message (drop mode)',
        );
      }
      return;
    }
  }

  if (parseAbortIntent(msg.content, msg.is_dm === true)) {
    logger.info(
      { chatJid, sender: msg.sender, messageId: msg.id },
      'Abort intent intercepted',
    );
    Promise.resolve(deps.handleAbort(chatJid, msg)).catch((err) =>
      logger.error({ err, chatJid }, 'Abort handler error'),
    );
    return;
  }

  deps.storeMessage(msg);
}

/**
 * HARNESS-ONLY fake channel for the D2.4 org-action end-to-end exercise.
 *
 * Registers only when NANOCLAW_HARNESS=1, so production boots are untouched.
 * It self-drives the whole round-trip with no real Slack:
 *   1. on connect, after a delay, injects an operator request (inbound) that
 *      should make the container agent call mcp__nanoclaw__org_action;
 *   2. records every outbound host message (the held-action approval prompt);
 *   3. when it sees a prompt carrying `approve <token>`, injects an approval
 *      reply from an allow-listed approver — exercising the real inbound
 *      approval path and the host's exactly-once execution.
 *
 * The only real I/O in the run is the Claude API call the container makes.
 */
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';

const HARNESS_JID = process.env.NANOCLAW_HARNESS_JID ?? 'harness:test';
const APPROVER = process.env.NANOCLAW_HARNESS_APPROVER ?? 'U_HARNESS_APPROVER';
const TRIGGER =
  process.env.NANOCLAW_HARNESS_TRIGGER ??
  'Use the org-actions skill to set the Status property of Notion page 11111111111111111111111111111111 to "Approved". Treat 11111111111111111111111111111111 as the already-verified page id. This is a lifecycle status a poller acts on, so submit it through mcp__nanoclaw__org_action.';

function log(line: string) {
  console.log(`\n  [HARNESS] ${line}`);
}

class HarnessChannel implements Channel {
  name = 'harness';
  private connected = false;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];
  private approved = false;
  private confirmations = 0;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.connected = true;
    // Create the chats row first (messages.chat_jid FK -> chats.jid), the way a
    // real channel does when it first observes a chat.
    this.onChatMetadata(
      HARNESS_JID,
      new Date().toISOString(),
      'harness-test',
      'harness',
      true,
    );
    log(`connected. jid=${HARNESS_JID} approver=${APPROVER}`);
    setTimeout(() => this.inject(TRIGGER, APPROVER, 'Operator'), 2500);
  }

  private inject(content: string, sender: string, senderName: string) {
    const msg: NewMessage = {
      id: `harness-${Date.now()}`,
      chat_jid: HARNESS_JID,
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      is_dm: false,
    };
    log(`>>> INBOUND from ${senderName} (${sender}):\n      ${content}`);
    this.onMessage(HARNESS_JID, msg);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === HARNESS_JID;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    log(`<<< OUTBOUND host -> ${jid}:\n${text.replace(/^/gm, '      | ')}`);

    // The host's held-action approval prompt — approve it as the allow-listed approver.
    const m = text.match(/approve\s+([A-Za-z0-9_-]{43})/);
    if (m && !this.approved) {
      this.approved = true;
      const token = m[1];
      log(`detected held-action token ${token}; injecting approval in 1.5s`);
      setTimeout(
        () => this.inject(`approve ${token}`, APPROVER, 'Approver'),
        1500,
      );
      return;
    }

    // The agent is asking the operator to confirm before it acts — play the
    // operator and say yes, so the conversation proceeds to the org_action call.
    // Capped so a misread can't loop forever.
    if (
      process.env.NANOCLAW_HARNESS_AUTOCONFIRM === '1' &&
      !this.approved &&
      this.confirmations < 2 &&
      /(should i|shall i|go ahead|confirm|proceed|want me to|do you want|\?\s*$)/i.test(
        text,
      )
    ) {
      this.confirmations += 1;
      log(`agent asked to confirm; re-sending the full request in 1.5s`);
      // Re-send the original full request verbatim (a specific actionable
      // intent the reader won't flag as ambiguous), not a bare "yes".
      setTimeout(() => this.inject(TRIGGER, APPROVER, 'Operator'), 1500);
    }
  }
}

if (process.env.NANOCLAW_HARNESS === '1') {
  logger.warn(
    'HARNESS channel active (NANOCLAW_HARNESS=1) — not for production',
  );
  registerChannel('harness', (opts: ChannelOpts) => new HarnessChannel(opts));
}

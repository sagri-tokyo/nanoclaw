/**
 * Level-1 manual exercise harness for the D2.4 org-action gate (#64).
 *
 * Drives the REAL IPC entry (`processTaskIpc`) for the container's `org_action`
 * drop, and the REAL inbound dispatch (`handleInboundMessage`) for the approve
 * reply — the exact two seams index.ts wires in production. Adds, over the
 * gate-only harness: IPC field/enum validation, canonical_args object check,
 * chatJid resolution from registeredGroups, the action-record audit sink, and
 * the inbound check ordering (allowlist drop -> abort -> approval intercept).
 *
 * Slack send + the notion/github write clients are the only stubs (loggers).
 * No container, no LLM, no real Slack.
 *
 * Run: PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH npx tsx harness-org-action-ipc.mts
 */
import { processTaskIpc, type IpcDeps } from './src/ipc.js';
import { handleInboundMessage, type InboundDeps } from './src/inbound.js';
import {
  driveOrgActionRequest,
  handleApprovalReply,
  type OrgActionGateDeps,
} from './src/org-action-handler.js';
import { parseApprovalIntent } from './src/approval-trigger.js';
import { _initTestDatabase, getPendingAction } from './src/db.js';
import type { ActionRecord } from './src/logger.js';
import type { SenderAllowlistConfig } from './src/sender-allowlist.js';
import type { NewMessage, RegisteredGroup } from './src/types.js';

const CHAT = 'slack:C0DEVCHANNEL';
const GROUP = 'sagri-ai-dev';
const APPROVER = 'U_APPROVER';

const slackOut: string[] = [];
const executed: { action: string; target_ref: string }[] = [];
const stored: NewMessage[] = []; // messages that fell through to ordinary delivery
const audit: ActionRecord[] = []; // the IPC action-record telemetry sink

function banner(t: string) {
  console.log(`\n${'='.repeat(74)}\n  ${t}\n${'='.repeat(74)}`);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const registeredGroups = (): Record<string, RegisteredGroup> => ({
  [CHAT]: {
    name: 'dev',
    folder: GROUP,
    trigger: '@sagri-ai',
    added_at: '2026-06-29T00:00:00.000Z',
    isMain: true,
  },
});

const allowlist = (): SenderAllowlistConfig => ({
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
});

// --- the real gate deps, with Slack + write clients as loggers ---
const gate: OrgActionGateDeps = {
  approvers: () => new Set([APPROVER]),
  sendMessage: async (jid, text) => {
    slackOut.push(text);
    console.log(`  [slack -> ${jid}]\n` + text.replace(/^/gm, '    | '));
  },
  executeAction: async (req) => {
    executed.push({ action: req.action, target_ref: req.target_ref });
    console.log(
      `  [WRITE-CLIENT FIRED] ${req.action} target=${req.target_ref} args=${JSON.stringify(req.canonical_args)}`,
    );
  },
  resolveNotionTarget: async (query) => {
    console.log(`  [RESOLVE-NOTION-TARGET] query=${JSON.stringify(query)}`);
    return { kind: 'resolved', id: 'a'.repeat(32), title: query };
  },
  now: () => '2026-06-29T00:00:00.000Z',
  ttlMs: 60_000,
  mintToken: () => mintNext,
};
let mintNext = '';

const ipcDeps: IpcDeps = {
  sendMessage: gate.sendMessage,
  registeredGroups,
  registerGroup: () => {},
  syncGroups: async () => {},
  getAvailableGroups: () => [],
  writeGroupsSnapshot: () => {},
  onTasksChanged: () => {},
  onOrgAction: (record, sourceGroup, chatJid) =>
    driveOrgActionRequest(
      record,
      { sourceGroup, chatJid, requesterGroup: sourceGroup },
      gate,
    ),
  actionSink: (rec) => {
    audit.push(rec);
    console.log(
      `  [audit] tool=${rec.tool} outcome=${rec.outcome} error_class=${rec.error_class ?? '-'}`,
    );
  },
};

// mirrors index.ts handleApproval: sync classify, fire-and-forget execute
const inboundDeps: InboundDeps = {
  registeredGroups,
  storeMessage: (msg) => {
    stored.push(msg);
    console.log(`  [stored as ordinary message] "${msg.content}"`);
  },
  handleAbort: () => {},
  handleRemoteControl: () => {},
  handleApproval: (chatJid, msg) => {
    if (!parseApprovalIntent(msg.content)) return false;
    void handleApprovalReply(chatJid, msg, gate);
    return true;
  },
  loadSenderAllowlist: allowlist,
};

// The raw blob the container drops into its IPC dir (intentionally untyped:
// processTaskIpc owns all validation).
function dropOrgAction(blob: Record<string, unknown>) {
  return processTaskIpc(
    { type: 'org_action', ...blob } as never,
    GROUP,
    true,
    ipcDeps,
  );
}
function inbound(content: string, over: Partial<NewMessage> = {}) {
  handleInboundMessage(
    CHAT,
    {
      id: 'm',
      chat_jid: CHAT,
      sender: APPROVER,
      sender_name: 'Approver',
      content,
      timestamp: '2026-06-29T00:01:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      ...over,
    },
    inboundDeps,
  );
}
const TOK = (n: string) => (n + 'x'.repeat(43)).slice(0, 43);

async function main() {
  _initTestDatabase();

  banner(
    'A. IPC VALIDATION — malformed drops are rejected at the entry, gate never runs',
  );
  console.log('  A1. missing target_ref:');
  await dropOrgAction({
    action: 'notion.append_progress',
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: {},
  });
  console.log('  A2. stakes_hint outside the enum ("maybe"):');
  await dropOrgAction({
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'maybe',
    canonical_args: {},
  });
  console.log(
    '  A3. canonical_args is an array, not an object (would-be coerced-to-{} attack):',
  );
  await dropOrgAction({
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: [],
  });
  console.log('  A4. citation_refs not a string array:');
  await dropOrgAction({
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: {},
    citation_refs: [1, 2],
  });
  console.log(`  -> gate executions so far: ${executed.length} (want 0)`);

  banner(
    'B. SAFE drop through IPC -> classified execute -> write fires, audit ok',
  );
  await dropOrgAction({
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: { text: 'progress' },
  });

  banner(
    'C. GATED drop through IPC -> held + Slack prompt (agent under-claims stakes_hint:safe)',
  );
  mintNext = TOK('IPC1');
  await dropOrgAction({
    action: 'notion.write_property',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: { property: 'Status', value: 'Approved' },
  });
  console.log(`  db state: ${getPendingAction(mintNext)?.state}`);

  banner(
    'D. INBOUND approve via handleInboundMessage -> intercepted, single execute',
  );
  inbound(`approve ${TOK('IPC1')}`);
  await flush();
  console.log(
    `  db state: ${getPendingAction(TOK('IPC1'))?.state}, stored-as-ordinary: ${stored.length} (want 0)`,
  );

  banner(
    'E. INBOUND exactly-once — replay the same approve, no second execute',
  );
  const before = executed.length;
  inbound(`approve ${TOK('IPC1')}`);
  await flush();
  console.log(`  executes from replay: ${executed.length - before} (want 0)`);

  banner('F. INBOUND adversarial approvers on a fresh held action');
  mintNext = TOK('IPC2');
  await dropOrgAction({
    action: 'notion.write_property',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'gated',
    canonical_args: { property: 'Status', value: 'Ready for AI' },
  });
  const exF = executed.length;
  console.log('  F1. bot sender:');
  inbound(`approve ${TOK('IPC2')}`, { is_bot_message: true, bot_id: 'B1' });
  console.log('  F2. non-allowlisted human:');
  inbound(`approve ${TOK('IPC2')}`, { sender: 'U_RANDO' });
  await flush();
  console.log(
    `  executes from attacks: ${executed.length - exF} (want 0), row: ${getPendingAction(TOK('IPC2'))?.state}`,
  );
  console.log('  F3. real approver:');
  inbound(`approve ${TOK('IPC2')}`);
  await flush();
  console.log(`  row: ${getPendingAction(TOK('IPC2'))?.state}`);

  banner(
    'G. ADVERSARIAL stakes_hint via IPC — agent lies safe on a red-line target -> refused',
  );
  const exG = executed.length;
  await dropOrgAction({
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    canonical_args: { text: 'touch the mrv carbon ledger' },
  });
  console.log(`  writes: ${executed.length - exG} (want 0)`);

  banner(
    'H. ORDINARY message falls through to storeMessage (not an approval keyword)',
  );
  inbound('hey what is the status of the soil model run?');
  await flush();
  console.log(`  stored: ${stored.length} (want 1)`);

  banner('TALLY');
  console.log(`  write-client executions: ${executed.length}`);
  console.log(`  executed: ${JSON.stringify(executed)}`);
  console.log(`  slack posts: ${slackOut.length}`);
  console.log(
    `  audit rows: ${audit.length} (${audit.map((a) => a.outcome).join(', ')})`,
  );
}

main();

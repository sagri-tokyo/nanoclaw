/**
 * Manual exercise harness for the D2.4 org-action approval gate (#64).
 *
 * Drives the REAL host gate (classify -> hold -> approve -> exactly-once
 * execute, plus boot re-drive) with Slack input/output and the notion/github
 * write clients replaced by loggers. No container, no LLM, no real Slack.
 *
 * Run: PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH npx tsx harness-org-action.mts
 */
import {
  driveOrgActionRequest,
  handleApprovalReply,
  reDriveApprovedActions,
  type OrgActionGateDeps,
  type OrgActionRequestInput,
} from './src/org-action-handler.js';
import {
  _initTestDatabase,
  createPendingAction,
  getPendingAction,
} from './src/db.js';
import type { NewMessage, PendingActionRow } from './src/types.js';

const CHAT = 'slack:C0DEVCHANNEL';
const GROUP = 'sagri-ai-dev';
const APPROVER = 'U_APPROVER';

// --- Slack + write-client stubs: every side effect lands here as a log line ---
const slackOut: string[] = [];
const executed: { action: string; target_ref: string }[] = [];

function banner(title: string) {
  console.log(`\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}`);
}

function deps(token?: string): OrgActionGateDeps {
  return {
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
    mintToken: token ? () => token : undefined,
  };
}

function ctx() {
  return { sourceGroup: GROUP, chatJid: CHAT, requesterGroup: GROUP };
}

function agentEmits(
  over: Partial<OrgActionRequestInput>,
): OrgActionRequestInput {
  return {
    action: 'notion.append_progress',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'safe',
    citation_refs: [],
    canonical_args: {},
    ...over,
  };
}

function approveMsg(token: string, over: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: CHAT,
    sender: APPROVER,
    sender_name: 'Approver',
    content: `approve ${token}`,
    timestamp: '2026-06-29T00:01:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...over,
  };
}

const TOK = (n: string) => (n + 'x'.repeat(43)).slice(0, 43); // 43-char base64url

async function main() {
  _initTestDatabase();

  banner(
    '1. SAFE action — agent says stakes_hint:safe, host agrees -> executes now',
  );
  await driveOrgActionRequest(
    agentEmits({
      action: 'notion.append_progress',
      canonical_args: { text: 'progress note' },
    }),
    ctx(),
    deps(),
  );

  banner(
    '2. GATED lifecycle flip — Status->Approved is held, posts approval prompt',
  );
  const t2 = TOK('GATED1');
  await driveOrgActionRequest(
    agentEmits({
      action: 'notion.write_property',
      stakes_hint: 'safe', // agent under-claims; host still holds
      canonical_args: { property: 'Status', value: 'Approved' },
    }),
    ctx(),
    deps(t2),
  );
  console.log(`  db state after hold: ${getPendingAction(t2)?.state}`);

  banner('2b. distinct approver replies `approve <token>` -> single execution');
  await handleApprovalReply(CHAT, approveMsg(t2), deps(t2));
  console.log(`  db state after approve: ${getPendingAction(t2)?.state}`);

  banner('2c. EXACTLY-ONCE — replay the same approve -> no second execution');
  const before = executed.length;
  await handleApprovalReply(CHAT, approveMsg(t2), deps(t2));
  console.log(
    `  executes triggered by replay: ${executed.length - before} (want 0)`,
  );

  banner(
    '3. ADVERSARIAL stakes_hint — agent LIES safe on a red-line (mrv) target -> refused, no row, no write',
  );
  const beforeEx = executed.length;
  await driveOrgActionRequest(
    agentEmits({
      action: 'notion.append_progress',
      target_ref: 'a'.repeat(32),
      stakes_hint: 'safe',
      canonical_args: { text: 'update the mrv carbon ledger' },
    }),
    ctx(),
    deps(),
  );
  console.log(
    `  writes fired: ${executed.length - beforeEx} (want 0), slack posts: 0 expected`,
  );

  banner('3b. red-line in target_ref written in Japanese (自治体) -> refused');
  await driveOrgActionRequest(
    agentEmits({
      action: 'doc.draft',
      target_ref: 'b'.repeat(32),
      canonical_args: { body: 'memo about 自治体 onboarding' },
    }),
    ctx(),
    deps(),
  );

  banner(
    '4. ADVERSARIAL approver — hold a gated action, then attack the approval',
  );
  const t4 = TOK('GATED2');
  await driveOrgActionRequest(
    agentEmits({
      action: 'notion.write_property',
      canonical_args: { property: 'Status', value: 'Ready for AI' },
    }),
    ctx(),
    deps(t4),
  );
  const exBefore = executed.length;

  console.log('\n  4a. bot/self message tries to approve:');
  await handleApprovalReply(
    CHAT,
    approveMsg(t4, { sender: APPROVER, is_bot_message: true, bot_id: 'B123' }),
    deps(t4),
  );
  console.log('  4b. non-allowlisted human tries to approve:');
  await handleApprovalReply(
    CHAT,
    approveMsg(t4, { sender: 'U_RANDO' }),
    deps(t4),
  );
  console.log(
    `  writes fired by attacks: ${executed.length - exBefore} (want 0), row still: ${getPendingAction(t4)?.state}`,
  );
  console.log('  4c. real allowlisted approver -> executes:');
  await handleApprovalReply(CHAT, approveMsg(t4), deps(t4));
  console.log(`  row after legit approve: ${getPendingAction(t4)?.state}`);

  banner(
    '5. github out-of-allowlist repo -> refused; allowlisted repo -> executes',
  );
  await driveOrgActionRequest(
    agentEmits({
      action: 'github.file_issue',
      target_ref: 'attacker/evil-repo',
      canonical_args: { title: 'x' },
    }),
    ctx(),
    deps(),
  );
  await driveOrgActionRequest(
    agentEmits({
      action: 'github.file_issue',
      target_ref: 'sagri-tokyo/sagri-ai',
      reversibility: 'draft',
      canonical_args: { title: 'real issue' },
    }),
    ctx(),
    deps(),
  );

  banner(
    '6. RE-CLASSIFY-AT-APPROVE — a tampered approved row (red-line target) cannot execute',
  );
  // Simulate a row that reached state=approved but whose persisted args are a red line
  // (DB tampering / a classifier change between hold and approve). Boot re-drive must refuse it.
  const t6 = TOK('TAMPER');
  const tampered: PendingActionRow = {
    token: t6,
    source_group: GROUP,
    chat_jid: CHAT,
    action: 'notion.append_progress',
    target_ref: 'c'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'gated',
    citation_refs: '[]',
    canonical_args: JSON.stringify({ text: 'tamper: prod deploy' }),
    summary: 'tampered',
    requester: GROUP,
    state: 'approved',
    created_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-06-29T01:00:00.000Z',
    approved_by: APPROVER,
    consumed_at: null,
  };
  createPendingAction(tampered);
  const exB = executed.length;
  await reDriveApprovedActions(deps());
  console.log(
    `  writes fired for tampered row: ${executed.length - exB} (want 0), row left: ${getPendingAction(t6)?.state}`,
  );

  banner('TALLY');
  console.log(`  total write-client executions: ${executed.length}`);
  console.log(`  executed actions: ${JSON.stringify(executed, null, 2)}`);
  console.log(`  total slack posts: ${slackOut.length}`);
}

main();

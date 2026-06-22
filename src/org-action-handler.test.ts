import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  getPendingAction,
  getApprovedUnconsumed,
  createPendingAction,
} from './db.js';
import {
  driveOrgActionRequest,
  handleApprovalReply,
  reDriveApprovedActions,
  type OrgActionGateDeps,
} from './org-action-handler.js';
import type { NewMessage, PendingActionRow } from './types.js';

const HEX32 = 'a'.repeat(32);

beforeEach(() => {
  _initTestDatabase();
});

interface Recorder {
  executed: { action: string; target_ref: string }[];
  posted: { jid: string; text: string }[];
}

function makeDeps(overrides: Partial<OrgActionGateDeps> = {}): {
  deps: OrgActionGateDeps;
  rec: Recorder;
} {
  const rec: Recorder = { executed: [], posted: [] };
  const deps: OrgActionGateDeps = {
    approvers: () => new Set(['U_APPROVER']),
    sendMessage: async (jid, text) => {
      rec.posted.push({ jid, text });
    },
    executeAction: async (req) => {
      rec.executed.push({ action: req.action, target_ref: req.target_ref });
    },
    now: () => '2026-06-22T00:00:00.000Z',
    ttlMs: 24 * 60 * 60 * 1000,
    mintToken: () => 'T'.repeat(43),
    ...overrides,
  };
  return { deps, rec };
}

function approval(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: 'slack:C0AAA1111',
    sender: 'U_APPROVER',
    sender_name: 'Approver',
    content: `approve ${'T'.repeat(43)}`,
    timestamp: '2026-06-22T01:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

const TOKEN = 'T'.repeat(43);

function pendingActionRow(
  overrides: Partial<PendingActionRow> = {},
): PendingActionRow {
  return {
    token: TOKEN,
    source_group: 'g',
    chat_jid: 'slack:C0AAA1111',
    action: 'notion.write_property',
    target_ref: HEX32,
    reversibility: 'reversible',
    stakes_hint: 'gated',
    citation_refs: '[]',
    canonical_args: '{"property":"Status","value":"Ready for AI"}',
    summary: 's',
    requester: 'g',
    state: 'pending',
    created_at: '2026-06-22T00:00:00.000Z',
    expires_at: '2026-06-23T00:00:00.000Z',
    approved_by: null,
    consumed_at: null,
    ...overrides,
  };
}

describe('driveOrgActionRequest — safe vs gated', () => {
  it('executes a safe action immediately, no row, no prompt', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'notion.append_progress',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'safe',
        citation_refs: [],
        canonical_args: { text: 'hi' },
      },
      {
        sourceGroup: 'g',
        chatJid: 'slack:C0AAA1111',
        requesterGroup: 'g',
      },
      deps,
    );
    expect(rec.executed).toEqual([
      { action: 'notion.append_progress', target_ref: HEX32 },
    ]);
    expect(rec.posted).toHaveLength(0);
  });

  it('holds a gated action: writes a pending row, posts a prompt, no effect', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: HEX32,
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: ['wiki/x.md'],
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      {
        sourceGroup: 'g',
        chatJid: 'slack:C0AAA1111',
        requesterGroup: 'g',
      },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    const row = getPendingAction('T'.repeat(43));
    expect(row?.state).toBe('pending');
    expect(row?.requester).toBe('g');
    expect(rec.posted).toHaveLength(1);
    expect(rec.posted[0].text).toContain('T'.repeat(43));
    expect(rec.posted[0].text).toContain('Ready for AI');
  });

  it('refuses a red-line action: no row, no effect, refusal posted', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: `prod-${HEX32}`,
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      },
      {
        sourceGroup: 'g',
        chatJid: 'slack:C0AAA1111',
        requesterGroup: 'g',
      },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))).toBeUndefined();
  });
});

function seedGated(
  deps: OrgActionGateDeps,
  requesterGroup = 'g',
): Promise<void> {
  return driveOrgActionRequest(
    {
      action: 'notion.write_property',
      target_ref: HEX32,
      reversibility: 'reversible',
      stakes_hint: 'gated',
      citation_refs: [],
      canonical_args: { property: 'Status', value: 'Ready for AI' },
    },
    { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requesterGroup },
    deps,
  );
}

describe('handleApprovalReply — fail-closed approver checks', () => {
  it('rejects an approver not in the allowlist', async () => {
    const { deps, rec } = makeDeps({ approvers: () => new Set() });
    await seedGated(deps);
    const handled = await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_RANDOM' }),
      deps,
    );
    expect(handled).toBe(true);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('pending');
  });

  it('rejects a bot-sourced approval message', async () => {
    const { deps, rec } = makeDeps();
    await seedGated(deps);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_APPROVER', is_bot_message: true, bot_id: 'B1' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('pending');
  });

  it('rejects is_from_me', async () => {
    const { deps, rec } = makeDeps();
    await seedGated(deps);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ is_from_me: true }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
  });

  it('rejects an approver whose id equals the requesting group (group-level guard)', async () => {
    // row.requester holds the requesting GROUP FOLDER, not a user id. This
    // guard only excludes the degenerate case where the approver allowlist
    // names a group-folder string. It is NOT user-level self-approval
    // prevention — see the documented limitation below.
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['g']),
    });
    await seedGated(deps, 'g');
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'g' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('pending');
  });

  it('DOES NOT block a user-level self-approval — the guard is group-level only', async () => {
    // The triggering Slack user id is not available at the org_action drain,
    // so the persisted requester is the group folder ('g'), never the user.
    // An approver who was also the (unknowable) triggering human is therefore
    // NOT excluded by row.requester !== msg.sender. This test pins the TRUE
    // property: user-level dual control is enforced by the approver allowlist
    // membership, not by a requester-vs-approver comparison.
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['U_HUMAN']),
    });
    await seedGated(deps, 'g');
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_HUMAN' }),
      deps,
    );
    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('consumed');
  });

  it('returns false (not an approval message) for ordinary text', async () => {
    const { deps } = makeDeps();
    const handled = await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ content: 'just chatting' }),
      deps,
    );
    expect(handled).toBe(false);
  });
});

describe('handleApprovalReply — execution + exactly-once', () => {
  it('approves and executes exactly once; a second approve is a no-op', async () => {
    const { deps, rec } = makeDeps();
    await seedGated(deps);

    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('consumed');

    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toHaveLength(1);
  });

  it('re-classifies host-side and refuses a record that became red-line', async () => {
    const { deps, rec } = makeDeps();
    // Insert an approved row directly whose target is a red line — the
    // approve-time re-check must refuse it even though it is already approved.
    createPendingAction(pendingActionRow({ target_ref: `prod-${HEX32}` }));
    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toHaveLength(0);
  });

  it('deny drops the row terminally', async () => {
    const { deps, rec } = makeDeps();
    await seedGated(deps);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ content: `reject ${'T'.repeat(43)}` }),
      deps,
    );
    expect(getPendingAction('T'.repeat(43))?.state).toBe('denied');
    // A later approve cannot revive it.
    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toHaveLength(0);
  });

  it('cannot approve an expired token', async () => {
    const { deps, rec } = makeDeps();
    createPendingAction(
      pendingActionRow({
        state: 'expired',
        created_at: '2026-06-20T00:00:00.000Z',
        expires_at: '2026-06-21T00:00:00.000Z',
      }),
    );
    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('expired');
  });
});

describe('parsePendingRow validation — no coercion on the security path', () => {
  // On the live approve path the validation throw propagates (fail-fast). The
  // row is left approved (approvePendingAction ran), never consumed or executed.
  async function approveAndExpect(
    bad: Partial<PendingActionRow>,
    pattern: RegExp,
  ): Promise<void> {
    const { deps, rec } = makeDeps();
    createPendingAction(pendingActionRow(bad));
    await expect(
      handleApprovalReply('slack:C0AAA1111', approval(), deps),
    ).rejects.toThrow(pattern);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('approved');
  }

  it('throws and never consumes when canonical_args is a JSON array, not an object', async () => {
    await approveAndExpect(
      { canonical_args: '[1,2,3]' },
      /non-object canonical_args/,
    );
  });

  it('throws and never consumes when citation_refs is not a string array', async () => {
    await approveAndExpect(
      { citation_refs: '[1,2]' },
      /non-string\[\] citation_refs/,
    );
  });

  it('throws and never consumes when reversibility is outside the allowed set', async () => {
    await approveAndExpect(
      { reversibility: 'bogus' as PendingActionRow['reversibility'] },
      /invalid reversibility/,
    );
  });

  it('throws and never consumes when stakes_hint is outside the allowed set', async () => {
    await approveAndExpect(
      { stakes_hint: 'bogus' as PendingActionRow['stakes_hint'] },
      /invalid stakes_hint/,
    );
  });
});

describe('reDriveApprovedActions — boot re-drive, exactly-once', () => {
  it('replays an approved-unconsumed row and consumes it', async () => {
    const { deps, rec } = makeDeps();
    createPendingAction(
      pendingActionRow({ state: 'approved', approved_by: 'U_APPROVER' }),
    );
    expect(getApprovedUnconsumed()).toHaveLength(1);

    await reDriveApprovedActions(deps);
    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('consumed');
    expect(rec.posted).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: `Executed a previously approved action (${'T'.repeat(43)}) on restart.`,
      },
    ]);

    // Idempotent: a second boot does nothing.
    await reDriveApprovedActions(deps);
    expect(rec.executed).toHaveLength(1);
    expect(rec.posted).toHaveLength(1);
  });

  it('leaves a row that re-classifies as refuse approved, executing nothing', async () => {
    const { deps, rec } = makeDeps();
    createPendingAction(
      pendingActionRow({
        target_ref: `prod-${HEX32}`,
        state: 'approved',
        approved_by: 'U_APPROVER',
      }),
    );

    await reDriveApprovedActions(deps);

    expect(rec.executed).toHaveLength(0);
    expect(rec.posted).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('approved');
  });

  it('isolates an unparseable row and still drives the healthy rows behind it', async () => {
    const { deps, rec } = makeDeps();
    const approved: Partial<PendingActionRow> = {
      state: 'approved',
      approved_by: 'U_APPROVER',
    };
    createPendingAction(
      pendingActionRow({
        ...approved,
        token: 'C'.repeat(43),
        canonical_args: '[1,2,3]',
      }),
    );
    createPendingAction(
      pendingActionRow({ ...approved, token: 'H'.repeat(43) }),
    );

    await reDriveApprovedActions(deps);

    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('C'.repeat(43))?.state).toBe('approved');
    expect(getPendingAction('H'.repeat(43))?.state).toBe('consumed');
  });
});

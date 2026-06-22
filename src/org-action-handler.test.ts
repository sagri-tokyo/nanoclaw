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
      { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requester: 'U_REQ' },
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
      { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requester: 'U_REQ' },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    const row = getPendingAction('T'.repeat(43));
    expect(row?.state).toBe('pending');
    expect(row?.requester).toBe('U_REQ');
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
      { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requester: 'U_REQ' },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))).toBeUndefined();
  });
});

function seedGated(deps: OrgActionGateDeps, requester = 'U_REQ'): Promise<void> {
  return driveOrgActionRequest(
    {
      action: 'notion.write_property',
      target_ref: HEX32,
      reversibility: 'reversible',
      stakes_hint: 'gated',
      citation_refs: [],
      canonical_args: { property: 'Status', value: 'Ready for AI' },
    },
    { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requester },
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

  it('rejects requester === approver (no self-approve)', async () => {
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['U_REQ']),
    });
    await seedGated(deps, 'U_REQ');
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_REQ' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('pending');
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
    const row: PendingActionRow = {
      token: 'T'.repeat(43),
      source_group: 'g',
      chat_jid: 'slack:C0AAA1111',
      action: 'notion.write_property',
      target_ref: `prod-${HEX32}`,
      reversibility: 'reversible',
      stakes_hint: 'gated',
      citation_refs: '[]',
      canonical_args: '{"property":"Status","value":"Ready for AI"}',
      summary: 's',
      requester: 'U_REQ',
      state: 'pending',
      created_at: '2026-06-22T00:00:00.000Z',
      expires_at: '2026-06-23T00:00:00.000Z',
      approved_by: null,
      consumed_at: null,
    };
    createPendingAction(row);
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
    const row: PendingActionRow = {
      token: 'T'.repeat(43),
      source_group: 'g',
      chat_jid: 'slack:C0AAA1111',
      action: 'notion.write_property',
      target_ref: HEX32,
      reversibility: 'reversible',
      stakes_hint: 'gated',
      citation_refs: '[]',
      canonical_args: '{"property":"Status","value":"Ready for AI"}',
      summary: 's',
      requester: 'U_REQ',
      state: 'expired',
      created_at: '2026-06-20T00:00:00.000Z',
      expires_at: '2026-06-21T00:00:00.000Z',
      approved_by: null,
      consumed_at: null,
    };
    createPendingAction(row);
    await handleApprovalReply('slack:C0AAA1111', approval(), deps);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('expired');
  });
});

describe('reDriveApprovedActions — boot re-drive, exactly-once', () => {
  it('replays an approved-unconsumed row and consumes it', async () => {
    const { deps, rec } = makeDeps();
    const row: PendingActionRow = {
      token: 'T'.repeat(43),
      source_group: 'g',
      chat_jid: 'slack:C0AAA1111',
      action: 'notion.write_property',
      target_ref: HEX32,
      reversibility: 'reversible',
      stakes_hint: 'gated',
      citation_refs: '[]',
      canonical_args: '{"property":"Status","value":"Ready for AI"}',
      summary: 's',
      requester: 'U_REQ',
      state: 'approved',
      created_at: '2026-06-22T00:00:00.000Z',
      expires_at: '2026-06-23T00:00:00.000Z',
      approved_by: 'U_APPROVER',
      consumed_at: null,
    };
    createPendingAction(row);
    expect(getApprovedUnconsumed()).toHaveLength(1);

    await reDriveApprovedActions(deps);
    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('T'.repeat(43))?.state).toBe('consumed');

    // Idempotent: a second boot does nothing.
    await reDriveApprovedActions(deps);
    expect(rec.executed).toHaveLength(1);
  });
});

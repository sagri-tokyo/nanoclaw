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
import type { NotionTargetResolution } from './org-action-clients.js';
import type { NewMessage, PendingActionRow } from './types.js';

const HEX32 = 'a'.repeat(32);
const RESOLVED_ID = 'b'.repeat(32);
const TOKEN = 'T'.repeat(43);

beforeEach(() => {
  _initTestDatabase();
});

interface Recorder {
  executed: { action: string; target_ref: string }[];
  posted: { jid: string; text: string }[];
  resolveQueries: string[];
}

function makeDeps(overrides: Partial<OrgActionGateDeps> = {}): {
  deps: OrgActionGateDeps;
  rec: Recorder;
} {
  const rec: Recorder = { executed: [], posted: [], resolveQueries: [] };
  const deps: OrgActionGateDeps = {
    approvers: () => new Set(['U_APPROVER']),
    sendMessage: async (jid, text) => {
      rec.posted.push({ jid, text });
    },
    executeAction: async (req) => {
      rec.executed.push({ action: req.action, target_ref: req.target_ref });
    },
    // Default records the query and refuses (no match). Tests that exercise a
    // successful resolution override this; tests asserting "search not called"
    // assert rec.resolveQueries stays empty against this default.
    resolveNotionTarget: async (query): Promise<NotionTargetResolution> => {
      rec.resolveQueries.push(query);
      return { kind: 'unresolved', reason: 'no_match' };
    },
    now: () => '2026-06-22T00:00:00.000Z',
    ttlMs: 24 * 60 * 60 * 1000,
    mintToken: () => TOKEN,
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
    content: `approve ${TOKEN}`,
    timestamp: '2026-06-22T01:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

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
    requester: '["U_HUMAN"]',
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
        requesterIds: ['U_HUMAN'],
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
        requesterIds: ['U_HUMAN'],
      },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    const row = getPendingAction(TOKEN);
    expect(row?.state).toBe('pending');
    expect(row?.requester).toBe('["U_HUMAN"]');
    expect(rec.posted).toHaveLength(1);
    expect(rec.posted[0].text).toContain(TOKEN);
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
        requesterIds: ['U_HUMAN'],
      },
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)).toBeUndefined();
  });
});

describe('driveOrgActionRequest — host-side Notion target resolution', () => {
  const ctx = {
    sourceGroup: 'g',
    chatJid: 'slack:C0AAA1111',
    requesterIds: ['U_HUMAN'],
  };

  function resolverReturning(
    result: NotionTargetResolution,
    recorder: Recorder,
  ): OrgActionGateDeps['resolveNotionTarget'] {
    return async (query) => {
      recorder.resolveQueries.push(query);
      return result;
    };
  }

  it('resolves a name to one id, holds the lifecycle flip, persists the resolved id, and shows the title', async () => {
    const { deps, rec } = makeDeps();
    deps.resolveNotionTarget = resolverReturning(
      { kind: 'resolved', id: RESOLVED_ID, title: 'Soil Model Task' },
      rec,
    );
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'Soil Model Task',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual(['Soil Model Task']);
    expect(rec.executed).toHaveLength(0);
    const row = getPendingAction(TOKEN);
    expect(row?.state).toBe('pending');
    expect(row?.target_ref).toBe(RESOLVED_ID);
    // Build the expected summary literally (NOT via renderApprovalSummary) so
    // this pins the resolved id and the title in the exact
    // `target: "<title>" (<id>)` form independently of the renderer under test.
    const expectedSummary = [
      'action: notion.write_property',
      `target: "Soil Model Task" (${RESOLVED_ID})`,
      'reversibility: reversible',
      'args: property=Status, value=Approved',
      'citations: (none)',
    ].join('\n');
    expect(row?.summary).toBe(expectedSummary);
    expect(rec.posted).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: [
          'Approval required for a held internal action.',
          '',
          expectedSummary,
          '',
          `Reply \`approve ${TOKEN}\` to authorize or \`reject ${TOKEN}\` to drop it.`,
          'An allow-listed approver must authorize this.',
        ].join('\n'),
      },
    ]);
  });

  it('refuses (no hold, no execute) when the name resolves to zero matches', async () => {
    const { deps, rec } = makeDeps();
    deps.resolveNotionTarget = resolverReturning(
      { kind: 'unresolved', reason: 'no_match' },
      rec,
    );
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'Unknown Page',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual(['Unknown Page']);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)).toBeUndefined();
    expect(rec.posted).toHaveLength(0);
  });

  it('refuses when the name resolves to multiple matches', async () => {
    const { deps, rec } = makeDeps();
    deps.resolveNotionTarget = resolverReturning(
      { kind: 'unresolved', reason: 'multiple_matches' },
      rec,
    );
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'Soil',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual(['Soil']);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)).toBeUndefined();
  });

  it('refuses a red-line query before any Notion search call', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'MRV tracker',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual([]);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)).toBeUndefined();
  });

  it('refuses (does not execute) when the resolver throws an API error', async () => {
    const { deps, rec } = makeDeps();
    deps.resolveNotionTarget = async (query) => {
      rec.resolveQueries.push(query);
      throw new Error('notion 500');
    };
    await driveOrgActionRequest(
      {
        action: 'notion.write_property',
        target_ref: '',
        target_query: 'Soil Model Task',
        reversibility: 'reversible',
        stakes_hint: 'gated',
        citation_refs: [],
        canonical_args: { property: 'Status', value: 'Approved' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual(['Soil Model Task']);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)).toBeUndefined();
  });

  it('uses a valid 32-hex target_ref directly without calling the resolver', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'notion.append_progress',
        target_ref: HEX32,
        target_query: 'Ignored Name',
        reversibility: 'reversible',
        stakes_hint: 'safe',
        citation_refs: [],
        canonical_args: { text: 'hi' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual([]);
    expect(rec.executed).toEqual([
      { action: 'notion.append_progress', target_ref: HEX32 },
    ]);
  });

  it('ignores target_query for a github action (no resolution attempted)', async () => {
    const { deps, rec } = makeDeps();
    await driveOrgActionRequest(
      {
        action: 'github.file_issue',
        target_ref: 'sagri-tokyo/sagri-ai',
        target_query: 'Some Name',
        reversibility: 'reversible',
        stakes_hint: 'safe',
        citation_refs: [],
        canonical_args: { title: 'Bug', body: 'Details' },
      },
      ctx,
      deps,
    );
    expect(rec.resolveQueries).toEqual([]);
    expect(rec.executed).toEqual([
      { action: 'github.file_issue', target_ref: 'sagri-tokyo/sagri-ai' },
    ]);
  });
});

function seedGated(
  deps: OrgActionGateDeps,
  requesterIds: string[] = ['U_HUMAN'],
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
    { sourceGroup: 'g', chatJid: 'slack:C0AAA1111', requesterIds },
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
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
  });

  it('rejects an approval whose token belongs to a different channel', async () => {
    const { deps, rec } = makeDeps();
    // Row is held in slack:C0AAA1111 (pendingActionRow default chat_jid).
    createPendingAction(pendingActionRow());
    // The same token, leaked, is replied to from a different channel.
    const handled = await handleApprovalReply(
      'slack:C0BBB2222',
      approval(),
      deps,
    );
    expect(handled).toBe(true);
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
    // Fail-closed.
    expect(rec.posted).toHaveLength(0);
  });

  it('rejects a cross-channel reject, leaving the row pending not denied', async () => {
    const { deps, rec } = makeDeps();
    createPendingAction(pendingActionRow());
    const handled = await handleApprovalReply(
      'slack:C0BBB2222',
      approval({ content: `reject ${TOKEN}` }),
      deps,
    );
    expect(handled).toBe(true);
    expect(rec.posted).toHaveLength(0);
    // The guard precedes the reject branch, so denyPendingAction never runs.
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
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
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
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

  it('rejects a user-level self-approval even from an allow-listed approver', async () => {
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['U_HUMAN']),
    });
    await seedGated(deps, ['U_HUMAN']);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_HUMAN' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
  });

  it('rejects a co-sender of the batch, not just the newest requester', async () => {
    // The batch spanned two humans, so both drove the request and neither may
    // authorize it — the case a single trigger-sender attribution would miss.
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['U_BOB', 'U_ALICE']),
    });
    await seedGated(deps, ['U_BOB', 'U_ALICE']);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_BOB' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
  });

  it('lets a second allow-listed human approve a request they did not make', async () => {
    const { deps, rec } = makeDeps({
      approvers: () => new Set(['U_APPROVER']),
    });
    await seedGated(deps, ['U_HUMAN']);
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'U_APPROVER' }),
      deps,
    );
    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction(TOKEN)?.state).toBe('consumed');
  });

  it('reads a pre-#296 row bare group-folder requester as a single requester', async () => {
    const { deps, rec } = makeDeps({ approvers: () => new Set(['g']) });
    createPendingAction(pendingActionRow({ requester: 'g' }));
    await handleApprovalReply(
      'slack:C0AAA1111',
      approval({ sender: 'g' }),
      deps,
    );
    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
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
    expect(getPendingAction(TOKEN)?.state).toBe('consumed');

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
      approval({ content: `reject ${TOKEN}` }),
      deps,
    );
    expect(getPendingAction(TOKEN)?.state).toBe('denied');
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
    expect(getPendingAction(TOKEN)?.state).toBe('expired');
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
    expect(getPendingAction(TOKEN)?.state).toBe('approved');
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
    expect(getPendingAction(TOKEN)?.state).toBe('consumed');
    expect(rec.posted).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: `Executed a previously approved action (${TOKEN}) on restart.`,
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
    expect(getPendingAction(TOKEN)?.state).toBe('approved');
  });

  it('isolates an unparseable row and still drives the healthy rows behind it', async () => {
    const { deps, rec } = makeDeps();
    createPendingAction(
      pendingActionRow({
        state: 'approved',
        approved_by: 'U_APPROVER',
        token: 'C'.repeat(43),
        canonical_args: '[1,2,3]',
      }),
    );
    createPendingAction(
      pendingActionRow({
        state: 'approved',
        approved_by: 'U_APPROVER',
        token: 'H'.repeat(43),
      }),
    );

    await reDriveApprovedActions(deps);

    expect(rec.executed).toEqual([
      { action: 'notion.write_property', target_ref: HEX32 },
    ]);
    expect(getPendingAction('C'.repeat(43))?.state).toBe('approved');
    expect(getPendingAction('H'.repeat(43))?.state).toBe('consumed');
  });

  it('re-arms a row to approved when the write fails so the next restart retries', async () => {
    const { deps } = makeDeps({
      executeAction: async () => {
        throw new Error('gh exited non-zero');
      },
    });
    createPendingAction(
      pendingActionRow({ state: 'approved', approved_by: 'U_APPROVER' }),
    );

    await expect(reDriveApprovedActions(deps)).rejects.toThrow(
      /gh exited non-zero/,
    );
    // Not stranded in `consumed`: still visible to the next boot re-drive.
    expect(getPendingAction(TOKEN)?.state).toBe('approved');
    expect(getPendingAction(TOKEN)?.consumed_at).toBeNull();
    expect(getApprovedUnconsumed().map((r) => r.token)).toEqual([TOKEN]);
  });

  it('leaves rows behind a failed execute approved for the next restart', async () => {
    const firstToken = 'F'.repeat(43);
    const secondToken = 'S'.repeat(43);
    const { deps } = makeDeps({
      executeAction: async (req) => {
        if (
          req.action === 'notion.write_property' &&
          req.target_ref === HEX32
        ) {
          throw new Error('write failed');
        }
      },
    });
    // created_at orders the re-drive (getApprovedUnconsumed ORDER BY created_at),
    // so the failing row is processed first and the loop rethrows before the
    // second is reached.
    createPendingAction(
      pendingActionRow({
        token: firstToken,
        state: 'approved',
        approved_by: 'U_APPROVER',
        created_at: '2026-06-22T00:00:00.000Z',
      }),
    );
    createPendingAction(
      pendingActionRow({
        token: secondToken,
        target_ref: 'b'.repeat(32),
        state: 'approved',
        approved_by: 'U_APPROVER',
        created_at: '2026-06-22T00:00:01.000Z',
      }),
    );

    await expect(reDriveApprovedActions(deps)).rejects.toThrow(/write failed/);
    // Both end approved via different paths: the first failed and was re-armed,
    // the second was never reached. Both stay visible to the next re-drive.
    expect(getPendingAction(firstToken)?.state).toBe('approved');
    expect(getPendingAction(secondToken)?.state).toBe('approved');
    expect(
      getApprovedUnconsumed()
        .map((r) => r.token)
        .sort(),
    ).toEqual([firstToken, secondToken].sort());
  });
});

describe('handleApprovalReply — failed execution does not silently drop', () => {
  it('re-arms the row to approved when executeAction throws on the live path', async () => {
    const { deps } = makeDeps({
      executeAction: async () => {
        throw new Error('notion 500');
      },
    });
    createPendingAction(pendingActionRow());

    await expect(
      handleApprovalReply('slack:C0AAA1111', approval(), deps),
    ).rejects.toThrow(/notion 500/);
    expect(getPendingAction(TOKEN)?.state).toBe('approved');
    expect(getPendingAction(TOKEN)?.consumed_at).toBeNull();
    expect(getApprovedUnconsumed().map((r) => r.token)).toEqual([TOKEN]);
  });

  it('rejects an approval whose held row has passed its TTL before the sweep', async () => {
    const { deps, rec } = makeDeps({ now: () => '2026-06-24T00:00:00.000Z' });
    createPendingAction(
      pendingActionRow({
        created_at: '2026-06-22T00:00:00.000Z',
        expires_at: '2026-06-23T00:00:00.000Z',
      }),
    );

    await handleApprovalReply('slack:C0AAA1111', approval(), deps);

    expect(rec.executed).toHaveLength(0);
    expect(getPendingAction(TOKEN)?.state).toBe('pending');
    expect(rec.posted).toEqual([
      {
        jid: 'slack:C0AAA1111',
        text: `Cannot approve ${TOKEN}: already resolved, denied, or expired.`,
      },
    ]);
  });
});

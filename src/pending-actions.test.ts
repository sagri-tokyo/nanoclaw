import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  approvePendingAction,
  consumePendingAction,
  createPendingAction,
  denyPendingAction,
  expirePendingActions,
  getApprovedUnconsumed,
  getPendingAction,
} from './db.js';
import type { PendingActionRow } from './types.js';

function row(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  const createdAt = overrides.created_at ?? '2026-06-22T00:00:00.000Z';
  return {
    token: overrides.token ?? 'tok-aaaa',
    source_group: overrides.source_group ?? 'slack_sagri-ai-dev',
    chat_jid: overrides.chat_jid ?? 'slack:C0AAA1111',
    action: overrides.action ?? 'notion.write_property',
    target_ref: overrides.target_ref ?? 'a'.repeat(32),
    reversibility: overrides.reversibility ?? 'reversible',
    stakes_hint: overrides.stakes_hint ?? 'gated',
    citation_refs: overrides.citation_refs ?? '["wiki/x.md"]',
    canonical_args: overrides.canonical_args ?? '{"status":"Ready for AI"}',
    summary: overrides.summary ?? 'host-rendered summary',
    requester: overrides.requester ?? 'U_REQUESTER',
    state: overrides.state ?? 'pending',
    created_at: createdAt,
    expires_at: overrides.expires_at ?? '2026-06-23T00:00:00.000Z',
    approved_by: overrides.approved_by ?? null,
    consumed_at: overrides.consumed_at ?? null,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('pending_actions persistence', () => {
  it('creates and reads back a row by token', () => {
    createPendingAction(row({ token: 'tok-create' }));
    const got = getPendingAction('tok-create');
    expect(got).toEqual(row({ token: 'tok-create' }));
  });

  it('returns undefined for an unknown token', () => {
    expect(getPendingAction('nope')).toBeUndefined();
  });
});

describe('approve + atomic single-use consume', () => {
  it('approve transitions pending -> approved and records approver', () => {
    createPendingAction(row({ token: 'tok-app' }));
    const approved = approvePendingAction('tok-app', 'U_APPROVER');
    expect(approved).toBe(true);
    const got = getPendingAction('tok-app');
    expect(got?.state).toBe('approved');
    expect(got?.approved_by).toBe('U_APPROVER');
  });

  it('consume returns true exactly once then false on every retry', () => {
    createPendingAction(row({ token: 'tok-once' }));
    approvePendingAction('tok-once', 'U_APPROVER');
    expect(consumePendingAction('tok-once', '2026-06-22T01:00:00.000Z')).toBe(
      true,
    );
    expect(consumePendingAction('tok-once', '2026-06-22T01:00:01.000Z')).toBe(
      false,
    );
    expect(consumePendingAction('tok-once', '2026-06-22T01:00:02.000Z')).toBe(
      false,
    );
    expect(getPendingAction('tok-once')?.state).toBe('consumed');
  });

  it('consume on a non-approved row is a no-op returning false', () => {
    createPendingAction(row({ token: 'tok-pending' }));
    expect(consumePendingAction('tok-pending', '2026-06-22T01:00:00.000Z')).toBe(
      false,
    );
    expect(getPendingAction('tok-pending')?.state).toBe('pending');
  });
});

describe('terminal deny', () => {
  it('deny sets denied and approve-after-deny is a no-op', () => {
    createPendingAction(row({ token: 'tok-deny' }));
    expect(denyPendingAction('tok-deny')).toBe(true);
    expect(getPendingAction('tok-deny')?.state).toBe('denied');
    expect(approvePendingAction('tok-deny', 'U_APPROVER')).toBe(false);
    expect(getPendingAction('tok-deny')?.state).toBe('denied');
  });

  it('consume after deny is a no-op', () => {
    createPendingAction(row({ token: 'tok-deny2' }));
    denyPendingAction('tok-deny2');
    expect(consumePendingAction('tok-deny2', '2026-06-22T01:00:00.000Z')).toBe(
      false,
    );
  });
});

describe('expiry sweep', () => {
  it('expires only pending rows whose expires_at < now', () => {
    createPendingAction(
      row({ token: 'tok-old', expires_at: '2026-06-22T00:00:00.000Z' }),
    );
    createPendingAction(
      row({ token: 'tok-future', expires_at: '2026-07-01T00:00:00.000Z' }),
    );
    createPendingAction(
      row({
        token: 'tok-approved-old',
        state: 'approved',
        expires_at: '2026-06-22T00:00:00.000Z',
      }),
    );

    const count = expirePendingActions('2026-06-22T12:00:00.000Z');
    expect(count).toBe(1);
    expect(getPendingAction('tok-old')?.state).toBe('expired');
    expect(getPendingAction('tok-future')?.state).toBe('pending');
    expect(getPendingAction('tok-approved-old')?.state).toBe('approved');
  });

  it('an expired token can never be approved', () => {
    createPendingAction(
      row({ token: 'tok-exp', expires_at: '2026-06-22T00:00:00.000Z' }),
    );
    expirePendingActions('2026-06-22T12:00:00.000Z');
    expect(approvePendingAction('tok-exp', 'U_APPROVER')).toBe(false);
    expect(getPendingAction('tok-exp')?.state).toBe('expired');
  });
});

describe('boot re-drive', () => {
  it('getApprovedUnconsumed returns only approved rows', () => {
    createPendingAction(row({ token: 'tok-p' }));
    createPendingAction(row({ token: 'tok-a', state: 'approved' }));
    createPendingAction(row({ token: 'tok-c', state: 'consumed' }));
    createPendingAction(row({ token: 'tok-d', state: 'denied' }));

    const rows = getApprovedUnconsumed();
    expect(rows.map((r) => r.token)).toEqual(['tok-a']);
  });
});

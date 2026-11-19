import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _loadOrCreateKeyForTests,
  _setPendingActionMacKeyForTests,
  computeApprovalMac,
  computeRowMac,
  verifyApprovedRow,
  verifyRowMac,
} from './pending-action-mac.js';
import type { PendingActionRow } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mac-test-'));
  _setPendingActionMacKeyForTests(Buffer.alloc(32, 1));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _setPendingActionMacKeyForTests(null);
});

function row(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    token: 'tok',
    source_group: 'g',
    chat_jid: 'slack:C1',
    action: 'notion.write_property',
    target_ref: 'a'.repeat(32),
    reversibility: 'reversible',
    stakes_hint: 'gated',
    citation_refs: '[]',
    canonical_args: '{}',
    summary: 's',
    requester: '["U1"]',
    state: 'pending',
    created_at: '2026-06-22T00:00:00.000Z',
    expires_at: '2026-06-23T00:00:00.000Z',
    approved_by: null,
    consumed_at: null,
    ...overrides,
  };
}

describe('key file', () => {
  it('creates a 0600 key when absent and reuses it after', () => {
    const p = path.join(tmpDir, 'nested', 'pending-action-hmac.key');
    const k1 = _loadOrCreateKeyForTests(p);
    expect(k1.length).toBe(32);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    const k2 = _loadOrCreateKeyForTests(p);
    expect(k2.equals(k1)).toBe(true);
  });

  it('throws on a malformed key rather than running unkeyed', () => {
    const p = path.join(tmpDir, 'bad.key');
    fs.writeFileSync(p, 'not-hex');
    expect(() => _loadOrCreateKeyForTests(p)).toThrow(/malformed/);
    fs.writeFileSync(p, 'abcd');
    expect(() => _loadOrCreateKeyForTests(p)).toThrow(/malformed/);
  });
});

describe('MAC verification', () => {
  it('accepts a row sealed with the current key', () => {
    const r = row();
    const rowMac = computeRowMac(r);
    expect(verifyRowMac({ ...r, row_mac: rowMac })).toBe(true);
  });

  it.each([
    'token',
    'chat_jid',
    'action',
    'target_ref',
    'canonical_args',
    'summary',
    'requester',
    'expires_at',
  ] as const)('rejects a row whose %s changed after sealing', (field) => {
    const r = row();
    const rowMac = computeRowMac(r);
    expect(verifyRowMac({ ...r, [field]: 'x', row_mac: rowMac })).toBe(false);
  });

  it('rejects a missing MAC (legacy row)', () => {
    expect(verifyRowMac(row({ row_mac: null }))).toBe(false);
    expect(verifyRowMac(row())).toBe(false);
  });

  it('rejects a row sealed under a different key', () => {
    _setPendingActionMacKeyForTests(Buffer.alloc(32, 2));
    const r = row();
    const foreign = computeRowMac(r);
    _setPendingActionMacKeyForTests(Buffer.alloc(32, 1));
    expect(verifyRowMac({ ...r, row_mac: foreign })).toBe(false);
  });

  it('binds the approval to the approver', () => {
    const r = row();
    const rowMac = computeRowMac(r);
    const approvalMac = computeApprovalMac(r.token, rowMac, 'U_APPROVER');
    const approved = {
      ...r,
      state: 'approved' as const,
      approved_by: 'U_APPROVER',
      row_mac: rowMac,
      approval_mac: approvalMac,
    };
    expect(verifyApprovedRow(approved)).toBe(true);
    expect(verifyApprovedRow({ ...approved, approved_by: 'U_OTHER' })).toBe(
      false,
    );
    expect(verifyApprovedRow({ ...approved, approval_mac: null })).toBe(false);
  });
});

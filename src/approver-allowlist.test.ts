import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isApprover, loadApproverAllowlist } from './approver-allowlist.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approver-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(content: string): string {
  const p = path.join(dir, 'approver-allowlist.json');
  fs.writeFileSync(p, content);
  return p;
}

describe('loadApproverAllowlist — fail-CLOSED', () => {
  it('returns an empty set on ENOENT (deny-all)', () => {
    const set = loadApproverAllowlist(path.join(dir, 'missing.json'));
    expect(set.size).toBe(0);
  });

  it('returns an empty set on invalid JSON (deny-all)', () => {
    const set = loadApproverAllowlist(write('{not json'));
    expect(set.size).toBe(0);
  });

  it('returns an empty set when approvers is not an array', () => {
    const set = loadApproverAllowlist(write('{"approvers": "U1"}'));
    expect(set.size).toBe(0);
  });

  it('returns an empty set when the schema is wrong', () => {
    const set = loadApproverAllowlist(write('[]'));
    expect(set.size).toBe(0);
  });

  it('loads a valid approver list', () => {
    const set = loadApproverAllowlist(
      write('{"approvers": ["U_ALICE", "U_BOB"]}'),
    );
    expect(set).toEqual(new Set(['U_ALICE', 'U_BOB']));
  });

  it('drops non-string entries rather than failing the whole load', () => {
    const set = loadApproverAllowlist(
      write('{"approvers": ["U_ALICE", 42, "U_BOB"]}'),
    );
    expect(set).toEqual(new Set(['U_ALICE', 'U_BOB']));
  });
});

describe('isApprover', () => {
  it('is false for everyone against an empty set', () => {
    expect(isApprover('U_ALICE', new Set())).toBe(false);
  });

  it('is true only for members', () => {
    const set = new Set(['U_ALICE']);
    expect(isApprover('U_ALICE', set)).toBe(true);
    expect(isApprover('U_BOB', set)).toBe(false);
  });
});

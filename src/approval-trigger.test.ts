import { describe, it, expect } from 'vitest';

import { parseApprovalIntent } from './approval-trigger.js';

const TOKEN = 'A'.repeat(43);

describe('parseApprovalIntent', () => {
  it('parses a whole-message approve <token>', () => {
    expect(parseApprovalIntent(`approve ${TOKEN}`)).toEqual({
      kind: 'approve',
      token: TOKEN,
    });
  });

  it('parses a whole-message reject <token>', () => {
    expect(parseApprovalIntent(`reject ${TOKEN}`)).toEqual({
      kind: 'reject',
      token: TOKEN,
    });
  });

  it('is case-insensitive on the verb only', () => {
    expect(parseApprovalIntent(`APPROVE ${TOKEN}`)).toEqual({
      kind: 'approve',
      token: TOKEN,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseApprovalIntent(`  approve ${TOKEN}  `)).toEqual({
      kind: 'approve',
      token: TOKEN,
    });
  });

  it('rejects a human quoting the prompt prose', () => {
    expect(
      parseApprovalIntent(`I think we should approve ${TOKEN} now`),
    ).toBeNull();
    expect(parseApprovalIntent(`approve ${TOKEN} please`)).toBeNull();
  });

  it('rejects a malformed token length', () => {
    expect(parseApprovalIntent('approve short')).toBeNull();
    expect(parseApprovalIntent(`approve ${'A'.repeat(42)}`)).toBeNull();
    expect(parseApprovalIntent(`approve ${'A'.repeat(44)}`)).toBeNull();
  });

  it('rejects a token with a non-base64url character', () => {
    expect(parseApprovalIntent(`approve ${'A'.repeat(42)}!`)).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(parseApprovalIntent('hello there')).toBeNull();
    expect(parseApprovalIntent('')).toBeNull();
  });
});

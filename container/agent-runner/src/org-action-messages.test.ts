import { describe, it, expect } from 'vitest';

import { ORG_ACTION_SUBMITTED_MESSAGE } from './org-action-messages.js';

describe('org_action submitted message', () => {
  it('is neutral and never asserts the action is held', () => {
    expect(ORG_ACTION_SUBMITTED_MESSAGE).not.toMatch(/held pending approval —/);
    expect(ORG_ACTION_SUBMITTED_MESSAGE.startsWith('submitted')).toBe(true);
  });

  it('conditions the do-not-proceed instruction on being notified of a hold', () => {
    expect(ORG_ACTION_SUBMITTED_MESSAGE).toContain(
      'If you are notified that it is held pending approval, do not proceed with dependent work',
    );
  });

  it('tells the agent the host executes or reports asynchronously', () => {
    expect(ORG_ACTION_SUBMITTED_MESSAGE).toContain(
      'The host will execute it (or report the result) asynchronously',
    );
  });
});

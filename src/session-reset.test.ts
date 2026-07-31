import { describe, it, expect, beforeEach } from 'vitest';

import {
  _clearSessionResets,
  requestSessionReset,
  takeSessionReset,
} from './session-reset.js';

beforeEach(() => {
  _clearSessionResets();
});

describe('deferred session resets (sagri-ai#629)', () => {
  it('owes nothing for a group nobody asked about', () => {
    expect(takeSessionReset('dev')).toBe(false);
  });

  it('owes the reset once, then stops owing it', () => {
    requestSessionReset('dev');
    expect(takeSessionReset('dev')).toBe(true);
    expect(takeSessionReset('dev')).toBe(false);
  });

  it('leaves other groups alone when one is taken', () => {
    // Groups run concurrently in their own queue lanes. Taking dev's reset on
    // ops's launch would drop dev's session mid-run, and dev's own write-back
    // would then restore the session while the slot stayed cleared, which is the
    // state that refuses every gated action with no way out.
    requestSessionReset('dev');
    requestSessionReset('ops');

    expect(takeSessionReset('ops')).toBe(true);
    expect(takeSessionReset('dev')).toBe(true);
  });

  it('collapses repeat requests for the same group', () => {
    requestSessionReset('dev');
    requestSessionReset('dev');
    expect(takeSessionReset('dev')).toBe(true);
    expect(takeSessionReset('dev')).toBe(false);
  });
});

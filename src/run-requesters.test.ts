import { describe, it, expect, beforeEach } from 'vitest';

import {
  addRunRequesters,
  _clearAllRunRequesters,
  clearRunRequestersForGroup,
  getRunRequesters,
  setRunRequesters,
} from './run-requesters.js';

// The launch scopes these tests use. Both reasons to widen can hold at once and
// are handled identically, which BOTH pins.
const FRESH = { hasUndrainedRequests: false, resumesSession: false };
const RESUMED = { hasUndrainedRequests: false, resumesSession: true };
const UNDRAINED = { hasUndrainedRequests: true, resumesSession: false };
const BOTH = { hasUndrainedRequests: true, resumesSession: true };

beforeEach(() => {
  _clearAllRunRequesters();
});

describe('run requester attribution', () => {
  it('distinguishes an unrecorded group from a run with no human requester', () => {
    setRunRequesters('scheduled', [], FRESH);
    expect(getRunRequesters('scheduled')).toStrictEqual([]);
    expect(getRunRequesters('never-ran')).toBeUndefined();
  });

  it('replaces the previous attribution when the run resumes nothing', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], FRESH);
    expect(getRunRequesters('dev')).toStrictEqual(['U_ALICE']);
  });

  it('unions the previous attribution while a request is still undrained', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], UNDRAINED);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('keeps the asker of a resumed instruction on record (sagri-ai#629)', () => {
    // Carol asks in run N and it raises nothing. Run N+1 launches for somebody
    // else's message, resuming the session that still holds Carol's ask. A
    // replace here is the bypass: the org_action would record only U_DAVE and
    // leave Carol free to approve her own request.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_DAVE'], RESUMED);
    expect(getRunRequesters('dev')).toStrictEqual(['U_CAROL', 'U_DAVE']);
  });

  it('drops the resumed askers once the session is not resumed', () => {
    // The bound on the rule above: the session expired, so the next run starts
    // fresh context and a fresh set. Without this the set would grow to every
    // human in the channel and no approver would ever be clear of the request.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_DAVE'], RESUMED);
    setRunRequesters('dev', ['U_ERIN'], FRESH);
    expect(getRunRequesters('dev')).toStrictEqual(['U_ERIN']);
  });

  it('widens once, not twice, when both reasons to widen hold', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], BOTH);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('clears the attribution for a run whose context it cannot enumerate', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', undefined, FRESH);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('clears even while a request is undrained, rather than handing it to this run', () => {
    // Mid-drain version of the rule above (see run-requesters.ts).
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', undefined, UNDRAINED);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('never lets an isolated task empty set survive into an unattributable run', () => {
    // `[]` excludes nobody, which is worse to inherit than a real set.
    setRunRequesters('dev', [], FRESH);
    setRunRequesters('dev', undefined, UNDRAINED);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('declines to attribute an undrained request to the run that follows it', () => {
    // Post-restart: a request is pending but nothing is on record. Naming this
    // run's senders would blame them for somebody else's request and clear the
    // real requester to approve it.
    setRunRequesters('dev', ['U_ALICE'], UNDRAINED);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('declines to attribute a resumed session with nothing on record', () => {
    // Post-restart with a session still in the DB: the agent resumes context the
    // host can no longer enumerate, so no approver can be cleared of it.
    setRunRequesters('dev', ['U_ALICE'], RESUMED);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('keeps a scheduled run from clearing an undrained run requesters', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', [], UNDRAINED);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB']);
  });

  it('keeps an isolated task from trimming a live session to nobody', () => {
    // An isolated task shares the group folder but not the session the slot was
    // filled from. Replacing on its `[]` would clear U_BOB and let him approve.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', [], FRESH);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB']);
  });

  it('adds the senders of a batch piped into a running container', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    addRunRequesters('dev', ['U_ALICE', 'U_BOB']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('does not invent an attribution for a group that has none', () => {
    addRunRequesters('never-ran', ['U_ALICE']);
    expect(getRunRequesters('never-ran')).toBeUndefined();
  });

  it('drops the slot when the group session expires', () => {
    // See clearRunRequestersForGroup's docstring for why a dead slot has to go.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    clearRunRequestersForGroup('dev');
    expect(getRunRequesters('dev')).toBeUndefined();

    setRunRequesters('dev', [], FRESH);
    expect(getRunRequesters('dev')).toStrictEqual([]);
  });
});

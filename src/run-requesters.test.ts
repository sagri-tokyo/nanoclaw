import { describe, it, expect, beforeEach } from 'vitest';

import { _clearSessionResets, takeSessionReset } from './session-reset.js';
import {
  addRunRequesters,
  _clearAllRunRequesters,
  clearRequestPin,
  clearRunRequestersForGroup,
  getRunRequesters,
  retainRequestPins,
  setRunRequesters,
} from './run-requesters.js';

const FRESH = { resumesSession: false, undrainedRequests: [] };
const RESUMED = { resumesSession: true, undrainedRequests: [] };

/** A launch that finds `files` undrained, so it pins them before claiming. */
function pinning(files: string[], scope = FRESH) {
  return { ...scope, undrainedRequests: files };
}

/**
 * The group's live slot, read the way production reads it: an unpinned request
 * falls through to the slot. Asserting through the real entry point keeps that
 * branch under test and the module free of a group-wide reader a caller could
 * reach for instead (sagri-ai#630).
 */
function slotOf(groupFolder: string): string[] | undefined {
  return getRunRequesters(groupFolder, 'never-pinned.json');
}

beforeEach(() => {
  _clearAllRunRequesters();
  _clearSessionResets();
});

describe('run requester attribution', () => {
  it('distinguishes an unrecorded group from a run with no human requester', () => {
    setRunRequesters('scheduled', [], FRESH);
    expect(slotOf('scheduled')).toStrictEqual([]);
    expect(slotOf('never-ran')).toBeUndefined();
  });

  it('replaces the previous attribution when the run resumes nothing', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], FRESH);
    expect(slotOf('dev')).toStrictEqual(['U_ALICE']);
  });

  it('keeps the asker of a resumed instruction on record (sagri-ai#629)', () => {
    // Carol asks in run N and it raises nothing. Run N+1 launches for somebody
    // else's message, resuming the session that still holds Carol's ask. A
    // replace here is the bypass: the org_action would record only U_DAVE and
    // leave Carol free to approve her own request.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_DAVE'], RESUMED);
    expect(slotOf('dev')).toStrictEqual(['U_CAROL', 'U_DAVE']);
  });

  it('drops the resumed askers once the session is not resumed', () => {
    // The bound on the rule above: the session expired, so the next run starts
    // fresh context and a fresh set. Without this the set would grow to every
    // human in the channel and no approver would ever be clear of the request.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_DAVE'], RESUMED);
    setRunRequesters('dev', ['U_ERIN'], FRESH);
    expect(slotOf('dev')).toStrictEqual(['U_ERIN']);
  });

  it('clears the attribution for a run whose context it cannot enumerate', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', undefined, FRESH);
    expect(slotOf('dev')).toBeUndefined();
  });

  it('never lets an isolated task empty set survive into an unattributable run', () => {
    // `[]` excludes nobody, which is worse to inherit than a real set.
    setRunRequesters('dev', [], FRESH);
    setRunRequesters('dev', undefined, FRESH);
    expect(slotOf('dev')).toBeUndefined();
  });

  it('asks for a session reset when it declines, so the next launch recovers', () => {
    // Otherwise this is permanent: the run still writes its session id back, so
    // every later launch resumes and declines again, addRunRequesters refuses to
    // create a slot, and the gate's unattributed refusal returns before the
    // branch that would reset. The group refuses every gated action until the
    // process restarts.
    setRunRequesters('dev', ['U_BOB'], RESUMED);
    expect(slotOf('dev')).toBeUndefined();
    expect(takeSessionReset('dev')).toBe(true);

    // With the session dropped, the next launch resumes nothing and claims it.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    expect(slotOf('dev')).toStrictEqual(['U_CAROL']);
  });

  it('declines to attribute a resumed session with nothing on record', () => {
    // Post-restart with a session still in the DB: the agent resumes context the
    // host can no longer enumerate, so no approver can be cleared of it.
    setRunRequesters('dev', ['U_ALICE'], RESUMED);
    expect(slotOf('dev')).toBeUndefined();
  });

  it('keeps an isolated task from trimming a live session to nobody', () => {
    // An isolated task shares the group folder but not the session the slot was
    // filled from. Replacing on its `[]` would clear U_BOB and let him approve.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', [], FRESH);
    expect(slotOf('dev')).toStrictEqual(['U_BOB']);
  });

  it('adds the senders of a batch piped into a running container', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    addRunRequesters('dev', ['U_ALICE', 'U_BOB']);
    expect(slotOf('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('does not invent an attribution for a group that has none', () => {
    addRunRequesters('never-ran', ['U_ALICE']);
    expect(slotOf('never-ran')).toBeUndefined();
  });

  it('drops the slot when the group session expires', () => {
    // See clearRunRequestersForGroup's docstring for why a dead slot has to go.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    clearRunRequestersForGroup('dev');
    expect(slotOf('dev')).toBeUndefined();

    setRunRequesters('dev', [], FRESH);
    expect(slotOf('dev')).toStrictEqual([]);
  });
});

describe('per-request requester correlation (sagri-ai#630)', () => {
  it('answers a request with the run that raised it, not the run draining beside it', () => {
    // Bob's run writes the request and exits. Alice's run launches before the
    // 1s drain picks the file up. Without the pin the request would name Alice,
    // and Bob, who actually asked, would be free to approve it.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(slotOf('dev')).toStrictEqual(['U_ALICE']);
  });

  it('leaves an uninvolved approver eligible on an unrelated overlapping run', () => {
    // The other half of the same story: Alice never touched Bob's request, so
    // she must not appear in its requester set at all.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json'], RESUMED));

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
  });

  it('holds the pin through a launch that cannot enumerate its own context', () => {
    // A session-resuming scheduled task clears the slot. The pending request
    // used to refuse along with it; it now still answers the run that raised it.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', undefined, pinning(['req-1.json']));

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(slotOf('dev')).toBeUndefined();
  });

  it('keeps the first pin, which is the launch closest to the writing run', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    setRunRequesters('dev', ['U_ERIN'], pinning(['req-1.json']));

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
  });

  it('refuses a request that outlived the process rather than blaming the next run', () => {
    // Restart: the slot is empty, so the pin records `undefined` (see the module
    // docstring) and the request refuses instead of naming whoever runs next.
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-stale.json']));

    expect(getRunRequesters('dev', 'req-stale.json')).toBeUndefined();
    expect(slotOf('dev')).toStrictEqual(['U_ALICE']);
  });

  it('reads the live slot for a request written by the run now going', () => {
    // The ordinary case: the container wrote the file during this run, so no
    // launch has pinned it and the slot is the right answer.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    expect(getRunRequesters('dev', 'req-live.json')).toStrictEqual(['U_BOB']);
  });

  it('keeps pins for one group out of another group with the same file name', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('ops', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    setRunRequesters('ops', ['U_ERIN'], pinning(['req-1.json']));

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('ops', 'req-1.json')).toStrictEqual(['U_CAROL']);
  });

  it('forgets the pin once the drain has removed the file', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    clearRequestPin('dev', 'req-1.json');

    // A container that reuses the name gets this run's slot, not the dead pin.
    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_ALICE']);
  });

  it('survives the session drop, because the request is still answering its askers', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    clearRunRequestersForGroup('dev');

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(slotOf('dev')).toBeUndefined();
  });

  it('hands out a copy, so a caller cannot rewrite the pin for every later read', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));

    getRunRequesters('dev', 'req-1.json')!.push('U_MALLORY');

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
  });

  it('drops the pin of a request the container deleted before the drain read it', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    retainRequestPins('dev', []);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_ALICE']);
  });

  it('drops an `undefined` pin too, which is a value and not an absence', () => {
    // The refusing pin is stored as `undefined` and found with `has`, so a sweep
    // written against truthiness would leave exactly this one immortal. Dropping
    // it is safe because the file it refused for is gone: a later file reusing
    // the name is a different request, and answers the slot it was raised under.
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-stale.json']));
    expect(getRunRequesters('dev', 'req-stale.json')).toBeUndefined();

    retainRequestPins('dev', []);

    expect(getRunRequesters('dev', 'req-stale.json')).toStrictEqual([
      'U_ALICE',
    ]);
  });

  it('keeps the pins of requests still sitting in the directory', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json', 'req-2.json']));
    retainRequestPins('dev', ['req-1.json']);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('dev', 'req-2.json')).toStrictEqual(['U_ALICE']);
  });

  it('leaves the pins of another group alone', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('ops', ['U_CAROL'], FRESH);
    setRunRequesters('dev', ['U_ALICE'], pinning(['req-1.json']));
    setRunRequesters('ops', ['U_ERIN'], pinning(['req-1.json']));

    retainRequestPins('dev', []);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_ALICE']);
    expect(getRunRequesters('ops', 'req-1.json')).toStrictEqual(['U_CAROL']);
  });
});

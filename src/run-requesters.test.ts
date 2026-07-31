import { describe, it, expect, beforeEach } from 'vitest';

import { _clearSessionResets, takeSessionReset } from './session-reset.js';
import {
  addRunRequesters,
  _clearAllRunRequesters,
  clearRequestSnapshot,
  clearRunRequestersForGroup,
  getRunRequesters,
  setRunRequesters,
  snapshotPendingRequests,
} from './run-requesters.js';

const FRESH = { resumesSession: false };
const RESUMED = { resumesSession: true };

beforeEach(() => {
  _clearAllRunRequesters();
  _clearSessionResets();
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

  it('clears the attribution for a run whose context it cannot enumerate', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    setRunRequesters('dev', undefined, FRESH);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('never lets an isolated task empty set survive into an unattributable run', () => {
    // `[]` excludes nobody, which is worse to inherit than a real set.
    setRunRequesters('dev', [], FRESH);
    setRunRequesters('dev', undefined, FRESH);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('asks for a session reset when it declines, so the next launch recovers', () => {
    // Otherwise this is permanent: the run still writes its session id back, so
    // every later launch resumes and declines again, addRunRequesters refuses to
    // create a slot, and the gate's unattributed refusal returns before the
    // branch that would reset. The group refuses every gated action until the
    // process restarts.
    setRunRequesters('dev', ['U_BOB'], RESUMED);
    expect(getRunRequesters('dev')).toBeUndefined();
    expect(takeSessionReset('dev')).toBe(true);

    // With the session dropped, the next launch resumes nothing and claims it.
    setRunRequesters('dev', ['U_CAROL'], FRESH);
    expect(getRunRequesters('dev')).toStrictEqual(['U_CAROL']);
  });

  it('declines to attribute a resumed session with nothing on record', () => {
    // Post-restart with a session still in the DB: the agent resumes context the
    // host can no longer enumerate, so no approver can be cleared of it.
    setRunRequesters('dev', ['U_ALICE'], RESUMED);
    expect(getRunRequesters('dev')).toBeUndefined();
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

describe('per-request requester correlation (sagri-ai#630)', () => {
  it('answers a request with the run that raised it, not the run draining beside it', () => {
    // Bob's run writes the request and exits. Alice's run launches before the
    // 1s drain picks the file up. Without the pin the request would name Alice,
    // and Bob, who actually asked, would be free to approve it.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    setRunRequesters('dev', ['U_ALICE'], FRESH);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_ALICE']);
  });

  it('leaves an uninvolved approver eligible on an unrelated overlapping run', () => {
    // The other half of the same story: Alice never touched Bob's request, so
    // she must not appear in its requester set at all.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    setRunRequesters('dev', ['U_ALICE'], RESUMED);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
  });

  it('holds the pin through a launch that cannot enumerate its own context', () => {
    // A session-resuming scheduled task clears the slot. The pending request
    // used to refuse along with it; it now still answers the run that raised it.
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    setRunRequesters('dev', undefined, FRESH);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('keeps the first pin, which is the launch closest to the writing run', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    setRunRequesters('dev', ['U_ALICE'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
  });

  it('refuses a request that outlived the process rather than blaming the next run', () => {
    // After a restart the slot is empty, so the pin records `undefined`. Handing
    // the file to the next run's senders would both blame people who never asked
    // and clear whoever did ask to approve their own request.
    snapshotPendingRequests('dev', ['req-stale.json']);
    setRunRequesters('dev', ['U_ALICE'], FRESH);

    expect(getRunRequesters('dev', 'req-stale.json')).toBeUndefined();
    expect(getRunRequesters('dev')).toStrictEqual(['U_ALICE']);
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
    snapshotPendingRequests('dev', ['req-1.json']);
    snapshotPendingRequests('ops', ['req-1.json']);
    setRunRequesters('dev', ['U_ALICE'], FRESH);

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('ops', 'req-1.json')).toStrictEqual(['U_CAROL']);
  });

  it('forgets the pin once the drain has removed the file', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    setRunRequesters('dev', ['U_ALICE'], FRESH);
    clearRequestSnapshot('dev', 'req-1.json');

    // A container that reuses the name gets this run's slot, not the dead pin.
    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_ALICE']);
  });

  it('survives the session drop, because the request is still answering its askers', () => {
    setRunRequesters('dev', ['U_BOB'], FRESH);
    snapshotPendingRequests('dev', ['req-1.json']);
    clearRunRequestersForGroup('dev');

    expect(getRunRequesters('dev', 'req-1.json')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('dev')).toBeUndefined();
  });
});

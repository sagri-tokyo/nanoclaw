import { describe, it, expect, beforeEach } from 'vitest';

import {
  addRunRequesters,
  clearRunRequesters,
  getRunRequesters,
  setRunRequesters,
} from './run-requesters.js';

beforeEach(() => {
  clearRunRequesters();
});

describe('run requester attribution', () => {
  it('distinguishes an unrecorded group from a run with no human requester', () => {
    setRunRequesters('scheduled', [], false);
    expect(getRunRequesters('scheduled')).toStrictEqual([]);
    expect(getRunRequesters('never-ran')).toBeUndefined();
  });

  it('replaces the previous attribution when nothing is left undrained', () => {
    setRunRequesters('dev', ['U_BOB'], false);
    setRunRequesters('dev', ['U_ALICE'], false);
    expect(getRunRequesters('dev')).toStrictEqual(['U_ALICE']);
  });

  it('unions the previous attribution while a request is still undrained', () => {
    setRunRequesters('dev', ['U_BOB'], false);
    setRunRequesters('dev', ['U_ALICE'], true);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('clears the attribution for a run whose context it cannot enumerate', () => {
    // A group-context scheduled task resumes the humans' session, so `[]` would
    // claim nobody is in context when somebody is.
    setRunRequesters('dev', ['U_BOB'], false);
    setRunRequesters('dev', undefined, false);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('declines to attribute an undrained request to the run that follows it', () => {
    // Post-restart: a request is pending but nothing is on record. Naming this
    // run's senders would blame them for somebody else's request and clear the
    // real requester to approve it.
    setRunRequesters('dev', ['U_ALICE'], true);
    expect(getRunRequesters('dev')).toBeUndefined();
  });

  it('keeps a scheduled run from clearing an undrained run requesters', () => {
    setRunRequesters('dev', ['U_BOB'], false);
    setRunRequesters('dev', [], true);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB']);
  });

  it('adds the senders of a batch piped into a running container', () => {
    setRunRequesters('dev', ['U_BOB'], false);
    addRunRequesters('dev', ['U_ALICE', 'U_BOB']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('does not invent an attribution for a group that has none', () => {
    addRunRequesters('never-ran', ['U_ALICE']);
    expect(getRunRequesters('never-ran')).toBeUndefined();
  });
});

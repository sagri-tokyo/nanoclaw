import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearRunRequesters,
  getRunRequesters,
  setRunRequesters,
} from './run-requesters.js';

beforeEach(() => {
  clearRunRequesters();
});

describe('run requester attribution', () => {
  it('reads back the ids recorded for a group folder', () => {
    setRunRequesters('dev', ['U_BOB', 'U_ALICE']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB', 'U_ALICE']);
  });

  it('keeps each group folder separate', () => {
    setRunRequesters('dev', ['U_BOB']);
    setRunRequesters('ops', ['U_ALICE']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_BOB']);
    expect(getRunRequesters('ops')).toStrictEqual(['U_ALICE']);
  });

  it('replaces the previous run attribution rather than accumulating it', () => {
    setRunRequesters('dev', ['U_BOB']);
    setRunRequesters('dev', ['U_ALICE']);
    expect(getRunRequesters('dev')).toStrictEqual(['U_ALICE']);
  });

  it('is empty for a group that has not run', () => {
    expect(getRunRequesters('never-ran')).toStrictEqual([]);
  });
});

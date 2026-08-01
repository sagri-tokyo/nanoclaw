import { describe, expect, it } from 'vitest';

import type { ContainerOutput } from './container-runner.js';
import { createSessionTracker } from './session-tracker.js';

describe('createSessionTracker', () => {
  function tracker(resumedSessionId: string | undefined) {
    const calls: Array<{ remembered: string } | { forgotten: string }> = [];
    const track = createSessionTracker(
      'main',
      resumedSessionId,
      {
        remember: (_folder, sessionId) => calls.push({ remembered: sessionId }),
        forget: (folder) => calls.push({ forgotten: folder }),
      },
      {},
    );
    return { calls, track };
  }

  const staleResume: ContainerOutput = {
    status: 'error',
    result: null,
    error: 'No conversation found with session ID: session-abc',
  };

  it('records the session a run establishes', () => {
    const { calls, track } = tracker(undefined);
    track({ status: 'success', result: null, newSessionId: 'session-abc' });
    expect(calls).toEqual([{ remembered: 'session-abc' }]);
  });

  it('drops the session a run could not resume', () => {
    const { calls, track } = tracker('session-abc');
    track(staleResume);
    expect(calls).toEqual([{ forgotten: 'main' }]);
  });

  it('ignores the dropped id echoed back by the markers that follow', () => {
    const { calls, track } = tracker('session-abc');
    track(staleResume);
    track({ status: 'success', result: null, newSessionId: 'session-abc' });
    expect(calls).toEqual([{ forgotten: 'main' }]);
  });

  it('records a genuinely new session established after a drop', () => {
    const { calls, track } = tracker('session-abc');
    track(staleResume);
    track({ status: 'success', result: null, newSessionId: 'session-xyz' });
    expect(calls).toEqual([
      { forgotten: 'main' },
      { remembered: 'session-xyz' },
    ]);
  });

  it('leaves the session alone on a failure unrelated to resuming', () => {
    const { calls, track } = tracker('session-abc');
    track({
      status: 'error',
      result: null,
      error: 'Anthropic Overloaded (HttpStatus529) after 6 retries',
    });
    expect(calls).toEqual([]);
  });

  it('drops nothing when the run was not resuming a session', () => {
    const { calls, track } = tracker(undefined);
    track(staleResume);
    expect(calls).toEqual([]);
  });
});

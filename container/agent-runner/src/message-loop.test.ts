import { describe, it, expect, vi } from 'vitest';
import {
  processSdkMessages,
  type ContainerOutput,
  type MinimalSdkMessage,
} from './message-loop.js';
import { RetryBudget } from './retry-budget.js';

function fakeInitMessage(sessionId: string): MinimalSdkMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

function fakeRetryMessage(errorStatus: number | null): MinimalSdkMessage {
  return { type: 'system', subtype: 'api_retry', error_status: errorStatus };
}

function fakeSuccessResult(text: string): MinimalSdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
  };
}

async function* messageStream(
  messages: MinimalSdkMessage[],
): AsyncGenerator<MinimalSdkMessage> {
  for (const m of messages) {
    yield m;
  }
}

describe('processSdkMessages', () => {
  it('classifies a normal success result and forwards it via writeOutput', async () => {
    const writes: ContainerOutput[] = [];
    const abortController = new AbortController();
    const start = Date.now();

    const state = await processSdkMessages({
      iterable: messageStream([
        fakeInitMessage('session-abc'),
        fakeSuccessResult('all good'),
      ]),
      budget: new RetryBudget(5),
      abortController,
      writeOutput: (output) => writes.push(output),
    });

    expect(writes).toEqual([
      { status: 'success', result: 'all good', newSessionId: 'session-abc' },
    ]);
    expect(state.newSessionId).toEqual('session-abc');
    expect(state.budgetExceeded).toEqual(false);
    expect(abortController.signal.aborted).toEqual(false);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('aborts and surfaces a structured 529 error once the retry budget is exceeded', async () => {
    const writes: ContainerOutput[] = [];
    const abortController = new AbortController();
    const start = Date.now();

    const state = await processSdkMessages({
      iterable: messageStream([
        fakeInitMessage('session-overloaded'),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
      ]),
      budget: new RetryBudget(5),
      abortController,
      writeOutput: (output) => writes.push(output),
    });

    expect(writes).toEqual([
      {
        status: 'error',
        result: null,
        error: 'Anthropic Overloaded (HttpStatus529) after 6 retries',
        error_class: 'HttpStatus529',
        newSessionId: 'session-overloaded',
      },
    ]);
    expect(state.budgetExceeded).toEqual(true);
    expect(abortController.signal.aborted).toEqual(true);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('does not abort on non-529 api_retry events', async () => {
    const writes: ContainerOutput[] = [];
    const abortController = new AbortController();

    await processSdkMessages({
      iterable: messageStream([
        fakeInitMessage('session-rate-limited'),
        fakeRetryMessage(429),
        fakeRetryMessage(503),
        fakeRetryMessage(529),
        fakeSuccessResult('eventually fine'),
      ]),
      budget: new RetryBudget(5),
      abortController,
      writeOutput: (output) => writes.push(output),
    });

    expect(writes).toEqual([
      {
        status: 'success',
        result: 'eventually fine',
        newSessionId: 'session-rate-limited',
      },
    ]);
    expect(abortController.signal.aborted).toEqual(false);
  });

  it('forwards a logger error when one is provided for the 529 path', async () => {
    const logs: string[] = [];
    const abortController = new AbortController();

    await processSdkMessages({
      iterable: messageStream([
        fakeInitMessage('session-log'),
        fakeRetryMessage(529),
        fakeRetryMessage(529),
      ]),
      budget: new RetryBudget(1),
      abortController,
      writeOutput: () => {},
      log: (msg) => logs.push(msg),
    });

    expect(
      logs.some((l) => l.includes('Anthropic Overloaded') && l.includes('2')),
    ).toEqual(true);
  });
});

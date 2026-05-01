import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Sagri-AI',
}));

import { parseAbortIntent } from './abort-trigger.js';

describe('parseAbortIntent — slash command', () => {
  it('returns abort for /stop in a channel', () => {
    expect(parseAbortIntent('/stop', false)).toEqual({ intent: 'abort' });
  });

  it('returns abort for /stop in a DM', () => {
    expect(parseAbortIntent('/stop', true)).toEqual({ intent: 'abort' });
  });

  it('returns abort for /cancel and /abort in any channel type', () => {
    expect(parseAbortIntent('/cancel', false)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('/abort', false)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('/cancel', true)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('/abort', true)).toEqual({ intent: 'abort' });
  });

  it('is case-insensitive on the slash verb', () => {
    expect(parseAbortIntent('/STOP', false)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('/Cancel', false)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('/Abort', true)).toEqual({ intent: 'abort' });
  });

  it('ignores surrounding whitespace on the slash command', () => {
    expect(parseAbortIntent('  /stop  ', false)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('\t/abort\n', true)).toEqual({ intent: 'abort' });
  });

  it('rejects /stop with trailing tokens', () => {
    expect(parseAbortIntent('/stop the agent', false)).toBeNull();
    expect(parseAbortIntent('/stop please', true)).toBeNull();
  });

  it('rejects unrelated slash commands', () => {
    expect(parseAbortIntent('/help', false)).toBeNull();
    expect(parseAbortIntent('/clear', true)).toBeNull();
  });
});

describe('parseAbortIntent — mention prefix in groups', () => {
  it('returns abort for @Sagri-AI stop in a channel', () => {
    expect(parseAbortIntent('@Sagri-AI stop', false)).toEqual({
      intent: 'abort',
    });
  });

  it('returns abort for @Sagri-AI cancel and @Sagri-AI abort', () => {
    expect(parseAbortIntent('@Sagri-AI cancel', false)).toEqual({
      intent: 'abort',
    });
    expect(parseAbortIntent('@Sagri-AI abort', false)).toEqual({
      intent: 'abort',
    });
  });

  it('is case-insensitive on the verb and the assistant name', () => {
    expect(parseAbortIntent('@Sagri-AI Stop', false)).toEqual({
      intent: 'abort',
    });
    expect(parseAbortIntent('@SAGRI-AI ABORT', false)).toEqual({
      intent: 'abort',
    });
    expect(parseAbortIntent('@sagri-ai cancel', false)).toEqual({
      intent: 'abort',
    });
  });

  it('rejects bare verb in a group (no mention)', () => {
    expect(parseAbortIntent('stop', false)).toBeNull();
    expect(parseAbortIntent('cancel', false)).toBeNull();
    expect(parseAbortIntent('abort', false)).toBeNull();
  });

  it('rejects @Sagri-AI followed by an unrelated verb', () => {
    expect(parseAbortIntent('@Sagri-AI hello', false)).toBeNull();
    expect(parseAbortIntent('@Sagri-AI please', false)).toBeNull();
  });

  it('rejects @Sagri-AI followed by an embedded verb', () => {
    expect(parseAbortIntent('@Sagri-AI please stop', false)).toBeNull();
    expect(
      parseAbortIntent('@Sagri-AI please stop ignoring me', false),
    ).toBeNull();
    expect(parseAbortIntent('@Sagri-AI aborted yesterday', false)).toBeNull();
  });

  it('rejects mention of a different assistant name', () => {
    expect(parseAbortIntent('@SomeoneElse stop', false)).toBeNull();
  });

  it('also accepts the mention prefix in a DM', () => {
    expect(parseAbortIntent('@Sagri-AI stop', true)).toEqual({
      intent: 'abort',
    });
  });

  it('ignores surrounding whitespace on the mention form', () => {
    expect(parseAbortIntent('  @Sagri-AI stop  ', false)).toEqual({
      intent: 'abort',
    });
    expect(parseAbortIntent('@Sagri-AI   stop', false)).toEqual({
      intent: 'abort',
    });
  });
});

describe('parseAbortIntent — bare verb in DMs', () => {
  it('returns abort for bare stop in a DM', () => {
    expect(parseAbortIntent('stop', true)).toEqual({ intent: 'abort' });
  });

  it('returns abort for bare cancel and abort in a DM', () => {
    expect(parseAbortIntent('cancel', true)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('abort', true)).toEqual({ intent: 'abort' });
  });

  it('is case-insensitive on the bare verb', () => {
    expect(parseAbortIntent('STOP', true)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('Cancel', true)).toEqual({ intent: 'abort' });
  });

  it('ignores surrounding whitespace on the bare verb', () => {
    expect(parseAbortIntent('  stop  ', true)).toEqual({ intent: 'abort' });
    expect(parseAbortIntent('\tabort\n', true)).toEqual({ intent: 'abort' });
  });

  it('rejects substring matches that are not the whole message', () => {
    expect(parseAbortIntent('please stop ignoring me', true)).toBeNull();
    expect(parseAbortIntent('stop pretending', true)).toBeNull();
    expect(parseAbortIntent('aborted yesterday', true)).toBeNull();
    expect(parseAbortIntent('cancellation policy', true)).toBeNull();
  });
});

describe('parseAbortIntent — empty / non-trigger inputs', () => {
  it('returns null for empty and whitespace-only input', () => {
    expect(parseAbortIntent('', false)).toBeNull();
    expect(parseAbortIntent('   ', true)).toBeNull();
    expect(parseAbortIntent('\n\t', false)).toBeNull();
  });

  it('returns null for ordinary chat content in a channel', () => {
    expect(parseAbortIntent('hello world', false)).toBeNull();
    expect(parseAbortIntent('what is the weather', false)).toBeNull();
  });

  it('returns null for ordinary chat content in a DM', () => {
    expect(parseAbortIntent('hello world', true)).toBeNull();
    expect(parseAbortIntent('what is the weather', true)).toBeNull();
  });
});

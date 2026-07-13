import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { connectChannel } from './channel-startup.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

function fakeChannel(connect: () => Promise<void>, name = 'fake'): Channel {
  return {
    name,
    connect,
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
  };
}

describe('connectChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the channel in the active set on success', async () => {
    const channels: Channel[] = [];
    const channel = fakeChannel(async () => {});

    await connectChannel(channel, 'fake', channels);

    expect(channels).toEqual([channel]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('makes the channel routable during connect(), before it resolves', async () => {
    const channels: Channel[] = [];
    let visibleDuringConnect = false;
    const channel = fakeChannel(async () => {
      visibleDuringConnect = channels.includes(channel);
    });

    await connectChannel(channel, 'fake', channels);

    expect(visibleDuringConnect).toBe(true);
  });

  it('removes the channel and logs when connect() rejects', async () => {
    const channels: Channel[] = [];
    const channel = fakeChannel(async () => {
      throw new Error('invalid_auth');
    });

    await connectChannel(channel, 'slack', channels);

    expect(channels).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('isolates a failed channel without disturbing an already-connected one', async () => {
    const good = fakeChannel(async () => {}, 'good');
    const bad = fakeChannel(async () => {
      throw new Error('invalid_auth');
    }, 'bad');
    const channels: Channel[] = [];

    await connectChannel(good, 'good', channels);
    await connectChannel(bad, 'bad', channels);

    expect(channels).toEqual([good]);
  });
});

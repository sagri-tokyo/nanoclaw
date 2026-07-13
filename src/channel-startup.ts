import { logger } from './logger.js';
import { Channel } from './types.js';

// Register the channel in the active set BEFORE awaiting connect(), then remove
// it again if connect() fails.
//
// Ordering matters: connect() opens the socket (Slack's app.start()) before it
// returns, so inbound events — including a kill-switch abort — can arrive while
// connect() is still resolving. findChannel() must be able to route them for
// the whole connect lifecycle, so the channel has to be in `channels` from the
// start (sagri-tokyo/sagri-ai#154, #128).
//
// Isolation: a channel that fails closed (e.g. Slack rejecting on auth.test()
// so it never opens a socket deaf to the kill switch) is spliced back out and
// logged, so one channel's failure does not abort startup for the others. If
// every channel fails, the caller's connected-count guard still exits fatally.
export async function connectChannel(
  channel: Channel,
  channelName: string,
  channels: Channel[],
): Promise<void> {
  channels.push(channel);
  try {
    await channel.connect();
  } catch (err) {
    const index = channels.indexOf(channel);
    if (index !== -1) channels.splice(index, 1);
    logger.error(
      { channel: channelName, err },
      'Channel failed to connect, skipping',
    );
  }
}

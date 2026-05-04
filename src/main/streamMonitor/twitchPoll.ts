// 段階 X2 — Twitch live-stream polling thin wrapper.
//
// All the heavy lifting (auth, rate-limit, batch chunking) lives in
// `twitchHelix.getLiveStreams`; this module just feeds the credentials
// in and translates the result for the StreamMonitor.

import { getLiveStreams, type TwitchLiveStream } from '../twitchHelix';

export type TwitchPollResult = Map<string, TwitchLiveStream>;

export async function pollTwitchUsers(
  clientId: string,
  clientSecret: string,
  userIds: string[],
): Promise<TwitchPollResult> {
  if (userIds.length === 0) return new Map();
  try {
    return await getLiveStreams(clientId, clientSecret, userIds);
  } catch (err) {
    // Helix has its own retry on 401 (token refresh) + 429 (backoff).
    // If we still got an error, log + return empty rather than letting
    // the whole poll blow up — YouTube branch may still produce useful
    // results in the same tick.
    console.warn(
      '[stream-monitor] twitch poll failed:',
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

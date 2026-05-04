// 段階 X2 — YouTube live-stream polling.
//
// Quota strategy:
//   1. Fetch the channel's RSS feed (0 quota — it's a public XML
//      endpoint with no API key). The feed lists the most recent ~15
//      uploads (regular videos + live streams + premieres).
//   2. Take the top N video IDs from the feed and call
//      videos.list?part=liveStreamingDetails (1 quota per call, up to
//      50 ids batched). actualStartTime + actualEndTime tells us which
//      are live right now.
//
// Per-channel cost: 0 quota for RSS + 1 quota per 50 IDs = 1 quota for
// any realistic poll. Compared to the naive search.list approach
// (100 quota per channel) this is 100× cheaper.
//
// Reliability tradeoffs:
//   - RSS feed may lag a few seconds behind real upload events. For a
//     1-minute polling cadence that's well within tolerance.
//   - Premieres surface in the feed before they go live; we only flag
//     them as live once `actualStartTime` is populated, which fires at
//     the actual go-live event.

import { fetchVideoLiveDetails, type VideoLiveDetail } from '../dataCollection/youtubeApi';

// How many top-of-feed videos to inspect per channel. The RSS feed
// returns up to 15 entries, but most channels' "is anything live"
// answer is in the top 1-3. 5 covers cases where a channel just
// posted a backlog of regular videos and the live stream is buried.
const RSS_INSPECT_TOP_N = 5;

const RSS_TIMEOUT_MS = 8000;

export type YouTubeLiveResult = {
  channelId: string;
  // null when no live stream was found among the inspected IDs.
  detail: VideoLiveDetail | null;
};

// Minimal Atom XML parsing — we only need <yt:videoId> entries. Using
// regex instead of a full XML parser because:
//   - The feed is well-formed and stable (Google maintains it).
//   - We don't need attribute-namespace handling beyond the yt:videoId
//     element name.
//   - Adding xml2js for one regex worth of work is an over-investment.
//
// If a future feed format change breaks this, the targeted fix is
// trivial (and we'll see it in [stream-monitor] logs immediately).
function parseRssVideoIds(xml: string): string[] {
  const out: string[] = [];
  const re = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]!);
    if (out.length >= 30) break; // defensive cap
  }
  return out;
}

async function fetchChannelRssVideoIds(channelId: string): Promise<string[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RSS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssVideoIds(xml);
  } catch (err) {
    console.warn(
      `[stream-monitor] youtube RSS fetch failed for ${channelId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function isCurrentlyLive(d: VideoLiveDetail): boolean {
  return Boolean(d.actualStartTime) && !d.actualEndTime;
}

// Poll a single channel. Returns the live VideoLiveDetail if the
// channel is currently broadcasting, else `{ detail: null }`. Errors
// are caught + logged + treated as "not live" so one channel's RSS
// flake doesn't take down the whole batch.
export async function pollYouTubeChannel(channelId: string): Promise<YouTubeLiveResult> {
  const allIds = await fetchChannelRssVideoIds(channelId);
  if (allIds.length === 0) return { channelId, detail: null };
  const ids = allIds.slice(0, RSS_INSPECT_TOP_N);
  const details = await fetchVideoLiveDetails(ids);
  const live = details.find(isCurrentlyLive);
  return { channelId, detail: live ?? null };
}

// Convenience for the main poll loop: hits channels in parallel.
// Per-channel failures don't propagate.
export async function pollYouTubeChannels(
  channelIds: string[],
): Promise<Map<string, VideoLiveDetail>> {
  const out = new Map<string, VideoLiveDetail>();
  if (channelIds.length === 0) return out;
  const results = await Promise.all(
    channelIds.map((id) =>
      pollYouTubeChannel(id).catch((err) => {
        console.warn(`[stream-monitor] youtube poll error for ${id}:`, err);
        return { channelId: id, detail: null } satisfies YouTubeLiveResult;
      }),
    ),
  );
  for (const r of results) {
    if (r.detail) out.set(r.channelId, r.detail);
  }
  return out;
}

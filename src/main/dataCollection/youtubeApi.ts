import { loadYoutubeApiKeys } from '../secureStorage';
import { getQuotaUsedToday, logQuotaUsage } from './database';
import { logError, logInfo, logWarn } from './logger';

// YouTube Data API v3 client + key rotation. Quota tracking lives in
// the SQLite api_quota_log table (per key, per day) so a process
// restart doesn't reset what we've already burned.
//
// Costs (per Google's published unit costs):
//   * search.list  → 100 units
//   * videos.list  → 1 unit per call (regardless of id count, up to 50)
//   * channels.list → 1 unit
// Daily cap per key: 10000 units. With 10 keys that's 100K/day, easily
// enough for ~50K candidate-videos pulled and another ~10K enriched.

const DAILY_QUOTA_PER_KEY = 10_000;
const COST_SEARCH_LIST = 100;
const COST_VIDEOS_LIST = 1;
const COST_CHANNELS_LIST = 1;
const PER_REQUEST_TIMEOUT_MS = 15_000;

export type SearchListItem = {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
};

export type VideoDetail = {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;          // ISO 8601 PT#H#M#S
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  thumbnails: Record<string, { url: string }>;
};

class ApiKeyRotator {
  private keys: string[] = [];
  private cursor = 0;
  // Keys that returned 401/403/permanent-quota errors get muted for
  // the rest of the day. Indices into `this.keys`.
  private dailyDisabled = new Set<number>();

  async refresh(): Promise<void> {
    this.keys = await loadYoutubeApiKeys();
    this.dailyDisabled.clear();
  }

  async pickKey(estimatedCost: number): Promise<{ key: string; index: number } | null> {
    if (this.keys.length === 0) await this.refresh();
    if (this.keys.length === 0) return null;
    // Round-robin starting from cursor; prefer keys with budget left.
    for (let attempt = 0; attempt < this.keys.length; attempt += 1) {
      const idx = (this.cursor + attempt) % this.keys.length;
      if (this.dailyDisabled.has(idx)) continue;
      const used = getQuotaUsedToday(idx);
      if (used + estimatedCost <= DAILY_QUOTA_PER_KEY) {
        this.cursor = (idx + 1) % this.keys.length;
        return { key: this.keys[idx]!, index: idx };
      }
    }
    return null;
  }

  markDailyDisabled(index: number): void {
    this.dailyDisabled.add(index);
  }
}

const rotator = new ApiKeyRotator();
export async function refreshKeys(): Promise<void> {
  await rotator.refresh();
}

// Common request wrapper: pick a key, charge the estimated cost on
// success (recorded once per call, not per item), and surface 4xx
// reliably so the caller can decide to skip / retry.
async function callApi<T>(
  pathAndQuery: string,
  estimatedCost: number,
): Promise<T | null> {
  const pick = await rotator.pickKey(estimatedCost);
  if (!pick) {
    logWarn('no API key with quota available — batch will produce 0 results');
    return null;
  }
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${encodeURIComponent(pick.key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
    if (res.ok) {
      logQuotaUsage(pick.index, estimatedCost);
      return (await res.json()) as T;
    }
    if (res.status === 403 || res.status === 401) {
      // 403 includes both "quota exceeded" and "key forbidden". Either
      // way, mute this key for the rest of the day.
      logError(`key #${pick.index} disabled (HTTP ${res.status} — quota or auth)`);
      rotator.markDailyDisabled(pick.index);
      // Charge half the cost as a punishment / approximation; YouTube
      // does subtract some quota for failed requests too.
      logQuotaUsage(pick.index, Math.floor(estimatedCost / 2));
      return null;
    }
    const body = await res.text().catch(() => '');
    logWarn(`API HTTP ${res.status}: ${body.slice(0, 200)}`);
    return null;
  } catch (err) {
    logWarn(`API call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Suppress lint warning about logInfo not being used here yet — reserved
// for future per-call success logs once we want that level of detail.
void logInfo;

// Removes the API key from any string before logging — defence-in-
// depth in case the key leaks into an error path.
export function maskKey(s: string): string {
  return s.replaceAll(/key=[A-Za-z0-9_-]+/g, 'key=<redacted>');
}

// ---- search.list -----------------------------------------------------------

type SearchApiResp = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
    };
  }>;
};

export async function searchVideos(
  query: string,
  options: {
    maxResults?: number;
    order?: 'relevance' | 'viewCount' | 'date';
    regionCode?: string;
    relevanceLanguage?: string;
  } = {},
): Promise<SearchListItem[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: String(options.maxResults ?? 50),
    order: options.order ?? 'relevance',
  });
  if (options.regionCode) params.set('regionCode', options.regionCode);
  if (options.relevanceLanguage) params.set('relevanceLanguage', options.relevanceLanguage);
  const json = await callApi<SearchApiResp>(`search?${params.toString()}`, COST_SEARCH_LIST);
  if (!json) return [];
  const items: SearchListItem[] = [];
  for (const it of json.items ?? []) {
    const vid = it.id?.videoId;
    if (!vid) continue;
    items.push({
      videoId: vid,
      title: it.snippet?.title ?? '',
      channelId: it.snippet?.channelId ?? '',
      channelTitle: it.snippet?.channelTitle ?? '',
      publishedAt: it.snippet?.publishedAt ?? '',
    });
  }
  return items;
}

// ---- search (channel) -----------------------------------------------------
// One-shot channel-id resolution by display name. Uses search.list with
// type=channel — same 100-unit cost as a video search but returns
// channel rows. Heuristic: take the first hit (relevance order +
// regionCode JP works well for famous Japanese VTubers and streamers).
//
// Caller is expected to dedupe / cache (we run this per creator once
// at batch start, only when channelId is still null).

type ChannelSearchResp = {
  items?: Array<{
    id?: { channelId?: string };
    snippet?: { title?: string; channelId?: string };
  }>;
};

export async function searchChannelByName(
  name: string,
): Promise<{ channelId: string; channelTitle: string } | null> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'channel',
    q: name,
    maxResults: '5',
    regionCode: 'JP',
    relevanceLanguage: 'ja',
  });
  const json = await callApi<ChannelSearchResp>(`search?${params.toString()}`, COST_SEARCH_LIST);
  if (!json) return null;
  for (const it of json.items ?? []) {
    const cid = it.id?.channelId ?? it.snippet?.channelId;
    if (cid) {
      return { channelId: cid, channelTitle: it.snippet?.title ?? '' };
    }
  }
  return null;
}

// 2026-05-04 (hybrid creator search) — multi-result variant. Reuses the
// same 100-quota search.list call but returns up to `maxResults`
// candidates with thumbnails + descriptions, so the registration UI
// can show the user a picker when Gemini didn't surface a YouTube
// handle. Caller is responsible for any subscriber-count enrichment
// via getChannelById() / getChannelByHandle() (1 quota each).
type ChannelSearchRespFull = {
  items?: Array<{
    id?: { channelId?: string };
    snippet?: {
      title?: string;
      description?: string;
      channelId?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
};

export type ChannelSearchHit = {
  channelId: string;
  channelTitle: string;
  description: string;
  profileImageUrl: string | null;
};

export async function searchChannelsByName(
  query: string,
  maxResults: number = 5,
): Promise<ChannelSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'channel',
    q: trimmed,
    maxResults: String(Math.max(1, Math.min(50, maxResults))),
    regionCode: 'JP',
    relevanceLanguage: 'ja',
  });
  const json = await callApi<ChannelSearchRespFull>(`search?${params.toString()}`, COST_SEARCH_LIST);
  if (!json) return [];
  const out: ChannelSearchHit[] = [];
  for (const it of json.items ?? []) {
    const cid = it.id?.channelId ?? it.snippet?.channelId;
    if (!cid) continue;
    out.push({
      channelId: cid,
      channelTitle: it.snippet?.title ?? '',
      description: it.snippet?.description ?? '',
      profileImageUrl: pickThumbnailUrl(it.snippet?.thumbnails),
    });
  }
  return out;
}

// ---- channels.list ---------------------------------------------------------
//
// Used by the auto-record creator search flow. Single entry point:
// `getChannelByHandle('@xxx')`, 1 quota unit per call. We deliberately
// do NOT fall back to `search.list` (100 units) when the handle misses
// — the cost ratio is 100× and we'd burn the 50-key × 10K/day budget
// fast on speculative searches. If Gemini's handle guess is wrong,
// returning null is the right answer.

type ChannelsListResp = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      customUrl?: string; // "@handle" or legacy "/c/Name"
      thumbnails?: Record<string, { url?: string }>;
      publishedAt?: string;
    };
    statistics?: {
      subscriberCount?: string;
      hiddenSubscriberCount?: boolean;
      videoCount?: string;
    };
  }>;
};

export type ChannelLookup = {
  channelId: string;
  channelName: string;
  handle: string | null; // normalised "@xxx"
  profileImageUrl: string | null;
  // ISO 8601 channel creation timestamp from snippet.publishedAt.
  // Empty string when the field isn't returned (defensive — should
  // always be set by the API for valid channels).
  createdAt: string;
  // YouTube rounds subscriberCount publicly (1.23M etc.) — the
  // numeric value here matches what's shown on the channel page.
  // null when statistics weren't returned OR the channel hides its
  // subscriber count (`hiddenSubscriberCount: true`).
  subscriberCount: number | null;
};

function normaliseHandle(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function pickThumbnailUrl(thumbs: Record<string, { url?: string }> | undefined): string | null {
  if (!thumbs) return null;
  // Prefer larger thumbnails — high (480) → medium (240) → default (88).
  // The Settings UI renders ~40px so even default works, but high gives
  // crisp retina rendering.
  return thumbs['high']?.url ?? thumbs['medium']?.url ?? thumbs['default']?.url ?? null;
}

function toChannelLookup(item: NonNullable<ChannelsListResp['items']>[number]): ChannelLookup | null {
  if (!item.id) return null;
  const customUrl = item.snippet?.customUrl ?? null;
  // hiddenSubscriberCount is the API's signal that the user opted to
  // hide their subscriber number. Treat as null even if a numeric
  // value also got returned.
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  const rawCount = item.statistics?.subscriberCount;
  const subscriberCount =
    !hidden && typeof rawCount === 'string' && rawCount !== '' && Number.isFinite(Number(rawCount))
      ? Number(rawCount)
      : null;
  return {
    channelId: item.id,
    channelName: item.snippet?.title ?? '',
    handle: customUrl && customUrl.startsWith('@') ? customUrl : null,
    profileImageUrl: pickThumbnailUrl(item.snippet?.thumbnails),
    createdAt: item.snippet?.publishedAt ?? '',
    subscriberCount,
  };
}

export async function getChannelByHandle(handle: string): Promise<ChannelLookup | null> {
  // forHandle accepts the leading @, but the API is forgiving — pass
  // it normalised so logs are uniform.
  // `statistics` adds subscriberCount + videoCount; same 1-quota cost
  // as snippet-only.
  const params = new URLSearchParams({
    part: 'snippet,statistics',
    forHandle: normaliseHandle(handle),
  });
  const json = await callApi<ChannelsListResp>(`channels?${params.toString()}`, COST_CHANNELS_LIST);
  if (!json) return null;
  const item = json.items?.[0];
  return item ? toChannelLookup(item) : null;
}

// Lookup by channel ID (UCxxx form). Used by the manual-input
// fallback path when the user types a channelId directly into the
// register-creators UI. Same 1-quota cost.
export async function getChannelById(channelId: string): Promise<ChannelLookup | null> {
  const trimmed = channelId.trim();
  if (!trimmed) return null;
  const params = new URLSearchParams({
    part: 'snippet,statistics',
    id: trimmed,
  });
  const json = await callApi<ChannelsListResp>(`channels?${params.toString()}`, COST_CHANNELS_LIST);
  if (!json) return null;
  const item = json.items?.[0];
  return item ? toChannelLookup(item) : null;
}

// ---- videos.list -----------------------------------------------------------

type VideosApiResp = {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      description?: string;
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
};

// Up to 50 ids per request — that's why videos.list is cheap. Caller
// chunks if more than 50.
export async function fetchVideoDetails(videoIds: string[]): Promise<VideoDetail[]> {
  const out: VideoDetail[] = [];
  for (let off = 0; off < videoIds.length; off += 50) {
    const chunk = videoIds.slice(off, off + 50);
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,statistics',
      id: chunk.join(','),
      maxResults: '50',
    });
    const json = await callApi<VideosApiResp>(`videos?${params.toString()}`, COST_VIDEOS_LIST);
    if (!json) continue;
    for (const it of json.items ?? []) {
      const thumbs: Record<string, { url: string }> = {};
      for (const [k, v] of Object.entries(it.snippet?.thumbnails ?? {})) {
        if (v?.url) thumbs[k] = { url: v.url };
      }
      out.push({
        id: it.id,
        title: it.snippet?.title ?? '',
        description: it.snippet?.description ?? '',
        channelId: it.snippet?.channelId ?? '',
        channelTitle: it.snippet?.channelTitle ?? '',
        publishedAt: it.snippet?.publishedAt ?? '',
        duration: it.contentDetails?.duration ?? '',
        viewCount: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null,
        likeCount: it.statistics?.likeCount ? Number(it.statistics.likeCount) : null,
        commentCount: it.statistics?.commentCount ? Number(it.statistics.commentCount) : null,
        thumbnails: thumbs,
      });
    }
  }
  return out;
}

// ---- liveStreamingDetails (段階 X2: live-stream polling) ------------------
//
// `videos.list?part=liveStreamingDetails` is 1 quota unit per call (up
// to 50 ids per request, like the regular videos.list path). It's
// what stream-monitor's YouTube branch uses to confirm whether the
// IDs it harvested from a channel's RSS feed are currently live.
//
// `actualStartTime` is set when the stream began airing.
// `actualEndTime` is set when it ended.
// → currently live = actualStartTime present AND actualEndTime absent.

export type VideoLiveDetail = {
  id: string;
  title: string;
  channelId: string;
  thumbnailUrl: string | null;
  // ISO 8601 timestamps from the API. Both `null` if Google reports
  // no liveStreamingDetails block (= regular VOD upload).
  actualStartTime: string | null;
  actualEndTime: string | null;
  scheduledStartTime: string | null;
};

type VideosLiveApiResp = {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      channelId?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    liveStreamingDetails?: {
      actualStartTime?: string;
      actualEndTime?: string;
      scheduledStartTime?: string;
    };
  }>;
};

export async function fetchVideoLiveDetails(videoIds: string[]): Promise<VideoLiveDetail[]> {
  const out: VideoLiveDetail[] = [];
  if (videoIds.length === 0) return out;
  for (let off = 0; off < videoIds.length; off += 50) {
    const chunk = videoIds.slice(off, off + 50);
    const params = new URLSearchParams({
      part: 'snippet,liveStreamingDetails',
      id: chunk.join(','),
      maxResults: '50',
    });
    const json = await callApi<VideosLiveApiResp>(
      `videos?${params.toString()}`,
      COST_VIDEOS_LIST,
    );
    if (!json) continue;
    for (const it of json.items ?? []) {
      out.push({
        id: it.id,
        title: it.snippet?.title ?? '',
        channelId: it.snippet?.channelId ?? '',
        thumbnailUrl: pickThumbnailUrl(it.snippet?.thumbnails),
        actualStartTime: it.liveStreamingDetails?.actualStartTime ?? null,
        actualEndTime: it.liveStreamingDetails?.actualEndTime ?? null,
        scheduledStartTime: it.liveStreamingDetails?.scheduledStartTime ?? null,
      });
    }
  }
  return out;
}

// ---- Helpers ---------------------------------------------------------------

// ISO 8601 duration (PT#H#M#S) → seconds. Returns null on parse failure.
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  return h * 3600 + min * 60 + s;
}

// Suppresses the `_CHANNELS_LIST` constant unused warning. Kept exported
// for the future when we want to walk a creator's channel page directly.
export const COST_CONSTANTS = {
  search: COST_SEARCH_LIST,
  videos: COST_VIDEOS_LIST,
  channels: COST_CHANNELS_LIST,
} as const;

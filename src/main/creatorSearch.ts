// 段階 X1 (revised) — Creator search backend.
//
// Three responsibilities:
//   1) askGemini(query) — given a Japanese display name (e.g. "柊ツルギ"),
//      ask Gemini what YouTube handle and Twitch login that person uses.
//      Returns null fields when Gemini doesn't know (low confidence is
//      surfaced verbatim so the UI can warn).
//   2) fetchTwitchProfile(login) — concrete Helix lookup, returns the
//      verified user record or null. Reuses twitchHelix.searchUserByLogin.
//   3) fetchYouTubeProfile({handle}) — concrete YouTube Data API lookup
//      via channels.list?forHandle (1 quota unit). Returns null when
//      the handle doesn't resolve; we deliberately do NOT fall back to
//      search.list (100 quota units) — the per-search quota cost would
//      be 100× higher and the Gemini-suggested handle is the
//      authoritative signal anyway. If the handle is wrong the UI
//      surfaces null and the user re-searches with a different name.
//
// All three are wrapped at the IPC layer in main/index.ts.

import { generateTextWithRotation } from './gemini';
import {
  getTwitchFollowerCount,
  searchTwitchChannels,
  searchUserByLogin,
} from './twitchHelix';
import {
  getChannelByHandle,
  getChannelById,
  searchChannelsByName,
  type ChannelLookup,
} from './dataCollection/youtubeApi';

export type GeminiCreatorGuess = {
  twitch: { login: string; confidence: 'high' | 'medium' | 'low' } | null;
  youtube: {
    handle: string;
    channelName: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
};

const PROMPT_TEMPLATE = (query: string): string => `あなたは VTuber / 配信者の知識データベースです。
以下の名前の配信者について、YouTube と Twitch でのチャンネル情報を教えてください。

検索対象: ${query}

JSON 形式で以下を返してください。情報が不明な場合は該当フィールドを null にしてください。

{
  "twitch": {
    "login": "<Twitch のログイン名(英数字、URL 末尾)>",
    "confidence": "high" | "medium" | "low"
  } | null,
  "youtube": {
    "handle": "<YouTube の @ハンドル(@含む)>",
    "channelName": "<チャンネル名>",
    "confidence": "high" | "medium" | "low"
  } | null
}

判断基準:
- "high": その配信者が確実にそのプラットフォームで活動していると確信できる
- "medium": そのプラットフォームで活動している可能性が高いが、ハンドル名に若干の不確実性
- "low": 推測ベース、確認が必要

返答は JSON のみ、説明文・コードフェンス・前置きは一切不要です。`;

function isConfidence(v: unknown): v is 'high' | 'medium' | 'low' {
  return v === 'high' || v === 'medium' || v === 'low';
}

// Strip markdown code fences if Gemini ignores the no-fence instruction
// (it does this occasionally despite responseMimeType). Belt-and-braces:
// the preferred path is responseMimeType='application/json', this is
// the fallback when that header gets ignored on a particular run.
function stripFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  // Remove leading ``` or ```json line and trailing ``` line.
  if (lines[0]?.startsWith('```')) lines.shift();
  if (lines[lines.length - 1]?.trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

export async function askGemini(query: string): Promise<GeminiCreatorGuess> {
  const trimmed = query.trim();
  console.log(`[creator-search] askGemini query="${trimmed}"`);
  if (!trimmed) {
    return { twitch: null, youtube: null };
  }
  let raw: string;
  try {
    raw = await generateTextWithRotation(PROMPT_TEMPLATE(trimmed));
  } catch (err) {
    console.warn('[creator-search] generateTextWithRotation threw:', err);
    throw err;
  }
  console.log(
    `[creator-search] gemini raw (${raw.length} chars): ${raw.slice(0, 500).replace(/\n/g, ' \\n ')}`,
  );
  if (!raw.trim()) {
    console.warn('[creator-search] gemini returned empty response (safety filter? quota? auth?)');
    return { twitch: null, youtube: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (err) {
    console.warn('[creator-search] Gemini JSON parse failed:', err, 'raw:', raw.slice(0, 300));
    return { twitch: null, youtube: null };
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[creator-search] parsed payload is not an object:', parsed);
    return { twitch: null, youtube: null };
  }
  const o = parsed as Record<string, unknown>;
  const out: GeminiCreatorGuess = { twitch: null, youtube: null };

  // Twitch slot
  const t = o['twitch'];
  if (t && typeof t === 'object') {
    const ot = t as Record<string, unknown>;
    const login = typeof ot['login'] === 'string' ? ot['login'].trim() : '';
    const conf = ot['confidence'];
    if (login && isConfidence(conf)) {
      out.twitch = { login, confidence: conf };
    } else {
      console.warn(
        `[creator-search] twitch slot dropped: login="${login}" confidence=${JSON.stringify(conf)}`,
      );
    }
  } else if (t === null) {
    console.log('[creator-search] twitch slot is null in gemini response');
  } else {
    console.warn('[creator-search] twitch slot unexpected shape:', t);
  }

  // YouTube slot
  const y = o['youtube'];
  if (y && typeof y === 'object') {
    const oy = y as Record<string, unknown>;
    const handle = typeof oy['handle'] === 'string' ? oy['handle'].trim() : '';
    const channelName = typeof oy['channelName'] === 'string' ? oy['channelName'].trim() : '';
    const conf = oy['confidence'];
    if ((handle || channelName) && isConfidence(conf)) {
      out.youtube = { handle, channelName, confidence: conf };
    } else {
      console.warn(
        `[creator-search] youtube slot dropped: handle="${handle}" channelName="${channelName}" confidence=${JSON.stringify(conf)}`,
      );
    }
  } else if (y === null) {
    console.log('[creator-search] youtube slot is null in gemini response');
  } else {
    console.warn('[creator-search] youtube slot unexpected shape:', y);
  }

  console.log(
    `[creator-search] askGemini result: twitch=${out.twitch ? `${out.twitch.login}/${out.twitch.confidence}` : 'null'}, ` +
      `youtube=${out.youtube ? `${out.youtube.handle || '?'}/${out.youtube.confidence}` : 'null'}`,
  );
  return out;
}

export type TwitchProfile = {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  // ISO 8601 account creation timestamp.
  createdAt: string;
  // null = unavailable (most app-only Client Credentials tokens
  // can't read /helix/channels/followers — see twitchHelix
  // getTwitchFollowerCount). UI renders "不明" in that case.
  followerCount: number | null;
};

// Twitch profile lookup. The Helix Client Credentials flow is gated by
// the user's stored Client ID/Secret — caller must supply the same
// credentials that power the auto-record series. Returns null when the
// login doesn't resolve to a Twitch account (helix/users 404 / empty
// data array).
export async function fetchTwitchProfile(
  clientId: string,
  clientSecret: string,
  login: string,
): Promise<TwitchProfile | null> {
  const user = await searchUserByLogin(clientId, clientSecret, login);
  if (!user) return null;
  // Best-effort follower fetch. We don't gate the profile result on
  // it — the user's primary need (login + display name + thumbnail)
  // is already satisfied at this point.
  const followerCount = await getTwitchFollowerCount(clientId, clientSecret, user.id);
  return {
    userId: user.id,
    login: user.login,
    displayName: user.displayName,
    profileImageUrl: user.profileImageUrl,
    createdAt: user.createdAt,
    followerCount,
  };
}

export type YouTubeProfile = {
  channelId: string;
  channelName: string;
  handle: string | null;
  profileImageUrl: string | null;
  // ISO 8601 channel creation timestamp.
  createdAt: string;
  // YouTube-rounded subscriber count from channels.list?part=statistics.
  // null when the channel has hidden its subscriber count, or when
  // statistics weren't returned for some reason.
  subscriberCount: number | null;
};

// YouTube profile lookup. Handle-first, channelId-fallback (both at
// 1 quota unit per attempt — see youtubeApi.getChannelByHandle/ById).
//
// We deliberately don't fall back to `search.list` (100 quota units).
// Either the user knows the handle/channelId (manual-input path —
// channelId branch below), or Gemini's guess gives us a handle to
// try. Wrong handle → null, the UI shows "見つかりませんでした" and
// the user re-searches.
export async function fetchYouTubeProfile(args: {
  handle?: string | null;
  channelId?: string | null;
}): Promise<YouTubeProfile | null> {
  // channelId path takes precedence — when the user types a UCxxx in
  // the manual-input box, they expect that exact channel back.
  const channelId = args.channelId?.trim();
  if (channelId) {
    const byId = await getChannelById(channelId);
    if (byId) return toYouTubeProfile(byId);
    return null;
  }
  const handle = args.handle?.trim();
  if (!handle) return null;
  const direct = await getChannelByHandle(handle);
  if (!direct) return null;
  return toYouTubeProfile(direct);
}

function toYouTubeProfile(c: ChannelLookup): YouTubeProfile {
  return {
    channelId: c.channelId,
    channelName: c.channelName,
    handle: c.handle,
    profileImageUrl: c.profileImageUrl,
    createdAt: c.createdAt,
    subscriberCount: c.subscriberCount,
  };
}

// ---------------------------------------------------------------------------
// 2026-05-04 — Hybrid creator search.
//
// Gemini-only search has been observed to:
//   - return one platform but not the other (impostor-grade null)
//   - return the wrong same-name account ("加藤純一" → jun_kato_0817
//     when the real one is kato_junichi0817)
//   - drop into SAFETY null on otherwise-known names
//   - flicker between answers across runs
//
// `searchCreators` keeps Gemini as the cheap primary path and adds API
// search as a *fallback when Gemini fails*. Cost trade-off:
//   - Gemini hit  = 0 quota (current behaviour)
//   - Twitch fallback = 1 search/channels + N follower lookups (~5 units)
//   - YouTube fallback = 100 (search.list) + N channels.list (~5 units)
// → YouTube fallback is the expensive one; cache it aggressively to
//   avoid quota burn from accidental re-clicks.
// ---------------------------------------------------------------------------

export type CandidateSource = 'gemini' | 'api-fallback' | 'none';

export type SearchCandidatesResult = {
  twitch: TwitchProfile[];
  youtube: YouTubeProfile[];
  source: { twitch: CandidateSource; youtube: CandidateSource };
  // 2026-05-04 — How many candidates were dropped by the follower /
  // subscriber threshold filter. Per-platform so the UI can offer
  // "lower threshold" hints exactly where they help.
  filteredOut: { twitch: number; youtube: number };
  // The threshold actually applied to this query (after override
  // resolution). 0 = no filter. The UI shows this in the relaxation
  // hint ("20 万人未満で X 件除外しました").
  thresholdApplied: number;
};

// Per-platform in-memory cache. Keyed by trimmed query. 5 min TTL —
// short enough that a follower count refresh is plausible, long enough
// to absorb double-clicks and accidental re-searches.
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry<T> = { results: T[]; ts: number };
const twitchSearchCache = new Map<string, CacheEntry<TwitchProfile>>();
const youtubeSearchCache = new Map<string, CacheEntry<YouTubeProfile>>();

function cacheGet<T>(c: Map<string, CacheEntry<T>>, key: string): T[] | null {
  const hit = c.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > SEARCH_CACHE_TTL_MS) {
    c.delete(key);
    return null;
  }
  return hit.results;
}

function cachePut<T>(c: Map<string, CacheEntry<T>>, key: string, results: T[]): void {
  c.set(key, { results, ts: Date.now() });
}

// Concurrency-bounded enrichment helper. Twitch follower lookup costs
// 1 unit per call; we run 5 in parallel which is well under the
// 800/min Helix budget while keeping latency low.
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, idx: number) => Promise<O>,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fallbackTwitch(
  clientId: string,
  clientSecret: string,
  query: string,
  topN: number,
): Promise<TwitchProfile[]> {
  const cached = cacheGet(twitchSearchCache, query);
  if (cached) {
    console.log(`[creator-search] twitch fallback cache hit (${cached.length})`);
    return cached.slice(0, topN);
  }
  console.log(`[creator-search] twitch fallback: search/channels query="${query}"`);
  const hits = await searchTwitchChannels(clientId, clientSecret, query, 10);
  console.log(`[creator-search] twitch fallback: ${hits.length} candidates`);
  // Enrich with follower count in parallel (small concurrency to be
  // gentle on the 800/min rate limit even with many in-flight calls).
  const enriched = await mapWithConcurrency(hits, 5, async (h) => {
    const fc = await getTwitchFollowerCount(clientId, clientSecret, h.userId);
    return {
      userId: h.userId,
      login: h.login,
      displayName: h.displayName,
      profileImageUrl: h.profileImageUrl,
      createdAt: '',
      followerCount: fc,
    } satisfies TwitchProfile;
  });
  // Sort by follower count desc — the user almost always wants the
  // highest-follower hit first. nulls go to the end.
  enriched.sort((a, b) => (b.followerCount ?? -1) - (a.followerCount ?? -1));
  cachePut(twitchSearchCache, query, enriched);
  return enriched.slice(0, topN);
}

async function fallbackYouTube(query: string, topN: number): Promise<YouTubeProfile[]> {
  const cached = cacheGet(youtubeSearchCache, query);
  if (cached) {
    console.log(`[creator-search] youtube fallback cache hit (${cached.length})`);
    return cached.slice(0, topN);
  }
  console.log(`[creator-search] youtube fallback: search.list (100 quota) query="${query}"`);
  const hits = await searchChannelsByName(query, 5);
  console.log(`[creator-search] youtube fallback: ${hits.length} candidates`);
  // Enrich each hit with subscriber count via channels.list (1 quota
  // per call). Sequential is fine — we have at most 5 candidates.
  const enriched: YouTubeProfile[] = [];
  for (const h of hits) {
    const lookup = await getChannelById(h.channelId);
    if (!lookup) {
      enriched.push({
        channelId: h.channelId,
        channelName: h.channelTitle,
        handle: null,
        profileImageUrl: h.profileImageUrl,
        createdAt: '',
        subscriberCount: null,
      });
      continue;
    }
    enriched.push(toYouTubeProfile(lookup));
  }
  enriched.sort((a, b) => (b.subscriberCount ?? -1) - (a.subscriberCount ?? -1));
  cachePut(youtubeSearchCache, query, enriched);
  return enriched.slice(0, topN);
}

export async function searchCreators(args: {
  query: string;
  twitchClientId: string | null;
  twitchClientSecret: string | null;
  // 2026-05-04 — Catch-all minimum follower count for API-fallback
  // candidates. AppConfig.searchMinFollowers is the persisted default;
  // this argument lets the renderer pass an in-flight override (the
  // "10 万で再検索 / 閾値なしで再検索" buttons that fire after a 0-hit
  // page) WITHOUT mutating the persisted setting.
  minFollowers: number;
}): Promise<SearchCandidatesResult> {
  const trimmed = args.query.trim();
  console.log(`[creator-search] searchCreators query="${trimmed}" minFollowers=${args.minFollowers}`);
  if (!trimmed) {
    return {
      twitch: [],
      youtube: [],
      source: { twitch: 'none', youtube: 'none' },
      filteredOut: { twitch: 0, youtube: 0 },
      thresholdApplied: args.minFollowers,
    };
  }

  // Step 1: Gemini primary. Soft-fail to null guess on any error so
  // the API fallback can still produce candidates. (A hard throw here
  // would block the whole flow — exactly the regression the user is
  // trying to fix.)
  let guess: GeminiCreatorGuess = { twitch: null, youtube: null };
  try {
    guess = await askGemini(trimmed);
  } catch (err) {
    console.warn('[creator-search] gemini failed, proceeding to fallback:', err);
  }

  // Step 2: resolve Gemini's guesses (when present) via the existing
  // 1-quota lookups.
  const twitchHasCreds = !!(args.twitchClientId && args.twitchClientSecret);
  const [twitchFromGemini, youtubeFromGemini] = await Promise.allSettled([
    guess.twitch && twitchHasCreds
      ? fetchTwitchProfile(args.twitchClientId!, args.twitchClientSecret!, guess.twitch.login)
      : Promise.resolve(null),
    guess.youtube && (guess.youtube.handle || guess.youtube.channelName)
      ? fetchYouTubeProfile({ handle: guess.youtube.handle || null })
      : Promise.resolve(null),
  ]);

  const twitchProfile =
    twitchFromGemini.status === 'fulfilled' ? twitchFromGemini.value : null;
  const youtubeProfile =
    youtubeFromGemini.status === 'fulfilled' ? youtubeFromGemini.value : null;

  const result: SearchCandidatesResult = {
    twitch: twitchProfile ? [twitchProfile] : [],
    youtube: youtubeProfile ? [youtubeProfile] : [],
    source: {
      twitch: twitchProfile ? 'gemini' : 'none',
      youtube: youtubeProfile ? 'gemini' : 'none',
    },
    filteredOut: { twitch: 0, youtube: 0 },
    thresholdApplied: args.minFollowers,
  };

  // Step 3: Twitch fallback when Gemini didn't yield a usable result.
  if (result.twitch.length === 0 && twitchHasCreds) {
    try {
      const candidates = await fallbackTwitch(
        args.twitchClientId!,
        args.twitchClientSecret!,
        trimmed,
        5,
      );
      if (candidates.length > 0) {
        result.twitch = candidates;
        result.source.twitch = 'api-fallback';
      }
    } catch (err) {
      console.warn('[creator-search] twitch fallback failed:', err);
    }
  }

  // Step 4: YouTube fallback. 100-quota cost — gated by the same
  // "Gemini didn't return a usable profile" condition. The cache
  // shields against accidental re-clicks within 5 min.
  if (result.youtube.length === 0) {
    try {
      const candidates = await fallbackYouTube(trimmed, 5);
      if (candidates.length > 0) {
        result.youtube = candidates;
        result.source.youtube = 'api-fallback';
      }
    } catch (err) {
      console.warn('[creator-search] youtube fallback failed:', err);
    }
  }

  // Step 5: minimum-follower filter. Only API-fallback candidates get
  // gated; Gemini results are pass-through (Gemini already vetted them
  // as "the actual person", and forcing 200K on a small individual the
  // user explicitly named would be hostile). Null counts also pass —
  // some Twitch app-token accounts can't read /channels/followers, so
  // null = "unable to check, don't punish".
  if (args.minFollowers > 0) {
    if (result.source.twitch === 'api-fallback') {
      const before = result.twitch.length;
      result.twitch = result.twitch.filter(
        (p) => p.followerCount === null || p.followerCount >= args.minFollowers,
      );
      result.filteredOut.twitch = before - result.twitch.length;
      if (result.twitch.length === 0) result.source.twitch = 'none';
    }
    if (result.source.youtube === 'api-fallback') {
      const before = result.youtube.length;
      result.youtube = result.youtube.filter(
        (p) => p.subscriberCount === null || p.subscriberCount >= args.minFollowers,
      );
      result.filteredOut.youtube = before - result.youtube.length;
      if (result.youtube.length === 0) result.source.youtube = 'none';
    }
    if (result.filteredOut.twitch + result.filteredOut.youtube > 0) {
      console.log(
        `[creator-search] filtered out (< ${args.minFollowers}): ` +
          `twitch=${result.filteredOut.twitch} youtube=${result.filteredOut.youtube}`,
      );
    }
  }

  console.log(
    `[creator-search] result: twitch=${result.twitch.length}(${result.source.twitch}) ` +
      `youtube=${result.youtube.length}(${result.source.youtube})`,
  );
  return result;
}

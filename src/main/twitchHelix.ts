// Twitch Helix API client — Client Credentials flow.
//
// 段階 X1 of the auto-record series. This module owns:
//   - access-token acquisition + cache (no DB / disk; memory only)
//   - user lookup by login (the registration UI's "search" step)
//   - live-stream status (used by 段階 X2 polling, also exposed now
//     so the UI's "認証テスト" can probe end-to-end with one click)
//
// Auth model: Client Credentials gives us an *app* token — no user
// scopes, fine for read-only public endpoints (helix/users, helix/streams)
// which is everything 段階 X1-X4 needs. If a future feature requires a
// user-scoped action (e.g. follow notifications, subscriber-only data)
// we'll need to graduate to OAuth Authorization Code, but that's not
// today's problem.

const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';

// Cushion before expiry. App tokens last ~60 days, so 60 seconds of
// proactive refresh is comfortably less than any realistic clock skew
// without spamming the OAuth endpoint.
const TOKEN_REFRESH_CUSHION_MS = 60_000;

// Rate-limit retry parameters. Helix's documented limit is 800 points/
// minute for app tokens; we won't get near that from interactive UI.
// 5s × 3 retries is enough head-room for a transient burst.
const RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;

// Per-request timeout. Keeps a hung Twitch endpoint from freezing the
// renderer's "search..." button forever. 10 s is plenty for any Helix
// call we make — they're all small JSON payloads.
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Token cache (module-scope)
// ---------------------------------------------------------------------------

type CacheEntry = {
  // Identity of the credentials that produced this token. Switching
  // credentials in the UI invalidates the cache; we detect it by
  // comparing against this fingerprint instead of forcing every caller
  // to invoke a clear-on-save IPC.
  clientIdFingerprint: string;
  accessToken: string;
  // Wall-clock timestamp (Date.now() compatible) at which the token
  // becomes unusable. Compared with the refresh cushion below.
  expiresAt: number;
};

let tokenCache: CacheEntry | null = null;

// Shared in-flight promise so two concurrent `getAccessToken` calls
// don't both hit the OAuth endpoint. Cleared in `finally`.
let inflightToken: Promise<{ accessToken: string; expiresAt: number }> | null = null;

function fingerprint(clientId: string, clientSecret: string): string {
  // Cheap, non-cryptographic — we only need "did the credentials
  // change" detection, not key derivation. Bcrypt-style hashing here
  // would be theatrical given that the secret is already DPAPI-
  // encrypted on disk.
  return `${clientId.length}:${clientId}:${clientSecret.length}`;
}

export function clearTokenCache(): void {
  tokenCache = null;
}

export async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  if (!clientId || !clientSecret) {
    throw new Error('Twitch Client ID / Client Secret が未設定です');
  }
  const fp = fingerprint(clientId, clientSecret);

  // Cache hit — return without touching the network.
  if (
    tokenCache &&
    tokenCache.clientIdFingerprint === fp &&
    tokenCache.expiresAt - TOKEN_REFRESH_CUSHION_MS > Date.now()
  ) {
    return { accessToken: tokenCache.accessToken, expiresAt: tokenCache.expiresAt };
  }

  if (inflightToken) return inflightToken;

  inflightToken = (async () => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Twitch 認証エラー: Client ID / Secret が正しくありません');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twitch token 取得失敗: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new Error('Twitch token レスポンスが想定外の形式です');
    }
    const expiresAt = Date.now() + json.expires_in * 1000;
    tokenCache = {
      clientIdFingerprint: fp,
      accessToken: json.access_token,
      expiresAt,
    };
    return { accessToken: json.access_token, expiresAt };
  })();

  try {
    return await inflightToken;
  } finally {
    inflightToken = null;
  }
}

// ---------------------------------------------------------------------------
// Helix request helper
// ---------------------------------------------------------------------------

async function helixGet<T>(
  clientId: string,
  accessToken: string,
  pathAndQuery: string,
): Promise<{ status: 'ok'; data: T } | { status: 'not-found' } | { status: 'unauthorized' }> {
  let attempt = 0;
  while (true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${HELIX_BASE}${pathAndQuery}`, {
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      // Token expired or revoked between our cache check and now.
      // Caller's job to refresh + retry — we just signal it.
      return { status: 'unauthorized' };
    }
    if (res.status === 404) return { status: 'not-found' };
    if (res.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error('Twitch Helix: rate limit を超えました(再試行回数上限)');
      }
      attempt += 1;
      await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twitch Helix HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as T;
    return { status: 'ok', data: json };
  }
}

// One-level retry on 401: refresh the token, then try once more. If
// the second attempt also returns 401 the credentials are bad — bubble
// the error up.
async function helixGetWithRefresh<T>(
  clientId: string,
  clientSecret: string,
  pathAndQuery: string,
): Promise<{ status: 'ok'; data: T } | { status: 'not-found' }> {
  const first = await getAccessToken(clientId, clientSecret);
  let result = await helixGet<T>(clientId, first.accessToken, pathAndQuery);
  if (result.status === 'unauthorized') {
    clearTokenCache();
    const refreshed = await getAccessToken(clientId, clientSecret);
    result = await helixGet<T>(clientId, refreshed.accessToken, pathAndQuery);
    if (result.status === 'unauthorized') {
      throw new Error('Twitch 認証に失敗しました(token refresh 後も 401)');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TwitchUser = {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  // ISO 8601 account creation timestamp from /helix/users. Used by
  // the registration UI to help disambiguate same-name impostors —
  // a real high-profile streamer's account is usually years old.
  createdAt: string;
};

// Follower count for a Twitch broadcaster. Twitch deprecated the
// public follower-count endpoint in 2023; the replacement
// `/helix/channels/followers` requires a USER OAuth token with
// `moderator:read:followers` scope (the broadcaster themselves or
// one of their mods). Our auto-record series uses Client Credentials
// (app-only) tokens, so this call WILL 401 in normal operation.
//
// We try anyway because:
//   - Some Twitch endpoints have undocumented public modes.
//   - The user's own broadcaster could have a different scope set.
//   - The cost of trying is one extra HTTP call which we already
//     paid the cost of authenticating for.
//
// Returns null on 401 / 403 / any other failure. Callers render
// the "follower" UI as 「不明」when null.
export async function getTwitchFollowerCount(
  clientId: string,
  clientSecret: string,
  broadcasterId: string,
): Promise<number | null> {
  const result = await helixGetWithRefresh<{
    total?: number;
    data?: unknown;
  }>(
    clientId,
    clientSecret,
    `/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
  ).catch(() => null);
  if (!result || result.status !== 'ok') return null;
  return typeof result.data.total === 'number' ? result.data.total : null;
}

export async function searchUserByLogin(
  clientId: string,
  clientSecret: string,
  login: string,
): Promise<TwitchUser | null> {
  const trimmed = login.trim().toLowerCase();
  if (!trimmed) return null;
  // /helix/users?login=<login> returns the canonical record. The
  // `search` endpoint is also available but does fuzzy matching that's
  // not what we want for the registration flow ("type the exact login").
  const result = await helixGetWithRefresh<{
    data: Array<{
      id: string;
      login: string;
      display_name: string;
      profile_image_url: string;
      created_at?: string;
    }>;
  }>(clientId, clientSecret, `/users?login=${encodeURIComponent(trimmed)}`);
  if (result.status === 'not-found') return null;
  const first = result.data.data[0];
  if (!first) return null;
  return {
    id: first.id,
    login: first.login,
    displayName: first.display_name,
    profileImageUrl: first.profile_image_url,
    createdAt: first.created_at ?? '',
  };
}

export type TwitchStreamStatus = {
  isLive: boolean;
  startedAt?: string;
  title?: string;
  gameName?: string;
};

// Batch variant for the polling loop (段階 X2). Twitch's
// `helix/streams` endpoint accepts up to 100 user_id query params per
// call and returns ONLY currently-live streams in `data[]` (offline
// users are silently omitted). That makes the response itself a
// "who's live right now" set we can intersect against the monitored-
// creators list.
//
// Returns a Map keyed by user_id → `TwitchStreamStatus` for every
// returned (= live) entry. Callers iterate their full input list and
// look up here; missing keys = not live.
export type TwitchLiveStream = TwitchStreamStatus & {
  isLive: true;
  userId: string;
  thumbnailUrl?: string;
};

export async function getLiveStreams(
  clientId: string,
  clientSecret: string,
  userIds: string[],
): Promise<Map<string, TwitchLiveStream>> {
  const out = new Map<string, TwitchLiveStream>();
  if (userIds.length === 0) return out;

  // Chunk to 100 ids per call per Twitch's documented cap. In practice
  // the user-facing monitored-creators list won't hit 100 for years,
  // but the loop is cheap and correct.
  console.log(`[twitch-poll] querying user_ids: [${userIds.join(', ')}]`);
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100);
    const qs = chunk.map((id) => `user_id=${encodeURIComponent(id)}`).join('&');
    const result = await helixGetWithRefresh<{
      data: Array<{
        id?: string;
        user_id?: string;
        user_login?: string;
        user_name?: string;
        started_at?: string;
        title?: string;
        game_name?: string;
        type?: string;
        thumbnail_url?: string;
      }>;
    }>(clientId, clientSecret, `/streams?${qs}`);
    if (result.status === 'not-found') continue;
    const responseUserIds: string[] = [];
    for (const s of result.data.data) {
      if (!s.user_id) continue;
      responseUserIds.push(s.user_id);
      // Extra diagnostics: log type ('live' / '' for unlisted) and
      // user_login alongside user_id so the user can sanity-check the
      // mapping in the terminal. type='' historically means unlisted
      // / restricted, which `helix/streams` STILL returns — so
      // unlisted streams should be visible here. If we see type=''
      // for a known-live creator that is the smoking gun.
      console.log(
        `[twitch-poll] response entry: user_id=${s.user_id}, user_login=${s.user_login ?? '?'}, ` +
          `type=${s.type ?? '?'}, title=${(s.title ?? '').slice(0, 40)}`,
      );
      out.set(s.user_id, {
        isLive: true,
        userId: s.user_id,
        startedAt: s.started_at,
        title: s.title,
        gameName: s.game_name,
        // thumbnail_url from Helix uses `{width}x{height}` placeholders
        // — caller substitutes (or drops) per render context.
        thumbnailUrl: s.thumbnail_url,
      });
    }
    // Per-chunk missing log so the user can spot which user_ids the
    // API didn't return as live. Common causes:
    //   - the user IS offline right now
    //   - the user_id we have is stale / wrong (renamed account, or
    //     the X1 Gemini-driven registration looked up the wrong handle)
    //   - the streamer is doing a privated / scheduled-but-not-yet-live
    //     stream
    const missing = chunk.filter((id) => !responseUserIds.includes(id));
    if (missing.length > 0) {
      console.log(`[twitch-poll] missing (not in response): [${missing.join(', ')}]`);
    }
  }
  return out;
}

// 段階 X3 — find the most recently archived VOD for a Twitch user.
// Used right after a live stream ends to discover the URL of the
// post-stream archive (which is what yt-dlp's VOD downloader can
// fetch in higher quality). Twitch publishes archives a few seconds
// to a few minutes after a stream ends; the caller is responsible
// for retry-with-backoff on null returns.
export type TwitchArchiveVod = {
  videoId: string;
  url: string; // https://www.twitch.tv/videos/<id>
  publishedAt: string;
  title: string;
  durationSec: number | null;
};

function parseTwitchDuration(d: string | undefined): number | null {
  // Twitch returns durations like "3h12m45s". Convert to seconds.
  if (!d) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  const total = h * 3600 + min * 60 + s;
  return Number.isFinite(total) ? total : null;
}

export async function getLatestArchiveVod(
  clientId: string,
  clientSecret: string,
  userId: string,
): Promise<TwitchArchiveVod | null> {
  // type=archive filters to the auto-saved post-stream VOD (as
  // opposed to highlight / upload). first=1 gives us the newest one.
  const result = await helixGetWithRefresh<{
    data: Array<{
      id?: string;
      url?: string;
      published_at?: string;
      title?: string;
      duration?: string;
    }>;
  }>(
    clientId,
    clientSecret,
    `/videos?user_id=${encodeURIComponent(userId)}&type=archive&first=1`,
  );
  if (result.status === 'not-found') return null;
  const v = result.data.data[0];
  if (!v?.id) return null;
  return {
    videoId: v.id,
    url: v.url ?? `https://www.twitch.tv/videos/${v.id}`,
    publishedAt: v.published_at ?? new Date().toISOString(),
    title: v.title ?? '',
    durationSec: parseTwitchDuration(v.duration),
  };
}

// 2026-05-04 (hybrid creator search) — fuzzy channel search by name.
// /helix/search/channels does substring matching against display name
// and login, returning up to `first` candidates. Used as a fallback
// when Gemini-driven login lookup fails / returns null. The endpoint
// does NOT include follower count; callers enrich via
// getTwitchFollowerCount() per candidate (cheap — 1 unit each).
export type TwitchChannelHit = {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  broadcasterLanguage: string;
  isLive: boolean;
};

export async function searchTwitchChannels(
  clientId: string,
  clientSecret: string,
  query: string,
  first: number = 10,
): Promise<TwitchChannelHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const qs = new URLSearchParams({
    query: trimmed,
    first: String(Math.max(1, Math.min(100, first))),
  });
  const result = await helixGetWithRefresh<{
    data: Array<{
      id?: string;
      broadcaster_login?: string;
      display_name?: string;
      thumbnail_url?: string;
      broadcaster_language?: string;
      is_live?: boolean;
    }>;
  }>(clientId, clientSecret, `/search/channels?${qs.toString()}`);
  if (result.status === 'not-found') return [];
  const out: TwitchChannelHit[] = [];
  for (const r of result.data.data) {
    if (!r.id || !r.broadcaster_login) continue;
    out.push({
      userId: r.id,
      login: r.broadcaster_login,
      displayName: r.display_name ?? r.broadcaster_login,
      profileImageUrl: r.thumbnail_url ?? '',
      broadcasterLanguage: r.broadcaster_language ?? '',
      isLive: r.is_live === true,
    });
  }
  return out;
}

export async function getStreamStatus(
  clientId: string,
  clientSecret: string,
  userId: string,
): Promise<TwitchStreamStatus> {
  // /helix/streams returns an empty data[] when the user is offline.
  // We translate that into `{ isLive: false }` rather than null so the
  // caller has a single shape to handle.
  const result = await helixGetWithRefresh<{
    data: Array<{
      started_at?: string;
      title?: string;
      game_name?: string;
    }>;
  }>(clientId, clientSecret, `/streams?user_id=${encodeURIComponent(userId)}`);
  if (result.status === 'not-found') return { isLive: false };
  const first = result.data.data[0];
  if (!first) return { isLive: false };
  return {
    isLive: true,
    startedAt: first.started_at,
    title: first.title,
    gameName: first.game_name,
  };
}

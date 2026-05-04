import { readFileSync } from 'node:fs';
import type { ChatMessage } from '../../common/types';

// Twitch's public web client ID. Same value yt-dlp's twitch.py extractor
// uses; safe to embed because it's the credential that twitch.tv itself
// ships in its first-party JS bundles. NO authentication is required for
// public VOD chat — the Client-ID alone is sufficient.
//
// If this gets revoked we'll see a flood of 401s and need to roll a new
// one (extract from twitch.tv's `static.twitchcdn.net/config/...` JSON
// or copy yt-dlp's latest).
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';

// Persisted query hash for `VideoCommentsByOffsetOrCursor`. Twitch
// rotates these occasionally — when the GraphQL endpoint starts
// returning `PersistedQueryNotFound`, sync this with the value yt-dlp
// is currently using (search yt-dlp's source for the operation name).
const VIDEO_COMMENTS_QUERY_HASH =
  'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

// Throttle between successive page requests. Twitch's GraphQL gateway
// will 429 us if we burst (~10 req/s observed cap on this endpoint
// historically). 600ms keeps us well under that and at ~100 messages
// per page yields ~10K msg/min — fast enough that a 4-hour stream's
// chat (~30-50K messages) finishes in 3-5 min.
const PAGE_THROTTLE_MS = 600;

// Backoff for 429s. Linear since we're already throttled — exponential
// would be overkill at this volume.
const RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;

// Soft cap on pages so a misbehaving response (cursor never goes null)
// can't loop forever. 5000 pages × ~100 msgs = 500K messages, far above
// any realistic VOD's chat volume.
const MAX_PAGES = 5000;

// Parse a Netscape-format cookies.txt and emit a `Cookie:` header value
// containing only the entries whose domain matches `*twitch.tv*`.
//
// Why we only filter domain (not name): Twitch's integrity gateway
// inspects multiple cookies (auth-token, persistent, twilight-user,
// unique_id, etc.) and the exact set varies by login state. Forwarding
// the whole twitch.tv set is the safest play and matches what a real
// browser session sends.
//
// Security: we deliberately do NOT log values, only count + names.
// The file content holds session credentials and must never reach
// stdout / log files.
function readTwitchCookieHeader(cookiesFile: string | null): string | null {
  if (!cookiesFile) return null;
  let content: string;
  try {
    content = readFileSync(cookiesFile, 'utf8');
  } catch (err) {
    console.warn('[twitch-graphql] failed to read cookies file:', (err as Error).message);
    return null;
  }
  const cookies: string[] = [];
  const seenNames = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine;
    if (!line.trim()) continue;
    // `#HttpOnly_` is a yt-dlp/curl convention prefix that lives ON the
    // domain field — strip it before pattern-matching. Comment lines
    // start with `#` (not `#HttpOnly_`).
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const lineForParse = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    const parts = lineForParse.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0]!;
    const name = parts[5]!;
    const value = parts[6]!;
    if (!domain.includes('twitch.tv')) continue;
    if (!name) continue;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    cookies.push(`${name}=${value}`);
  }
  if (cookies.length === 0) return null;
  // Only log NAMES, never values.
  console.log(
    `[twitch-graphql] loaded ${cookies.length} twitch cookies: ${[...seenNames].join(', ')}`,
  );
  return cookies.join('; ');
}

// Cancellation gate. The activeAbort is set on entry to fetchTwitchVodChat
// and cleared on exit; cancelTwitchVodChat aborts whichever fetch is in
// flight + breaks the paging loop on the next iteration.
let activeAbort: AbortController | null = null;
let cancelRequested = false;

type GqlEdge = {
  node?: {
    id?: string;
    contentOffsetSeconds?: number;
    commenter?: { displayName?: string } | null;
    message?: { fragments?: Array<{ text?: string }> | null } | null;
  } | null;
  cursor?: string | null;
};

type GqlResponse = {
  data?: {
    video?: {
      comments?: {
        edges?: GqlEdge[] | null;
        pageInfo?: { hasNextPage?: boolean } | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }> | null;
};

function buildBody(vodId: string, cursor: string | null): string {
  return JSON.stringify({
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: cursor != null
      ? { videoID: vodId, cursor }
      : { videoID: vodId, contentOffsetSeconds: 0 },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: VIDEO_COMMENTS_QUERY_HASH,
      },
    },
  });
}

async function fetchPage(
  vodId: string,
  cursor: string | null,
  signal: AbortSignal,
  cookieHeader: string | null,
): Promise<{ status: 'ok'; edges: GqlEdge[]; hasNextPage: boolean }
  | { status: 'rate-limit' }
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'integrity' }
  | { status: 'error'; message: string }> {
  const headers: Record<string, string> = {
    'Client-ID': TWITCH_CLIENT_ID,
    'Content-Type': 'application/json',
  };
  if (cookieHeader) headers['Cookie'] = cookieHeader;
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: buildBody(vodId, cursor),
    signal,
  });

  if (res.status === 429) return { status: 'rate-limit' };
  if (res.status === 404) return { status: 'not-found' };
  if (res.status === 401 || res.status === 403) return { status: 'forbidden' };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { status: 'error', message: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const json = (await res.json()) as GqlResponse;
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message ?? '').join('; ');
    // Specific check for hash rotation — Twitch returns this with HTTP
    // 200 + an errors[] entry, so we can't catch it via status code.
    if (/PersistedQueryNotFound|persisted query/i.test(msg)) {
      return {
        status: 'error',
        message: `Twitch GraphQL hash rejected (PersistedQueryNotFound). The hardcoded VIDEO_COMMENTS_QUERY_HASH likely needs updating to match yt-dlp's current value.`,
      };
    }
    // Twitch's integrity gateway rejects unauthenticated GraphQL after
    // ~1 page on most VODs. Detected as an `errors[]` entry containing
    // "failed integrity check". Caller logs a cookie-aware suggestion;
    // we return a distinct status so the caller can differentiate
    // recoverable vs. permanent errors.
    if (/failed integrity check|integrity/i.test(msg)) {
      return { status: 'integrity' };
    }
    return { status: 'error', message: msg };
  }

  const comments = json.data?.video?.comments;
  const edges = (comments?.edges ?? []).filter((e): e is GqlEdge => e != null);
  const hasNextPage = comments?.pageInfo?.hasNextPage === true;
  return { status: 'ok', edges, hasNextPage };
}

function edgeToMessage(edge: GqlEdge): ChatMessage | null {
  const node = edge.node;
  if (!node) return null;
  const offset = node.contentOffsetSeconds;
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
  const fragments = node.message?.fragments ?? [];
  const text = fragments
    .map((f) => (typeof f?.text === 'string' ? f.text : ''))
    .join('')
    .trim();
  if (!text) return null;
  return {
    timeSec: offset,
    text,
    author: node.commenter?.displayName ?? '',
    platform: 'twitch',
  };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Fetches the full VOD chat replay via Twitch's public GraphQL gateway.
 * Pages are pulled sequentially with a small throttle; on 429 we back
 * off and retry up to MAX_RATE_LIMIT_RETRIES times before giving up
 * on the run.
 *
 * Returns an empty array (not throws) for "no chat found" cases:
 * - 404 from the endpoint (VOD deleted / never had chat archived)
 * - 401/403 (sub-only or muted VOD — caller has no cookie to forward yet)
 * - PersistedQueryNotFound (caller logs and surfaces upstream so we
 *   notice and patch the hash)
 *
 * Throws only on abort or unexpected network errors.
 */
export async function fetchTwitchVodChat(
  vodId: string,
  options?: { cookiesFile?: string | null },
): Promise<ChatMessage[]> {
  if (activeAbort) {
    // Replace any in-flight run — analyzeComments dedupes its own
    // callers so we shouldn't see overlap, but be defensive.
    activeAbort.abort();
  }
  const ac = new AbortController();
  activeAbort = ac;
  cancelRequested = false;

  // Read cookies once at start. The Cookie header is constant for the
  // lifetime of the run; re-reading per page would just amplify a
  // potential mid-run filesystem race for no benefit.
  const cookieHeader = readTwitchCookieHeader(options?.cookiesFile ?? null);
  const cookieMode = cookieHeader ? 'set' : 'none';

  const messages: ChatMessage[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let rateLimitRetries = 0;

  console.log(`[comment-debug] twitch graphql start vodId=${vodId} cookies=${cookieMode}`);

  try {
    while (pageCount < MAX_PAGES) {
      if (cancelRequested) {
        console.log('[comment-debug] twitch graphql cancelled');
        break;
      }

      const result = await fetchPage(vodId, cursor, ac.signal, cookieHeader);

      if (result.status === 'rate-limit') {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          console.warn(
            `[chat-replay] twitch GraphQL: gave up after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries`,
          );
          break;
        }
        rateLimitRetries += 1;
        console.warn(
          `[chat-replay] twitch GraphQL: 429, backing off ${RATE_LIMIT_BACKOFF_MS}ms (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`,
        );
        await sleep(RATE_LIMIT_BACKOFF_MS, ac.signal);
        continue;
      }

      if (result.status === 'not-found') {
        console.warn(
          `[chat-replay] twitch GraphQL: VOD ${vodId} not found (deleted or chat never archived)`,
        );
        break;
      }

      if (result.status === 'forbidden') {
        console.warn(
          `[chat-replay] twitch GraphQL: VOD ${vodId} forbidden (sub-only or restricted; cookies=${cookieMode})`,
        );
        break;
      }

      if (result.status === 'integrity') {
        // Twitch's integrity gateway. The first page typically slips
        // through unauthenticated (cached or trivially fingerprinted)
        // but ~page 2+ trip a check. Cookies bypass it because the
        // logged-in session has a longer-lived trust signal.
        if (cookieHeader) {
          console.warn(
            `[chat-replay] twitch GraphQL: failed integrity check (cookies=set). ` +
              `Cookies may have expired; re-export from the browser and update settings.`,
          );
        } else {
          console.warn(
            `[chat-replay] twitch GraphQL: failed integrity check (cookies=none). ` +
              `Set Twitch cookies in settings to bypass this gate.`,
          );
        }
        break;
      }

      if (result.status === 'error') {
        console.warn(`[chat-replay] twitch GraphQL: ${result.message}`);
        break;
      }

      // ok
      rateLimitRetries = 0;
      pageCount += 1;
      let added = 0;
      for (const edge of result.edges) {
        const msg = edgeToMessage(edge);
        if (msg) {
          messages.push(msg);
          added += 1;
        }
      }
      // Cursor for the NEXT page = last edge's cursor. If hasNextPage
      // is false we're done; if it's true but the array was empty we
      // also bail (defensive — Twitch shouldn't do this but we don't
      // want to spin).
      const lastCursor = result.edges[result.edges.length - 1]?.cursor ?? null;
      console.log(
        `[comment-debug] twitch graphql page ${pageCount}, +${added} msgs, total=${messages.length}, hasNext=${result.hasNextPage}`,
      );
      if (!result.hasNextPage || !lastCursor) break;
      cursor = lastCursor;

      await sleep(PAGE_THROTTLE_MS, ac.signal);
    }
  } catch (err) {
    if (cancelRequested || (err instanceof Error && err.message === 'aborted')) {
      console.log('[comment-debug] twitch graphql aborted');
    } else {
      console.warn('[chat-replay] twitch GraphQL: unexpected error:', err);
    }
  } finally {
    if (activeAbort === ac) activeAbort = null;
  }

  // De-duplication safety: same node id can appear at the page boundary
  // when Twitch's cursor implementation overlaps. Cheap pass over a Set.
  const seen = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const m of messages) {
    const key = `${m.timeSec.toFixed(3)}|${m.author}|${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  // Safety: ensure ordering by time. Twitch's GraphQL returns in order
  // already but the dedupe step doesn't preserve that strictly.
  deduped.sort((a, b) => a.timeSec - b.timeSec);

  console.log(
    `[comment-debug] twitch graphql done: pages=${pageCount}, raw=${messages.length}, deduped=${deduped.length}`,
  );
  return deduped;
}

export function cancelTwitchVodChat(): void {
  cancelRequested = true;
  if (activeAbort) activeAbort.abort();
}

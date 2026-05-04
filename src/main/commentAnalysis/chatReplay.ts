import { app } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ChatMessage } from '../../common/types';
import type { YtdlpCookiesBrowser } from '../../common/config';
import { getCookiesArgs } from '../urlDownload';
import { fetchTwitchVodChat, cancelTwitchVodChat } from './twitchGraphQL';

let activeProcess: ChildProcess | null = null;

const ytdlpPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe')
    : path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');

const cacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'comment-analysis');
  return dir;
};

// Extract a stable per-video ID we can key the cache on. Returns null for
// platforms we don't support yet — caller falls back to no chat.
export function extractVideoId(url: string): { id: string; platform: 'youtube' | 'twitch' } | null {
  // YouTube: ?v=ID, /live/ID, /shorts/ID, youtu.be/ID
  const ytWatch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (ytWatch) return { id: ytWatch[1]!, platform: 'youtube' };
  const ytLive = url.match(/youtube\.com\/live\/([A-Za-z0-9_-]{11})/);
  if (ytLive) return { id: ytLive[1]!, platform: 'youtube' };
  const ytShort = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (ytShort) return { id: ytShort[1]!, platform: 'youtube' };
  // Twitch VOD: /videos/<numeric>
  const twVod = url.match(/twitch\.tv\/videos\/(\d+)/);
  if (twVod) return { id: twVod[1]!, platform: 'twitch' };
  // Twitch /<channel>/v/<num> legacy form
  const twLegacy = url.match(/twitch\.tv\/[^/]+\/v\/(\d+)/);
  if (twLegacy) return { id: twLegacy[1]!, platform: 'twitch' };
  return null;
}

const cacheFile = (videoId: string): string =>
  path.join(cacheDir(), `${videoId}-chat.json`);

async function readCache(videoId: string): Promise<ChatMessage[] | null> {
  try {
    const raw = await fs.readFile(cacheFile(videoId), 'utf8');
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(videoId: string, messages: ChatMessage[]): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cacheFile(videoId), JSON.stringify(messages), 'utf8');
}

// yt-dlp dumps live_chat as JSONL: one JSON object per line, the raw
// `replayChatItemAction` envelope from YouTube's chat API. Format ref:
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py
function parseYouTubeLine(line: string): ChatMessage | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const replay = obj['replayChatItemAction'] as Record<string, unknown> | undefined;
    if (!replay) return null;
    const offsetMsRaw = replay['videoOffsetTimeMsec'];
    const offsetMs = typeof offsetMsRaw === 'string' ? Number.parseInt(offsetMsRaw, 10) : NaN;
    if (!Number.isFinite(offsetMs)) return null;

    const actions = replay['actions'] as unknown[] | undefined;
    if (!Array.isArray(actions) || actions.length === 0) return null;

    // The first `addChatItemAction` is the message; ignore tickers / pins /
    // memberships / superchats for MVP.
    for (const a of actions) {
      const add = (a as Record<string, unknown>)['addChatItemAction'] as
        | Record<string, unknown>
        | undefined;
      const item = add?.['item'] as Record<string, unknown> | undefined;
      const renderer =
        (item?.['liveChatTextMessageRenderer'] as Record<string, unknown> | undefined) ??
        (item?.['liveChatPaidMessageRenderer'] as Record<string, unknown> | undefined);
      if (!renderer) continue;

      const message = renderer['message'] as Record<string, unknown> | undefined;
      const runs = (message?.['runs'] ?? []) as Array<Record<string, unknown>>;
      const text = runs
        .map((r) => (typeof r['text'] === 'string' ? (r['text'] as string) : ''))
        .join('')
        .trim();

      const authorName = (renderer['authorName'] as Record<string, unknown> | undefined)?.[
        'simpleText'
      ];

      if (!text) continue;
      return {
        timeSec: offsetMs / 1000,
        text,
        author: typeof authorName === 'string' ? authorName : '',
        platform: 'youtube',
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Twitch's `rechat` JSON parser was retired in 段階 7 — the rechat
// endpoint started returning HTTP 404 in 2026-05 (Twitch deprecation),
// and Twitch chat now flows through the GraphQL path in
// `./twitchGraphQL.ts`. Kept this comment as a tombstone so the
// removal is visible in `git blame` if someone goes hunting for the
// old shape.

async function downloadYouTubeChatJson(args: {
  url: string;
  outDir: string;
  cookiesBrowser: YtdlpCookiesBrowser;
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
}): Promise<string | null> {
  // YouTube-only after 段階 7. Twitch was split out to twitchGraphQL.
  await fs.mkdir(args.outDir, { recursive: true });
  const outputTemplate = path.join(args.outDir, '%(id)s.%(ext)s');

  const ytArgs = [
    args.url,
    // platform='youtube' so the YouTube-specific cookie file (if set)
    // wins over the generic one. Twitch path runs through GraphQL —
    // it never reaches this function.
    ...getCookiesArgs({
      cookiesBrowser: args.cookiesBrowser,
      cookiesFile: args.cookiesFile,
      cookiesFileYoutube: args.cookiesFileYoutube,
      cookiesFileTwitch: null,
      platform: 'youtube',
    }),
    // YouTube's chat-replay subtitle resolution depends on the same
    // nsig pipeline that the format extraction uses. Without a JS
    // runtime, yt-dlp will sometimes return zero chat entries on videos
    // where chat IS published — same root cause as the audio/video
    // "Requested format is not available" issue. Forwarding `node`
    // keeps this on the supported path. See urlDownload.downloadVideo
    // for the broader rationale.
    '--js-runtimes', 'node',
    '--write-subs',
    '--sub-langs', 'live_chat',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '-o', outputTemplate,
  ];
  console.log('[comment-debug] yt-dlp command:', ytdlpPath(), ytArgs.join(' '));

  return new Promise<string | null>((resolve) => {
    const proc = spawn(ytdlpPath(), ytArgs);
    activeProcess = proc;
    let stderr = '';
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('exit', (code) => {
      activeProcess = null;
      console.log('[comment-debug] yt-dlp exit code:', code);
      console.log('[comment-debug] yt-dlp stdout (first 500):', stdout.slice(0, 500));
      console.log('[comment-debug] yt-dlp stderr (first 500):', stderr.slice(0, 500));
      if (code !== 0) {
        console.warn(`[chat-replay] yt-dlp exited ${code}: ${stderr.slice(-500)}`);
        resolve(null);
        return;
      }
      // yt-dlp writes `<id>.live_chat.json` (YT) or `<id>.<lang>.json`
      // (Twitch — usually `.rechat.json` but let's pattern-match).
      // Find the freshest matching file.
      fs.readdir(args.outDir)
        .then(async (entries) => {
          console.log('[comment-debug] outDir entries:', entries);
          const candidates = entries
            .filter((e) => e.endsWith('.live_chat.json'))
            .map((e) => path.join(args.outDir, e));
          console.log('[comment-debug] chat file candidates:', candidates);
          if (candidates.length === 0) {
            console.warn(`[chat-replay] no chat file found in ${args.outDir}`);
            resolve(null);
            return;
          }
          // Pick most recently modified.
          const stats = await Promise.all(
            candidates.map(async (p) => ({ path: p, mtime: (await fs.stat(p)).mtimeMs })),
          );
          stats.sort((a, b) => b.mtime - a.mtime);
          const winner = stats[0]?.path ?? null;
          if (winner) {
            try {
              const st = await fs.stat(winner);
              console.log('[comment-debug] chat file picked:', winner, 'size:', st.size);
            } catch {
              console.log('[comment-debug] chat file picked but stat failed:', winner);
            }
          }
          resolve(winner);
        })
        .catch((err) => {
          console.warn('[comment-debug] readdir failed:', err);
          resolve(null);
        });
    });
    proc.on('error', (err) => {
      activeProcess = null;
      console.warn('[chat-replay] yt-dlp error:', err.message);
      console.log('[comment-debug] yt-dlp spawn error:', err.message);
      resolve(null);
    });
  });
}

/**
 * Fetches and parses chat replay for the given URL. Returns an empty
 * array if the platform is unsupported or yt-dlp produced nothing
 * (private stream, no chat archived, etc.) — never throws for "no
 * chat" cases. Caller falls back to scoring without comment data.
 *
 * Cached at `userData/comment-analysis/<videoId>-chat.json`. TTL is
 * intentionally infinite — chat replay is immutable for archived
 * videos.
 */
export async function fetchChatReplay(
  url: string,
  options: {
    cookiesBrowser: YtdlpCookiesBrowser;
    cookiesFile: string | null;
    cookiesFileYoutube: string | null;
    cookiesFileTwitch: string | null;
  },
): Promise<ChatMessage[]> {
  console.log(
    '[comment-debug] fetchChatReplay entry, url:', url,
    'cookiesBrowser:', options.cookiesBrowser,
    'cookiesFile:', options.cookiesFile ?? '<none>',
    'cookiesFileYT:', options.cookiesFileYoutube ?? '<none>',
    'cookiesFileTW:', options.cookiesFileTwitch ?? '<none>',
  );
  const meta = extractVideoId(url);
  console.log('[comment-debug] extractVideoId result:', meta);
  if (!meta) {
    console.warn('[chat-replay] could not extract video id from URL:', url);
    return [];
  }

  const cached = await readCache(meta.id);
  if (cached) {
    console.log('[comment-debug] cache HIT for', meta.id, 'messages:', cached.length);
    console.log(`[chat-replay] cache hit ${meta.id}: ${cached.length} messages`);
    return cached;
  }
  console.log('[comment-debug] cache MISS for', meta.id, '- fetching');

  let messages: ChatMessage[];
  if (meta.platform === 'twitch') {
    // 段階 7: GraphQL direct fetch. Twitch's rechat endpoint started
    // returning HTTP 404 in 2026-05; the public GraphQL gateway with
    // a hardcoded persisted-query hash is the path yt-dlp itself has
    // also been using internally.
    //
    // 段階 8: forward Twitch cookies to bypass the integrity gateway
    // that 1-pages most unauthenticated runs. Priority follows the
    // same rule as yt-dlp's getCookiesArgs: platform-specific file
    // beats the generic file. The browser-cookie path is intentionally
    // NOT honoured here — `--cookies-from-browser` is a yt-dlp-only
    // surface and reusing it would require reimplementing DPAPI/
    // Chrome cookie-DB extraction in this codebase.
    const twitchCookiesFile = options.cookiesFileTwitch ?? options.cookiesFile;
    messages = await fetchTwitchVodChat(meta.id, { cookiesFile: twitchCookiesFile });
    if (messages.length > 0) {
      // Cache only on non-empty result. Empty might mean transient
      // failure (rate limit, hash rotation) where we'd rather re-try
      // on the next session than serve stale "no chat" forever.
      await writeCache(meta.id, messages);
    } else {
      console.log('[comment-debug] twitch graphql returned 0 messages, NOT writing cache');
    }
    console.log(`[chat-replay] twitch ${meta.id}: ${messages.length} messages`);
    return messages;
  }

  // YouTube path — yt-dlp `--sub-langs live_chat`. Per-invocation
  // tmpDir suffix prevents WinError 32 (sharing violation) from
  // back-to-back invocations on the same videoId; see comment in the
  // setDuration drift guard for the related upstream bug.
  const tmpDir = path.join(app.getPath('temp'), `jcut-chat-${meta.id}-${nanoid(8)}`);
  let downloadedPath: string | null = null;
  try {
    downloadedPath = await downloadYouTubeChatJson({
      url,
      outDir: tmpDir,
      cookiesBrowser: options.cookiesBrowser,
      cookiesFile: options.cookiesFile,
      cookiesFileYoutube: options.cookiesFileYoutube,
    });
    console.log('[comment-debug] downloadYouTubeChatJson result:', downloadedPath);
    if (!downloadedPath) {
      console.log('[comment-debug] returning [] without writing cache');
      return [];
    }

    const raw = await fs.readFile(downloadedPath, 'utf8');
    console.log('[comment-debug] chat file raw length:', raw.length, 'first 200 chars:', raw.slice(0, 200));
    const allLines = raw.split(/\r?\n/);
    console.log('[comment-debug] youtube parse: raw lines =', allLines.length);
    messages = allLines
      .map(parseYouTubeLine)
      .filter((m): m is ChatMessage => m != null);
    console.log('[comment-debug] youtube parsed messages =', messages.length);
    messages.sort((a, b) => a.timeSec - b.timeSec);

    console.log(`[chat-replay] youtube ${meta.id}: ${messages.length} messages`);
    await writeCache(meta.id, messages);
    return messages;
  } finally {
    // Cleanup temp dir regardless of success
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cancelChatReplay(): Promise<void> {
  // Cancel both transports — only one is in flight at any time, but
  // cancellation is idempotent on both so calling unconditionally is
  // simpler than tracking which platform is active.
  cancelTwitchVodChat();
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }
}

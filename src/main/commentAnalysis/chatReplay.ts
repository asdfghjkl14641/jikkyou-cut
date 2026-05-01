import { app } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../common/types';

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

// Twitch's `rechat` json from yt-dlp is a single JSON document with a
// `comments[]` array. Each entry has `content_offset_seconds`,
// `message.body`, `commenter.display_name` per the v5 API shape.
function parseTwitchJson(text: string): ChatMessage[] {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const comments = obj['comments'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(comments)) return [];
    const out: ChatMessage[] = [];
    for (const c of comments) {
      const offset = c['content_offset_seconds'];
      if (typeof offset !== 'number') continue;
      const message = c['message'] as Record<string, unknown> | undefined;
      const body = message?.['body'];
      if (typeof body !== 'string' || !body.trim()) continue;
      const commenter = c['commenter'] as Record<string, unknown> | undefined;
      const author = commenter?.['display_name'];
      out.push({
        timeSec: offset,
        text: body,
        author: typeof author === 'string' ? author : '',
        platform: 'twitch',
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function downloadChatJson(args: {
  url: string;
  platform: 'youtube' | 'twitch';
  outDir: string;
}): Promise<string | null> {
  // yt-dlp's --sub-langs token differs per platform: live_chat for YT,
  // rechat for Twitch.
  const subLang = args.platform === 'youtube' ? 'live_chat' : 'rechat';
  await fs.mkdir(args.outDir, { recursive: true });
  const outputTemplate = path.join(args.outDir, '%(id)s.%(ext)s');

  return new Promise<string | null>((resolve) => {
    const proc = spawn(ytdlpPath(), [
      args.url,
      '--write-subs',
      '--sub-langs', subLang,
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '-o', outputTemplate,
    ]);
    activeProcess = proc;
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('exit', (code) => {
      activeProcess = null;
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
          const candidates = entries
            .filter((e) =>
              args.platform === 'youtube'
                ? e.endsWith('.live_chat.json')
                : e.endsWith('.json'),
            )
            .map((e) => path.join(args.outDir, e));
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
          resolve(stats[0]?.path ?? null);
        })
        .catch(() => resolve(null));
    });
    proc.on('error', (err) => {
      activeProcess = null;
      console.warn('[chat-replay] yt-dlp error:', err.message);
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
export async function fetchChatReplay(url: string): Promise<ChatMessage[]> {
  const meta = extractVideoId(url);
  if (!meta) {
    console.warn('[chat-replay] could not extract video id from URL:', url);
    return [];
  }

  const cached = await readCache(meta.id);
  if (cached) {
    console.log(`[chat-replay] cache hit ${meta.id}: ${cached.length} messages`);
    return cached;
  }

  const tmpDir = path.join(app.getPath('temp'), `jcut-chat-${meta.id}`);
  let downloadedPath: string | null = null;
  try {
    downloadedPath = await downloadChatJson({
      url,
      platform: meta.platform,
      outDir: tmpDir,
    });
    if (!downloadedPath) return [];

    const raw = await fs.readFile(downloadedPath, 'utf8');
    let messages: ChatMessage[];
    if (meta.platform === 'youtube') {
      messages = raw
        .split(/\r?\n/)
        .map(parseYouTubeLine)
        .filter((m): m is ChatMessage => m != null);
    } else {
      messages = parseTwitchJson(raw);
    }
    // Sort by timeSec just in case yt-dlp emits out of order.
    messages.sort((a, b) => a.timeSec - b.timeSec);

    console.log(
      `[chat-replay] ${meta.platform} ${meta.id}: ${messages.length} messages`,
    );
    await writeCache(meta.id, messages);
    return messages;
  } finally {
    // Cleanup temp dir regardless of success
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cancelChatReplay(): Promise<void> {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }
}

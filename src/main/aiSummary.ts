import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../common/types';
import { loadAnthropicSecret } from './secureStorage';

// Anthropic title-summarisation: per-segment one-line headlines for the
// clip-select edit flow. Uses the Haiku tier which is cheap enough that
// 30 segments cost a couple of cents.
//
// Cancellation: a single AbortController is shared across all in-flight
// fetches. `cancelAll()` aborts mid-batch.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const PARALLEL_LIMIT = 3;
const PER_REQUEST_TIMEOUT_MS = 30_000;
// Retry only 429 / 5xx; bail immediately on 4xx auth errors so the user
// gets fast feedback when the key is wrong.
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;

let activeAc: AbortController | null = null;

export type SummarySegment = {
  id: string;
  startSec: number;
  endSec: number;
  messages: ChatMessage[];
};

export type SummaryResult = {
  segmentId: string;
  title: string | null;
  error?: string;
};

// Cache entry — keyed by segment-bounds + comment count so the same
// segment hits cache verbatim, but a moved/resized segment re-generates.
type CacheEntry = {
  title: string;
  generatedAt: string;
};

type CacheFile = Record<string, CacheEntry>;

const cacheDir = () => path.join(app.getPath('userData'), 'comment-analysis');
const cacheFilePath = (videoKey: string) =>
  path.join(cacheDir(), `${videoKey}-summaries.json`);

// `videoKey` is whatever discriminates one analysis from another — we
// reuse the same cache file across all generations for a given video.
// The argument is supplied by the IPC layer; it falls back to "global"
// if unset (renderer might not have a stable key for local videos).
async function readCache(videoKey: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cacheFilePath(videoKey), 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCache(videoKey: string, cache: CacheFile): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cacheFilePath(videoKey), JSON.stringify(cache, null, 2), 'utf8');
}

// Stable, low-collision identity for "this segment with these
// comments". Floats are rounded to 2 decimals so a sub-frame drift
// during rendering doesn't bust the cache.
function segmentCacheKey(seg: SummarySegment): string {
  return `${seg.startSec.toFixed(2)}-${seg.endSec.toFixed(2)}-${seg.messages.length}`;
}

const PROMPT_PREAMBLE = `あなたはゲーム実況・配信切り抜きの編集者です。
以下のコメント群を見て、この区間で何が起きたかを **15 文字以内のキャッチーなタイトル** で表現してください。

ルール:
- 1 行のみ、改行なし、ピリオドや句点なし
- 視聴者が「見たい」と思える表現
- ネタバレ歓迎(切り抜きタイトルなので)
- カギカッコや絵文字は使わない

コメント:
`;

const formatTimeShort = (sec: number): string => {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

function buildPrompt(seg: SummarySegment): string {
  // Cap at 80 messages (most prominent 80) — Haiku has a generous
  // context but we don't need every comment to capture the vibe, and
  // shorter prompts cost less. Pick an even sample across the window
  // rather than just the head so the title reflects the whole arc.
  const messages = seg.messages;
  const cap = 80;
  let picked: ChatMessage[];
  if (messages.length <= cap) {
    picked = messages;
  } else {
    const stride = messages.length / cap;
    picked = [];
    for (let i = 0; i < cap; i += 1) {
      const m = messages[Math.floor(i * stride)];
      if (m) picked.push(m);
    }
  }
  const lines = picked
    .map((m) => `${formatTimeShort(m.timeSec)} ${m.text}`)
    .join('\n');
  return `${PROMPT_PREAMBLE}${lines}\n\nタイトル:`;
}

// Strip wrapper noise the model occasionally adds: leading "タイトル:"
// echo, surrounding quotes, trailing periods. Truncates over-long
// outputs to 30 chars (15 was the prompt cap; some models overshoot
// slightly — better to truncate than reject).
function cleanTitle(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^タイトル[::]\s*/, '');
  s = s.replace(/^["「『'`]+|["」』'`]+$/g, '');
  s = s.replace(/[。.]+$/, '');
  // Take only first line.
  const nl = s.indexOf('\n');
  if (nl >= 0) s = s.slice(0, nl).trim();
  if (s.length > 30) s = s.slice(0, 30);
  return s;
}

type CallOutcome =
  | { kind: 'ok'; title: string }
  | { kind: 'error'; message: string; status?: number };

async function callAnthropic(
  apiKey: string,
  prompt: string,
  signal: AbortSignal,
): Promise<CallOutcome> {
  // Combine our timeout with the caller signal so cancelAll() and
  // per-request deadlines both abort the in-flight fetch.
  const timeout = AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
  const combined = AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;

  let lastErr: { message: string; status?: number } | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 60,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: combined,
      });
      if (res.ok) {
        const json = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const text = json.content?.find((c) => c.type === 'text')?.text ?? '';
        const title = cleanTitle(text);
        if (!title) return { kind: 'error', message: '空の応答が返りました' };
        return { kind: 'ok', title };
      }
      // Auth / not-found: don't retry.
      if (res.status === 401 || res.status === 403) {
        return { kind: 'error', message: 'Anthropic API キーが無効です', status: res.status };
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = await res.text().catch(() => '');
        return { kind: 'error', message: `HTTP ${res.status}: ${body.slice(0, 200)}`, status: res.status };
      }
      // 429 / 5xx: retryable.
      lastErr = { message: `HTTP ${res.status}`, status: res.status };
    } catch (err) {
      if (signal.aborted) {
        return { kind: 'error', message: 'cancelled' };
      }
      lastErr = { message: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  return { kind: 'error', message: lastErr?.message ?? 'unknown', status: lastErr?.status };
}

/**
 * Lightweight ping for the Settings dialog "validate" button. Sends a
 * 1-token request — costs effectively nothing. Returns ok=true on 200,
 * ok=false with a localised error on 4xx, and surfaces the raw message
 * for unexpected codes so the user can debug.
 */
export async function validateAnthropicKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey || apiKey.trim().length < 10) {
    return { ok: false, error: 'APIキーの形式が不正です' };
  }
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'APIキーが認証されませんでした' };
    }
    if (res.status === 429) {
      return { ok: false, error: 'レート制限を超えました(キー自体は有効な可能性があります)' };
    }
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Run `worker(item)` for each item with bounded parallelism. `onSettle`
// fires for each item as it completes, in any order.
async function runParallel<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettle: (item: T, index: number, result: R) => void,
): Promise<void> {
  let cursor = 0;
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    lanes.push((async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) break;
        const item = items[idx]!;
        const result = await worker(item, idx);
        onSettle(item, idx, result);
      }
    })());
  }
  await Promise.all(lanes);
}

export async function generateSegmentTitles(
  videoKey: string,
  segments: SummarySegment[],
  onProgress: (done: number, total: number) => void,
): Promise<SummaryResult[]> {
  const apiKey = await loadAnthropicSecret();
  if (!apiKey) {
    return segments.map((s) => ({
      segmentId: s.id,
      title: null,
      error: 'Anthropic API キーが未設定です',
    }));
  }

  const cache = await readCache(videoKey);
  const ac = new AbortController();
  activeAc = ac;
  const results: SummaryResult[] = new Array(segments.length);

  let done = 0;
  onProgress(0, segments.length);

  try {
    await runParallel(
      segments,
      PARALLEL_LIMIT,
      async (seg): Promise<SummaryResult> => {
        if (ac.signal.aborted) {
          return { segmentId: seg.id, title: null, error: 'cancelled' };
        }
        const cacheKey = segmentCacheKey(seg);
        const cached = cache[cacheKey];
        if (cached) {
          return { segmentId: seg.id, title: cached.title };
        }
        const prompt = buildPrompt(seg);
        const outcome = await callAnthropic(apiKey, prompt, ac.signal);
        if (outcome.kind === 'ok') {
          cache[cacheKey] = {
            title: outcome.title,
            generatedAt: new Date().toISOString(),
          };
          return { segmentId: seg.id, title: outcome.title };
        }
        return { segmentId: seg.id, title: null, error: outcome.message };
      },
      (seg, idx, result) => {
        results[idx] = result;
        done += 1;
        onProgress(done, segments.length);
      },
    );
    // Persist cache on the way out — even partial successes get saved.
    await writeCache(videoKey, cache);
    return results;
  } finally {
    if (activeAc === ac) activeAc = null;
  }
}

export function cancelAll(): void {
  activeAc?.abort();
}

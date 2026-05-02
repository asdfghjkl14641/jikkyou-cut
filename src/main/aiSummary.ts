import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AutoExtractProgress,
  AutoExtractResult,
  ChatMessage,
  ClipSegment,
  RawBucket,
} from '../common/types';
import type { ReactionCategory } from '../common/commentAnalysis/keywords';
import { loadAnthropicSecret } from './secureStorage';
import { detectPeakCandidates, type PeakCandidate } from './commentAnalysis/peakDetection';

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

type RawCallOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; message: string; status?: number };

// Raw Anthropic call. Returns the model's text content untreated. The
// title-summarisation path layers cleanTitle() on top; refine uses it
// directly to parse JSON. Same retry/timeout policy either way.
async function callAnthropicRaw(
  apiKey: string,
  prompt: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<RawCallOutcome> {
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
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: combined,
      });
      if (res.ok) {
        const json = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const text = json.content?.find((c) => c.type === 'text')?.text ?? '';
        return { kind: 'ok', text };
      }
      if (res.status === 401 || res.status === 403) {
        return { kind: 'error', message: 'Anthropic API キーが無効です', status: res.status };
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = await res.text().catch(() => '');
        return { kind: 'error', message: `HTTP ${res.status}: ${body.slice(0, 200)}`, status: res.status };
      }
      lastErr = { message: `HTTP ${res.status}`, status: res.status };
    } catch (err) {
      if (signal.aborted) return { kind: 'error', message: 'cancelled' };
      lastErr = { message: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  return { kind: 'error', message: lastErr?.message ?? 'unknown', status: lastErr?.status };
}

// Title-flavoured wrapper. Kept as a function for back-compat with the
// existing per-segment generation path.
async function callAnthropic(
  apiKey: string,
  prompt: string,
  signal: AbortSignal,
): Promise<CallOutcome> {
  const raw = await callAnthropicRaw(apiKey, prompt, 60, signal);
  if (raw.kind === 'error') return raw;
  const title = cleanTitle(raw.text);
  if (!title) return { kind: 'error', message: '空の応答が返りました' };
  return { kind: 'ok', title };
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

// ===========================================================================
// Stage 2 (refine) + Auto-extract orchestrator
// ===========================================================================

export type RefinedCandidate = {
  startSec: number;
  endSec: number;
  reason: string;
  predictedTitle: string;
};

// How many comments per candidate go into the refine prompt. Cap is
// per the spec — Haiku has plenty of context but pruning keeps the
// signal-to-noise ratio high and the bill low.
const REFINE_MSG_CAP_PER_CANDIDATE = 30;
// Per-author dedup so a single spam streak (`88888888888888...`) doesn't
// dominate one candidate's summary. Each author contributes at most this
// many messages within a single candidate.
const REFINE_MAX_MSGS_PER_AUTHOR = 2;

const REFINE_MAX_TOKENS = 800;

const refineCacheFilePath = (videoKey: string): string =>
  path.join(cacheDir(), `${videoKey}-extractions.json`);

type RefineCacheEntry = {
  refined: RefinedCandidate[];
  generatedAt: string;
};
type RefineCacheFile = Record<string, RefineCacheEntry>;

async function readRefineCache(videoKey: string): Promise<RefineCacheFile> {
  try {
    const raw = await fs.readFile(refineCacheFilePath(videoKey), 'utf8');
    return JSON.parse(raw) as RefineCacheFile;
  } catch {
    return {};
  }
}

async function writeRefineCache(videoKey: string, cache: RefineCacheFile): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(refineCacheFilePath(videoKey), JSON.stringify(cache, null, 2), 'utf8');
}

// Cheap deterministic hash of the candidate pool. We only care that the
// same {startSec, endSec, msgLen} pool produces the same key — picking
// up rounding noise on startSec is fine because peakDetection uses
// bucket boundaries (multiples of 5s).
function refineCacheKey(candidates: PeakCandidate[], targetCount: number): string {
  const sig = candidates
    .map((c) => `${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}-${c.messages.length}`)
    .join('|');
  return `t${targetCount}-${sig}`;
}

// Sample up to `cap` messages evenly distributed across a window, with
// per-author dedup applied first. The dedup is a quick "skip if author
// has already contributed N messages" loop — preserves time order.
function sampleMessagesForPrompt(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];
  // Per-author dedup. Keep up to REFINE_MAX_MSGS_PER_AUTHOR per author
  // in time order.
  const seen = new Map<string, number>();
  const deduped: ChatMessage[] = [];
  for (const m of messages) {
    const n = seen.get(m.author) ?? 0;
    if (n >= REFINE_MAX_MSGS_PER_AUTHOR) continue;
    seen.set(m.author, n + 1);
    deduped.push(m);
  }
  if (deduped.length <= REFINE_MSG_CAP_PER_CANDIDATE) return deduped;
  // Even-stride sampling so the AI sees the start, middle, and end of
  // the window instead of just the head.
  const stride = deduped.length / REFINE_MSG_CAP_PER_CANDIDATE;
  const out: ChatMessage[] = [];
  for (let i = 0; i < REFINE_MSG_CAP_PER_CANDIDATE; i += 1) {
    const m = deduped[Math.floor(i * stride)];
    if (m) out.push(m);
  }
  return out;
}

function buildRefinePrompt(candidates: PeakCandidate[], targetCount: number): string {
  const candidateBlocks = candidates.map((c, i) => {
    const startMin = Math.floor(c.startSec / 60);
    const startSec = Math.floor(c.startSec) % 60;
    const endMin = Math.floor(c.endSec / 60);
    const endSec = Math.floor(c.endSec) % 60;
    const startStr = `${startMin}:${String(startSec).padStart(2, '0')}`;
    const endStr = `${endMin}:${String(endSec).padStart(2, '0')}`;
    const sampled = sampleMessagesForPrompt(c.messages);
    const msgLines = sampled
      .map((m) => `${formatTimeShort(m.timeSec)} ${m.text}`)
      .join('\n');
    // We embed the *exact* startSec/endSec in the header so the model
    // can copy them verbatim into the JSON output. The instruction also
    // requires the values to match — we validate after parsing.
    return (
      `=== 候補 ${i + 1} (時刻 ${startStr}-${endStr}, スコア ${c.totalScore.toFixed(2)}, ` +
      `start=${c.startSec}, end=${c.endSec}) ===\n${msgLines || '(コメントなし)'}`
    );
  }).join('\n\n');

  return `あなたはゲーム実況・配信切り抜きのプロ編集者です。
以下は「視聴者の盛り上がりが大きかった候補区間」のリスト(全 ${candidates.length} 個)です。
この中から「**切り抜き動画として独立して面白く、視聴者を引き込める**」ベスト ${targetCount} 個を選んでください。

選定基準(優先度順):
1. **起承転結がある**: 展開が完結していて、見終わった時に納得感がある
2. **ネタバレ的キャッチコピーがつけやすい**: 「神プレイ集」「死亡フラグ回収」等の物語性
3. **視聴者反応の質**: 単に密度が高いだけでなく、笑い・驚き・感動など感情の起伏がある
4. **配信文脈に依存しない**: この区間だけ見ても何が起きたか分かる

避けるべき:
- 配信導入 / 雑談繋ぎ
- 視聴者反応が少ないが盛り上がりに見える区間
- 同じパターンの繰り返し(似たシーンばかり選ばない)

候補リスト:
${candidateBlocks}

出力形式:
JSON 配列のみで出力。説明文・前置き・コードフェンス禁止。

[
  {
    "startSec": <候補の start 値をそのまま>,
    "endSec": <候補の end 値をそのまま>,
    "reason": "<なぜ選んだか、20 字程度>",
    "predictedTitle": "<15 字以内のキャッチータイトル>"
  },
  ...
]

重要:
- 必ず候補リストの startSec / endSec をそのまま使う(±0.1 秒の差も不可)
- ベスト ${targetCount} 個ピッタリ選ぶ(候補が少ない場合は候補数まで)
- predictedTitle は 15 文字以内、句点・カギカッコ・絵文字なし`;
}

// Strip code fences / leading prose the model occasionally adds even when
// told not to, then JSON.parse. Returns null on irrecoverable failure.
function tryParseRefineJson(text: string): unknown {
  let s = text.trim();
  // Strip ```json ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Sometimes the model writes "出力: [\n...]"; trim until we find the
  // first '[' or '{'
  const lb = s.indexOf('[');
  if (lb > 0) s = s.slice(lb);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Validate that each refined item references a real candidate by
// startSec/endSec (within ±0.1s) and clean its title. Items that don't
// match any candidate are dropped — the model will sometimes hallucinate
// timestamps even with explicit instructions.
function validateRefinedItems(
  parsed: unknown,
  candidates: PeakCandidate[],
): RefinedCandidate[] {
  if (!Array.isArray(parsed)) return [];
  const out: RefinedCandidate[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const startSec = typeof r['startSec'] === 'number' ? r['startSec'] : NaN;
    const endSec = typeof r['endSec'] === 'number' ? r['endSec'] : NaN;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    const matched = candidates.find(
      (c) => Math.abs(c.startSec - startSec) < 0.1 && Math.abs(c.endSec - endSec) < 0.1,
    );
    if (!matched) continue;
    const reasonRaw = typeof r['reason'] === 'string' ? r['reason'] : '';
    const titleRaw = typeof r['predictedTitle'] === 'string' ? r['predictedTitle'] : '';
    out.push({
      startSec: matched.startSec,
      endSec: matched.endSec,
      reason: reasonRaw.slice(0, 80),
      predictedTitle: cleanTitle(titleRaw) || '(タイトル未生成)',
    });
  }
  return out;
}

// Stage 2 fallback: when the AI step fails (parse error, network, etc.)
// pick the top-N candidates by totalScore in time order. predictedTitle
// stays blank — Stage 4 (generateSegmentTitles) fills it in.
function fallbackByScore(
  candidates: PeakCandidate[],
  targetCount: number,
): RefinedCandidate[] {
  return [...candidates]
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, targetCount)
    .sort((a, b) => a.startSec - b.startSec)
    .map((c) => ({
      startSec: c.startSec,
      endSec: c.endSec,
      reason: '(AI 精査スキップ、スコア順)',
      predictedTitle: '',
    }));
}

export async function refineCandidatesWithAI(
  videoKey: string,
  candidates: PeakCandidate[],
  targetCount: number,
): Promise<{ refined: RefinedCandidate[]; usedFallback: boolean; warning?: string }> {
  if (candidates.length === 0) {
    return { refined: [], usedFallback: false };
  }
  // If we have fewer candidates than the user asked for, just hand them
  // all back (skip the AI step — there's no "best of" to pick from).
  if (candidates.length <= targetCount) {
    return {
      refined: candidates.map((c) => ({
        startSec: c.startSec,
        endSec: c.endSec,
        reason: '(候補数 ≤ 目標数のため全採用)',
        predictedTitle: '',
      })),
      usedFallback: false,
    };
  }

  const apiKey = await loadAnthropicSecret();
  if (!apiKey) {
    return {
      refined: fallbackByScore(candidates, targetCount),
      usedFallback: true,
      warning: 'Anthropic API キーが未設定のため、スコア順で採用しました',
    };
  }

  // Cache check.
  const cache = await readRefineCache(videoKey);
  const cacheKey = refineCacheKey(candidates, targetCount);
  const cached = cache[cacheKey];
  if (cached) {
    return { refined: cached.refined, usedFallback: false };
  }

  const ac = new AbortController();
  activeAc = ac;
  try {
    const prompt = buildRefinePrompt(candidates, targetCount);
    const outcome = await callAnthropicRaw(apiKey, prompt, REFINE_MAX_TOKENS, ac.signal);
    if (outcome.kind === 'error') {
      console.warn('[ai-extract] refine API failed, falling back to score-order:', outcome.message);
      return {
        refined: fallbackByScore(candidates, targetCount),
        usedFallback: true,
        warning: `AI 精査に失敗: ${outcome.message}`,
      };
    }
    const parsed = tryParseRefineJson(outcome.text);
    const refined = validateRefinedItems(parsed, candidates).slice(0, targetCount);
    if (refined.length === 0) {
      console.warn('[ai-extract] refine produced 0 valid items, falling back');
      return {
        refined: fallbackByScore(candidates, targetCount),
        usedFallback: true,
        warning: 'AI 応答を解釈できませんでした、スコア順で採用しました',
      };
    }
    // Sort by time so downstream reads in chronological order.
    refined.sort((a, b) => a.startSec - b.startSec);
    cache[cacheKey] = { refined, generatedAt: new Date().toISOString() };
    await writeRefineCache(videoKey, cache).catch((err) => {
      console.warn('[ai-extract] failed to persist refine cache:', err);
    });
    return { refined, usedFallback: false };
  } finally {
    if (activeAc === ac) activeAc = null;
  }
}

// ===========================================================================
// Stage 1 + Stage 2 + Stage 4 in one shot: "give me 3-5 clip segments"
// ===========================================================================

const BUCKET_SIZE_SEC_DEFAULT = 5;

export async function autoExtractClipCandidates(
  args: {
    videoKey: string;
    buckets: RawBucket[];
    windowSec: number;
    hasViewerStats: boolean;
    videoDurationSec: number;
    targetCount: number;
  },
  onProgress: (p: AutoExtractProgress) => void,
): Promise<AutoExtractResult> {
  // Stage 1 — synchronous, sub-millisecond at typical sizes.
  onProgress({ phase: 'detect', percent: 0 });
  const candidates = detectPeakCandidates(
    args.buckets,
    args.windowSec,
    args.hasViewerStats,
    args.videoDurationSec,
    BUCKET_SIZE_SEC_DEFAULT,
  );
  onProgress({ phase: 'detect', percent: 100 });

  if (candidates.length === 0) {
    return {
      segments: [],
      warning: 'ピーク候補が見つかりませんでした(コメント数が少ないか、スコアが閾値未満です)',
    };
  }

  // Stage 2 — AI refine (10 → N).
  onProgress({ phase: 'refine', percent: 0 });
  const { refined, usedFallback, warning } = await refineCandidatesWithAI(
    args.videoKey,
    candidates,
    args.targetCount,
  );
  onProgress({ phase: 'refine', percent: 100 });

  if (refined.length === 0) {
    return { segments: [], warning: warning ?? 'AI 精査結果が空でした' };
  }

  // Stage 4 — title generation per refined segment. Re-uses the same
  // generateSegmentTitles path as the manual "AI でタイトル生成"
  // button so titles look consistent regardless of which entry-point
  // produced them.
  onProgress({ phase: 'titles', percent: 0 });
  const summarySegments: SummarySegment[] = refined.map((r) => {
    const original = candidates.find(
      (c) => Math.abs(c.startSec - r.startSec) < 0.1 && Math.abs(c.endSec - r.endSec) < 0.1,
    );
    return {
      id: `auto-${r.startSec.toFixed(2)}`,
      startSec: r.startSec,
      endSec: r.endSec,
      messages: original?.messages ?? [],
    };
  });
  const titleResults = await generateSegmentTitles(
    args.videoKey,
    summarySegments,
    (done, total) => {
      const percent = total > 0 ? Math.round((done / total) * 100) : 100;
      onProgress({ phase: 'titles', percent });
    },
  );

  // Build final ClipSegment shape. Title precedence:
  //   1. generateSegmentTitles result (Stage 4 official)
  //   2. predictedTitle from refine (Stage 2 draft)
  //   3. null (renderer shows "タイトル未設定" placeholder)
  const segments: Array<Omit<ClipSegment, 'id'>> = refined.map((r, i) => {
    const fromStage4 = titleResults[i]?.title ?? null;
    const fromStage2 = r.predictedTitle ? r.predictedTitle : null;
    const original = candidates.find(
      (c) => Math.abs(c.startSec - r.startSec) < 0.1 && Math.abs(c.endSec - r.endSec) < 0.1,
    );
    const dominantCategory: ReactionCategory | null = original?.dominantCategory ?? null;
    return {
      startSec: r.startSec,
      endSec: r.endSec,
      title: fromStage4 ?? fromStage2,
      dominantCategory,
    };
  });

  return {
    segments,
    ...(usedFallback && warning ? { warning } : {}),
  };
}

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AutoExtractProgress,
  AutoExtractResult,
  ChatMessage,
  ClipSegment,
  GeminiHighlightCandidate,
  GeminiTimelineSegment,
  RawBucket,
} from '../common/types';
import type { ReactionCategory } from '../common/commentAnalysis/keywords';
import { loadAnthropicSecret } from './secureStorage';
import { detectPeakCandidates, type PeakCandidate } from './commentAnalysis/peakDetection';
import type { GlobalPatterns } from './dataCollection/analyzer';
import { videoKeyToFilenameStem } from './utils';

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

// videoKeyToFilenameStem moved to utils.ts (shared with gemini.ts).
// Same purpose: flatten an absolute videoKey to a Windows-safe stem so
// path.join doesn't keep the right-hand side as an absolute and write
// to a malformed location.
const cacheFilePath = (videoKey: string) =>
  path.join(cacheDir(), `${videoKeyToFilenameStem(videoKey)}-summaries.json`);

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
  // Source attribution from the AI's `candidateIndex` field. Format:
  // 'C2' (comment peak only) / 'G1' (Gemini highlight only) /
  // 'C1+G3' (both pointed to roughly the same area). Used downstream
  // to decide which candidate pool to consult for messages and
  // dominantCategory. May be undefined for legacy / malformed
  // responses — downstream falls back to fuzzy bound matching.
  candidateIndex?: string;
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
  path.join(cacheDir(), `${videoKeyToFilenameStem(videoKey)}-extractions.json`);

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

// Cheap deterministic hash of the candidate pool + globalPatterns
// version + Gemini analysis. Task 2 (2026-05-03) folds in a hash of
// the Gemini highlights so a fresh Gemini run invalidates the cache.
// `geminiHash` is sha256 of JSON(highlights) sliced to 8 hex chars,
// or 'no-gemini' when the analysis didn't run.
function refineCacheKey(
  videoFileBasename: string,
  candidates: PeakCandidate[],
  targetCount: number,
  globalPatternsTs: string | null,
  geminiHash: string,
): string {
  const sig = candidates
    .map((c) => `${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}-${c.messages.length}`)
    .join('|');
  const ts = globalPatternsTs ?? 'no-pattern';
  return createHash('sha256')
    .update(`${videoFileBasename}|${sig}|t${targetCount}|${ts}|g=${geminiHash}`)
    .digest('hex')
    .slice(0, 12);
}

function geminiHashFor(highlights: GeminiHighlightCandidate[] | undefined): string {
  if (!highlights || highlights.length === 0) return 'no-gemini';
  const sig = highlights
    .map((h) => `${h.startSec.toFixed(1)}-${h.endSec.toFixed(1)}-${h.contentType}`)
    .join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 8);
}

// Read userData/patterns/global.json. Returns null when the file
// doesn't exist (pattern analysis hasn't been run yet) or when the
// content is unparseable. Callers degrade to a prompt without the
// pattern section in either case — same observable behaviour as M1.0.
export async function loadGlobalPatterns(): Promise<GlobalPatterns | null> {
  try {
    const p = path.join(app.getPath('userData'), 'patterns', 'global.json');
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as GlobalPatterns;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// View-boost gate — keep only keywords that correlate with above-
// average view counts. Replaced the earlier `freq >= 0.5` filter on
// 2026-05-03 because at the global-aggregate scale (1552 videos × 75
// creators × 5 groups) no single word reaches 50% — the freq filter
// admitted everything including boilerplate. Switching to the boost
// axis is also more semantically aligned: "伸びる動画にはこういう
// 単語が多い" is what the AI actually wants to know.
//
// 0.7 is calibrated against the current global.json: it admits the
// hashtag cluster (#切り抜き 1.70 / #shorts 1.49 / #にじさんじ 1.15)
// and "ぶいすぽ" (0.93) while rejecting the under-performers
// ("切り抜き" 0.65, "にじさんじ" 0.59, channel-name like "葛葉" 0.62).
const VIEW_BOOST_THRESHOLD = 0.7;
const PROMPT_KEYWORD_LIMIT = 5;

function buildPatternBlock(gp: GlobalPatterns): string {
  const tp = gp.patterns.titlePatterns;
  const dp = gp.patterns.durationPatterns;
  const pl = gp.patterns.peakLocationPatterns;

  // Keep keywords that lift view counts above average. The finite-
  // check protects against analyzer outputs where avg-view came out
  // 0 / NaN / Infinity — those land below threshold or get filtered
  // out outright, never reaching the prompt.
  //
  // Sort the survivors by viewBoost DESC so the highest-impact words
  // lead the section. The analyzer hands them in freq order, which
  // would put low-boost-but-frequent words first after filter.
  const filteredKeywords = tp.frequentKeywords
    .filter((k) => Number.isFinite(k.viewBoost) && k.viewBoost >= VIEW_BOOST_THRESHOLD)
    .slice()
    .sort((a, b) => b.viewBoost - a.viewBoost)
    .slice(0, PROMPT_KEYWORD_LIMIT);

  const keywordLines = filteredKeywords
    .map(
      (k) =>
        `  - ${k.word}: 出現率 ${(k.freq * 100).toFixed(1)}%, 視聴ブースト x${k.viewBoost.toFixed(2)}`,
    )
    .join('\n');

  const keywordSection = keywordLines
    ? `- 頻出キーワード(伸びる傾向のあるもの):\n${keywordLines}`
    : '- 頻出キーワード: (該当語なし)';

  return `

# 切り抜き動画一般の伸びパターン(過去 ${gp.totalAnalyzed} 動画から学習)
- タイトル長中央値: ${tp.lengthDist.median} 文字
- タイトル長 p90: ${tp.lengthDist.p90} 文字
- 絵文字使用率: ${(tp.emojiUsage * 100).toFixed(1)}%
${keywordSection}
- 切り抜き動画長中央値: ${dp.p50} 秒
- 切り抜き動画長 p90: ${dp.p90} 秒
- ピーク位置傾向:
  - 序盤フック(0-20%): ${(pl.earlyHook * 100).toFixed(1)}%
  - 中盤スパイク(20-70%): ${(pl.midSpike * 100).toFixed(1)}%
  - 終盤クライマックス(70-100%): ${(pl.endingClimax * 100).toFixed(1)}%
`;
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

function buildRefinePrompt(
  candidates: PeakCandidate[],
  targetCount: number,
  globalPatterns: GlobalPatterns | null,
  geminiHighlights?: GeminiHighlightCandidate[],
  geminiTimeline?: GeminiTimelineSegment[],
  // Kept as legacy plumbing — no current caller passes it. Reserved
  // for a possible per-creator follow-up if global aggregation ever
  // proves too coarse. Default undefined ⇒ unused.
  _creator?: { name: string; group: string },
): string {
  // M1.5b — global pattern context, when available. Filtered to drop
  // boilerplate keywords (freq >= 0.5) and defended against bad numerics
  // on viewBoost (NaN / Infinity slip through if the analyzer ran on
  // a video set with all-zero view counts).
  const patternBlock = globalPatterns ? buildPatternBlock(globalPatterns) : '';

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

  // Optional 5th selection criterion that references the pattern
  // block. Only emitted when patterns are present — without them the
  // criterion has nothing to anchor to.
  const patternCriterion = globalPatterns
    ? '\n5. **切り抜き動画一般の伸びパターンと整合する区間長・位置を優先**(下記パターンセクション参照)'
    : '';

  // Task 2 — Gemini integration. Build the highlight + timeline
  // sections + integration directive only when Gemini results are
  // present. When absent, the prompt falls back to the M1.5b shape
  // (just C-prefixed candidates).
  const hasGemini = !!geminiHighlights && geminiHighlights.length > 0;
  const geminiHighlightBlock = hasGemini
    ? `\n\n# 音声内容ベースのハイライト候補(Gemini 構造理解)\n` +
      `配信音声を分析した結果、以下が「内容として面白い」候補です。\n` +
      `コメント反応より内容そのものを重視した判定。\n\n` +
      geminiHighlights!
        .map((g, i) => {
          const dur = Math.max(0, Math.round(g.endSec - g.startSec));
          return (
            `候補 G${i + 1}: ${formatTimeShort(g.startSec)}-${formatTimeShort(g.endSec)} (${dur} 秒, ` +
            `start=${g.startSec}, end=${g.endSec})\n` +
            `  カテゴリ: ${g.contentType}\n` +
            `  自信度: ${g.confidence.toFixed(2)}\n` +
            `  理由: ${g.reason}`
          );
        })
        .join('\n\n')
    : '';

  const geminiTimelineBlock =
    hasGemini && geminiTimeline && geminiTimeline.length > 0
      ? `\n\n# 動画全体の構造(Gemini)\n` +
        geminiTimeline
          .map(
            (t) =>
              `- ${formatTimeShort(t.startSec)}-${formatTimeShort(t.endSec)}: ${t.description}`,
          )
          .join('\n')
      : '';

  const integrationCriterion = hasGemini
    ? `\n\n# 統合判断の指示\nコメントベース候補(C1, C2, ...)と音声ベース候補(G1, G2, ...)の両方を\n` +
      `考慮し、以下の観点で ${targetCount} 個を選んでください:\n` +
      `- 両方で言及されている区間は最優先(コメント + 内容の両軸で面白い)\n` +
      `- Gemini ハイライトのみ(コメント密度低めだが内容が面白い)= スポンサー後の盛り上がり、地味な神プレイ等を拾える\n` +
      `- コメントピークのみ(内容平凡だがコメントが盛り上がっている)= 通常は除外、ただし confidence が極端に高い場合のみ採用検討\n` +
      `- 既存の選定基準(カテゴリ多様性、区間長 15-90 秒、隣接重複回避、動画全体に分散)も維持`
    : '';

  // Output format — candidateIndex always required (string),
  // suggestedStart/End for the AI's preferred final bounds.
  return `あなたはゲーム実況・配信切り抜きのプロ編集者です。
以下は「視聴者の盛り上がりが大きかった候補区間」のリスト(全 ${candidates.length} 個)です。
この中から「**切り抜き動画として独立して面白く、視聴者を引き込める**」ベスト ${targetCount} 個を選んでください。
${patternBlock}
選定基準(優先度順):
1. **起承転結がある**: 展開が完結していて、見終わった時に納得感がある
2. **ネタバレ的キャッチコピーがつけやすい**: 「神プレイ集」「死亡フラグ回収」等の物語性
3. **視聴者反応の質**: 単に密度が高いだけでなく、笑い・驚き・感動など感情の起伏がある
4. **配信文脈に依存しない**: この区間だけ見ても何が起きたか分かる${patternCriterion}

避けるべき:
- 配信導入 / 雑談繋ぎ
- 視聴者反応が少ないが盛り上がりに見える区間
- 同じパターンの繰り返し(似たシーンばかり選ばない)

候補リスト(コメント反応ベース):
${candidateBlocks}${geminiHighlightBlock}${geminiTimelineBlock}${integrationCriterion}

出力形式:
JSON 配列のみで出力。説明文・前置き・コードフェンス禁止。

[
  {
    "candidateIndex": "<C1 / G1 / C1+G2 のいずれか>",
    "reason": "<なぜ選んだか、20 字程度>",
    "confidence": <0.0-1.0>,
    "suggestedStart": <秒、AI 判断で前後 5-10 秒の調整可>,
    "suggestedEnd": <秒、同上>,
    "predictedTitle": "<15 字以内のキャッチータイトル>"
  },
  ...
]

重要:
- candidateIndex は必ず候補リストの番号を引用(C1..C${candidates.length}${hasGemini ? ` / G1..G${geminiHighlights!.length}` : ''})
- suggestedStart / suggestedEnd は秒数で、対応候補の start/end を基準に前後 5-10 秒調整可
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

// Bound-tolerance for "this output is anchored to a real candidate".
// Task 2 prompt explicitly invites the AI to extend by ±5-10s for
// context, and we want to allow up to ~30s of latitude before rejecting
// as a hallucination. Any output outside this window of every C and G
// candidate is dropped.
const HALLUCINATION_TOLERANCE_SEC = 30;

// Validate that each refined item references a real candidate (by
// startSec ±tolerance OR by candidateIndex) and clean its title. Items
// outside tolerance of every candidate are dropped — the model still
// occasionally hallucinates timestamps even with explicit instructions.
function validateRefinedItems(
  parsed: unknown,
  candidates: PeakCandidate[],
  geminiHighlights?: GeminiHighlightCandidate[],
): RefinedCandidate[] {
  if (!Array.isArray(parsed)) return [];
  const out: RefinedCandidate[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    // Prefer suggestedStart/End (task 2 schema); fall back to legacy
    // startSec/endSec when an old cache entry replays through here.
    const start = pickFiniteNumber(r, 'suggestedStart', 'startSec');
    const end = pickFiniteNumber(r, 'suggestedEnd', 'endSec');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    // Anchor check: must be within tolerance of at least one C or G
    // candidate's start. This blocks gross hallucinations while
    // accepting the AI's ±5-10s context-extension nudges.
    const anchored = anyCandidateNear(start, candidates, geminiHighlights);
    if (!anchored) continue;

    const reasonRaw = typeof r['reason'] === 'string' ? r['reason'] : '';
    const titleRaw = typeof r['predictedTitle'] === 'string' ? r['predictedTitle'] : '';
    const idxRaw = typeof r['candidateIndex'] === 'string' ? r['candidateIndex'] : undefined;
    out.push({
      startSec: start,
      endSec: end,
      reason: reasonRaw.slice(0, 80),
      predictedTitle: cleanTitle(titleRaw) || '(タイトル未生成)',
      candidateIndex: idxRaw,
    });
  }
  return out;
}

// Parse the C-prefixed segment of a candidateIndex. Accepts "C3",
// "c3", "C1+G2" (returns 0 for the C1 part), or undefined. Returns
// null if no C-prefixed component is found. 1-based AI indices are
// converted to 0-based for direct array access.
function parseCommentIndex(idx: string | undefined): number | null {
  if (!idx) return null;
  const m = idx.match(/[Cc](\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return n - 1;
}

function pickFiniteNumber(r: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return NaN;
}

function anyCandidateNear(
  start: number,
  candidates: PeakCandidate[],
  geminiHighlights: GeminiHighlightCandidate[] | undefined,
): boolean {
  for (const c of candidates) {
    if (Math.abs(c.startSec - start) <= HALLUCINATION_TOLERANCE_SEC) return true;
  }
  if (geminiHighlights) {
    for (const g of geminiHighlights) {
      if (Math.abs(g.startSec - start) <= HALLUCINATION_TOLERANCE_SEC) return true;
    }
  }
  return false;
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
  globalPatterns: GlobalPatterns | null,
  geminiHighlights?: GeminiHighlightCandidate[],
  geminiTimeline?: GeminiTimelineSegment[],
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

  // Cache check. Folds in globalPatterns.lastUpdated and a hash of
  // Gemini highlights so a fresh pattern OR a fresh Gemini run forces
  // re-extraction (the prompt content changed).
  const cache = await readRefineCache(videoKey);
  const cacheKey = refineCacheKey(
    videoKey,
    candidates,
    targetCount,
    globalPatterns?.lastUpdated ?? null,
    geminiHashFor(geminiHighlights),
  );
  const cached = cache[cacheKey];
  if (cached) {
    return { refined: cached.refined, usedFallback: false };
  }

  const ac = new AbortController();
  activeAc = ac;
  try {
    const prompt = buildRefinePrompt(
      candidates,
      targetCount,
      globalPatterns,
      geminiHighlights,
      geminiTimeline,
    );
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
    const refined = validateRefinedItems(parsed, candidates, geminiHighlights).slice(
      0,
      targetCount,
    );
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
// Stage 1 + Stage 2 + Stage 4 in one shot: "give me 3-10 clip segments"
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
    // Reserved for future use — surfaced so renderer can keep sending
    // them without a wire-format change. M1.5b doesn't read them; the
    // global pattern feed replaces the per-creator prompt context.
    videoTitle?: string;
    channelName?: string;
    // Task 2 — Gemini structural understanding output, fed in by the
    // IPC handler after running the audio analysis (or null/undefined
    // when the user has no Gemini key or the analysis failed).
    geminiHighlights?: GeminiHighlightCandidate[];
    geminiTimeline?: GeminiTimelineSegment[];
  },
  onProgress: (p: AutoExtractProgress) => void,
): Promise<AutoExtractResult> {
  // M1.5b — load the global pattern snapshot once per call. Falls back
  // to null when pattern analysis hasn't been run; refine prompt then
  // omits the pattern section entirely (M1.0 behaviour).
  const globalPatterns = await loadGlobalPatterns();

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

  // Stage 2 — AI refine (10 → N). Gemini highlights/timeline (if any)
  // get folded into the prompt so the AI weighs both axes.
  onProgress({ phase: 'refine', percent: 0 });
  const { refined, usedFallback, warning } = await refineCandidatesWithAI(
    args.videoKey,
    candidates,
    args.targetCount,
    globalPatterns,
    args.geminiHighlights,
    args.geminiTimeline,
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
  // Resolve a "matching candidate" for messages + dominantCategory.
  // Task 2 prompts allow ±5-10s bound nudges, so the strict ±0.1s
  // match would miss legitimate adjustments. Use candidateIndex when
  // available (e.g. "C2"), else fall back to the closest C candidate
  // by start time within HALLUCINATION_TOLERANCE_SEC. G-only picks
  // get null (no comment messages exist for them) — Stage 4 falls
  // back to the AI's predictedTitle.
  const findMatchingCandidate = (r: RefinedCandidate): PeakCandidate | null => {
    const cIdx = parseCommentIndex(r.candidateIndex);
    if (cIdx != null && cIdx >= 0 && cIdx < candidates.length) {
      return candidates[cIdx]!;
    }
    let best: PeakCandidate | null = null;
    let bestDelta = HALLUCINATION_TOLERANCE_SEC;
    for (const c of candidates) {
      const d = Math.abs(c.startSec - r.startSec);
      if (d <= bestDelta) {
        bestDelta = d;
        best = c;
      }
    }
    return best;
  };
  const summarySegments: SummarySegment[] = refined.map((r) => {
    const original = findMatchingCandidate(r);
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
    const original = findMatchingCandidate(r);
    const dominantCategory: ReactionCategory | null = original?.dominantCategory ?? null;
    return {
      startSec: r.startSec,
      endSec: r.endSec,
      title: fromStage4 ?? fromStage2,
      dominantCategory,
      aiSource: 'auto-extract',
      aiReason: r.reason,
    };
  });

  return {
    segments,
    ...(usedFallback && warning ? { warning } : {}),
  };
}

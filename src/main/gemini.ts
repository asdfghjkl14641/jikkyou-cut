import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadGeminiApiKeys } from './secureStorage';
import { hashApiKey, videoKeyToFilenameStem } from './utils';
import { logGeminiRequest } from './dataCollection/database';

// Gemini-based audio analysis. Pipeline:
//   1. Caller extracts audio (16 kHz mono mp3) — done outside this module.
//   2. uploadFileResumable: 2-step resumable upload to the Files API.
//   3. pollFileActive: wait until the file enters state=ACTIVE (audio
//      files usually settle in a few seconds).
//   4. generateAnalysis: gemini-2.5-flash generateContent with
//      responseMimeType=application/json so we get strict JSON back.
//   5. parseAnalysisResponse: tolerant parser (strips fencing if the
//      model misbehaves) → GeminiAnalysisResult.
//   6. deleteFile: best-effort cleanup of the uploaded file.
//
// Multi-key rotation: 429 / 5xx mutes the key for 60s, 401/403 mutes
// for the session (24h). All keys exhausted ⇒ thrown error surfaces
// to the renderer.

const API_BASE = 'https://generativelanguage.googleapis.com';
// Switched 2.0-flash-exp → 2.5-flash on 2026-05-03 — the experimental
// model is closed to new projects 2026/3/6+ and shuts down 2026/6/1.
// 2.5-flash has thinking enabled by default; the response-time penalty
// is acceptable for highlight extraction where reasoning quality wins.
// thinkingConfig.thinkingBudget is left at default; revisit if latency
// becomes a problem.
const MODEL = 'gemini-2.5-flash';
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_ACTIVE_POLL_INTERVAL_MS = 2_000;
const FILE_ACTIVE_TIMEOUT_MS = 60_000;
const MUTE_RATE_LIMIT_MS = 60_000;
const MUTE_AUTH_FAIL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

export type GeminiHighlightCandidate = {
  startSec: number;
  endSec: number;
  reason: string;
  contentType: string; // 'laugh' | 'surprise' | 'reaction' | 'narrative' | 'other'
  confidence: number;
};

export type GeminiTimelineSegment = {
  startSec: number;
  endSec: number;
  description: string;
};

export type GeminiAnalysisResult = {
  totalDurationSec: number;
  timelineSummary: GeminiTimelineSegment[];
  highlights: GeminiHighlightCandidate[];
  transcriptHints?: string;
};

export type GeminiAnalysisPhase = 'uploading' | 'understanding' | 'parsing';

type StatusError = Error & { status?: number };

let activeAc: AbortController | null = null;

class GeminiKeyRotator {
  private keys: string[] = [];
  private cursor = 0;
  // Wall-clock ms when each muted index becomes available again.
  private mutedUntil = new Map<number, number>();

  async refresh(): Promise<void> {
    this.keys = await loadGeminiApiKeys();
  }

  get size(): number {
    return this.keys.length;
  }

  pick(): { key: string; index: number } | null {
    if (this.keys.length === 0) return null;
    const now = Date.now();
    for (let attempt = 0; attempt < this.keys.length; attempt += 1) {
      const idx = (this.cursor + attempt) % this.keys.length;
      const muted = this.mutedUntil.get(idx) ?? 0;
      if (muted > now) continue;
      this.cursor = (idx + 1) % this.keys.length;
      return { key: this.keys[idx]!, index: idx };
    }
    return null;
  }

  mute(index: number, durationMs: number): void {
    this.mutedUntil.set(index, Date.now() + durationMs);
  }
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'gemini-cache');
}

function cacheFilePath(videoKey: string): string {
  return path.join(cacheDir(), `${videoKeyToFilenameStem(videoKey)}.json`);
}

type CacheEntry = {
  version: number;
  timestamp: string;
  result: GeminiAnalysisResult;
};

export async function readCache(videoKey: string): Promise<GeminiAnalysisResult | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(videoKey), 'utf8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

export async function writeCache(videoKey: string, result: GeminiAnalysisResult): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  const entry: CacheEntry = {
    version: CACHE_VERSION,
    timestamp: new Date().toISOString(),
    result,
  };
  await fs.writeFile(cacheFilePath(videoKey), JSON.stringify(entry, null, 2), 'utf8');
}

function buildPrompt(videoTitle: string, durationSec: number): string {
  return `あなたはゲーム実況・配信切り抜きの専門編集者です。
この動画の音声を分析して、以下を出力してください。

# 動画情報
- タイトル: ${videoTitle}
- 動画長: ${durationSec} 秒

# 出力 1: タイムライン要約
動画全体の構造を 3-10 個のフェーズに分けて要約。
各フェーズに開始秒・終了秒・簡潔な説明(20 文字以内)。

# 出力 2: ハイライト候補
切り抜き動画として独立して面白い区間を 5-15 個抽出。
各候補について:
- 開始秒・終了秒(15-90 秒の範囲を推奨)
- 何が面白いかの理由(1 文、ネタバレ的にキャッチー)
- カテゴリ: laugh / surprise / reaction / narrative / other
- 自信度: 0.0-1.0

# 重要な観点
- コメント反応ではなく、音声内容そのものの面白さで判断
- 笑い声・叫び声・驚きの声などの非言語音もハイライト判断材料
- 配信冒頭挨拶・スポンサー読み・雑談繋ぎは原則除外
- 「起承転結」がある区間を優先(展開が完結)

# 出力形式
以下の JSON のみで出力。前置き・コードフェンス禁止。

{
  "totalDurationSec": <number>,
  "timelineSummary": [
    { "startSec": <number>, "endSec": <number>, "description": "<string>" }
  ],
  "highlights": [
    {
      "startSec": <number>,
      "endSec": <number>,
      "reason": "<string>",
      "contentType": "<string>",
      "confidence": <number>
    }
  ]
}`;
}

// Resumable upload — 2 round trips (start + finalize). Used for any
// audio size; the protocol handles streaming the bytes whether the
// file is 2 MB or 200 MB. Returns the file resource for use in
// generateContent (`uri`) and for cleanup (`name`).
async function uploadFileResumable(
  apiKey: string,
  audioBytes: Buffer,
  mimeType: string,
  signal: AbortSignal,
): Promise<{ name: string; uri: string; state: string }> {
  const startRes = await fetch(`${API_BASE}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audioBytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'jcut-gemini-audio.mp3' } }),
    signal,
  });
  if (!startRes.ok) {
    throwHttp('Files start', startRes.status, await startRes.text().catch(() => ''));
  }
  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    throw new Error('Files API: start response missing X-Goog-Upload-URL header');
  }

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: audioBytes,
    signal,
  });
  if (!upRes.ok) {
    throwHttp('Files upload', upRes.status, await upRes.text().catch(() => ''));
  }
  const json = (await upRes.json()) as {
    file: { name: string; uri: string; state?: string };
  };
  return {
    name: json.file.name,
    uri: json.file.uri,
    state: json.file.state ?? 'PROCESSING',
  };
}

async function pollFileActive(
  apiKey: string,
  fileName: string,
  signal: AbortSignal,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < FILE_ACTIVE_TIMEOUT_MS) {
    if (signal.aborted) throw abortedError();
    const res = await fetch(
      `${API_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`,
      { signal },
    );
    if (!res.ok) {
      throwHttp('Files status', res.status, await res.text().catch(() => ''));
    }
    const json = (await res.json()) as { state?: string };
    if (json.state === 'ACTIVE') return;
    if (json.state === 'FAILED') {
      throw new Error('Gemini Files API: file processing FAILED');
    }
    await sleepWithSignal(FILE_ACTIVE_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Gemini Files API: file not ACTIVE within ${FILE_ACTIVE_TIMEOUT_MS / 1000}s`);
}

async function generateAnalysis(
  apiKey: string,
  fileUri: string,
  mimeType: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { mime_type: mimeType, file_uri: fileUri } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
        },
      }),
      signal,
    },
  );
  // Per-key usage logging — generateContent is the only call that
  // counts toward the model's RPD limit, so this is the single hot
  // spot. Files API upload / status / delete don't count. Logged
  // regardless of success/failure so the API management quota panel
  // surfaces 401/429 even when the rotator subsequently retries on
  // a different key.
  try {
    logGeminiRequest({
      apiKeyHash: hashApiKey(apiKey),
      success: res.ok,
      statusCode: res.status,
      model: MODEL,
    });
  } catch (err) {
    console.warn('[gemini] failed to log request usage:', err);
  }
  if (!res.ok) {
    throwHttp('generateContent', res.status, await res.text().catch(() => ''));
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function deleteFile(apiKey: string, fileName: string): Promise<void> {
  try {
    await fetch(
      `${API_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    // best-effort cleanup; orphan files cost nothing on the free tier
  }
}

function parseAnalysisResponse(text: string): GeminiAnalysisResult {
  let s = text.trim();
  // Strip ```json ... ``` fencing if the model adds it despite
  // responseMimeType: 'application/json'.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Trim leading prose before the JSON body.
  const lb = s.indexOf('{');
  if (lb > 0) s = s.slice(lb);
  const parsed = JSON.parse(s) as Partial<GeminiAnalysisResult>;
  return normaliseResult(parsed);
}

function normaliseResult(raw: Partial<GeminiAnalysisResult>): GeminiAnalysisResult {
  // Light validation: missing arrays default to empty so downstream
  // rendering doesn't have to defend against undefined.
  return {
    totalDurationSec: typeof raw.totalDurationSec === 'number' ? raw.totalDurationSec : 0,
    timelineSummary: Array.isArray(raw.timelineSummary)
      ? raw.timelineSummary
          .filter((t) => t && typeof t === 'object')
          .map((t) => ({
            startSec: Number(t.startSec) || 0,
            endSec: Number(t.endSec) || 0,
            description: typeof t.description === 'string' ? t.description : '',
          }))
      : [],
    highlights: Array.isArray(raw.highlights)
      ? raw.highlights
          .filter((h) => h && typeof h === 'object')
          .map((h) => ({
            startSec: Number(h.startSec) || 0,
            endSec: Number(h.endSec) || 0,
            reason: typeof h.reason === 'string' ? h.reason : '',
            contentType: typeof h.contentType === 'string' ? h.contentType : 'other',
            confidence: clamp01(Number(h.confidence)),
          }))
      : [],
    transcriptHints: typeof raw.transcriptHints === 'string' ? raw.transcriptHints : undefined,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function throwHttp(stage: string, status: number, body: string): never {
  const err: StatusError = new Error(`${stage}: HTTP ${status} ${body.slice(0, 200)}`);
  err.status = status;
  throw err;
}

function abortedError(): Error {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  return err;
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortedError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function analyzeVideoAudio(
  audioFilePath: string,
  videoTitle: string,
  durationSec: number,
  signal: AbortSignal,
  onProgress: (phase: GeminiAnalysisPhase) => void,
): Promise<GeminiAnalysisResult> {
  const rotator = new GeminiKeyRotator();
  await rotator.refresh();
  if (rotator.size === 0) {
    throw new Error('Gemini API キーが未設定です');
  }

  const audioBytes = await fs.readFile(audioFilePath);
  const prompt = buildPrompt(videoTitle, durationSec);

  // Combine the user's cancel signal with a 5-min hard timeout. Any
  // abort surfaces as AbortError to the caller — the IPC handler
  // distinguishes between cancelled and errored runs by the .name.
  const timeoutSignal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const combined =
    AbortSignal.any != null ? AbortSignal.any([signal, timeoutSignal]) : signal;

  // Each key gets up to 2 attempts (rate-limit blip on first might
  // resolve in 60s); cap total attempts at 2× key count to bound the
  // worst case.
  const maxAttempts = Math.max(1, rotator.size * 2);
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const pick = rotator.pick();
    if (!pick) break;

    let uploadedName: string | null = null;
    let parseRetried = false;
    try {
      onProgress('uploading');
      const uploaded = await uploadFileResumable(
        pick.key,
        audioBytes,
        'audio/mp3',
        combined,
      );
      uploadedName = uploaded.name;
      if (uploaded.state !== 'ACTIVE') {
        await pollFileActive(pick.key, uploaded.name, combined);
      }

      onProgress('understanding');
      let text = await generateAnalysis(
        pick.key,
        uploaded.uri,
        'audio/mp3',
        prompt,
        combined,
      );

      onProgress('parsing');
      let result: GeminiAnalysisResult;
      try {
        result = parseAnalysisResponse(text);
      } catch {
        // One JSON-parse retry with the same key + same uploaded file —
        // cheaper than re-uploading and most flake is just a stray
        // wrapping line.
        parseRetried = true;
        text = await generateAnalysis(
          pick.key,
          uploaded.uri,
          'audio/mp3',
          prompt,
          combined,
        );
        try {
          result = parseAnalysisResponse(text);
        } catch (parseErr) {
          // Fallback: empty result so the UI doesn't crash. Caller
          // can show "AI 解析に失敗、空の結果を返しました" on top.
          console.warn('[gemini] parse failed twice, returning empty result:', parseErr);
          result = {
            totalDurationSec: durationSec,
            timelineSummary: [],
            highlights: [],
          };
        }
      }

      void deleteFile(pick.key, uploaded.name);
      return result;
    } catch (err) {
      lastErr = err as Error;
      if (uploadedName) {
        void deleteFile(pick.key, uploadedName);
      }
      if (combined.aborted) {
        throw lastErr;
      }
      const status = (lastErr as StatusError).status;
      if (status === 401 || status === 403) {
        rotator.mute(pick.index, MUTE_AUTH_FAIL_MS);
      } else if (status === 429 || (status != null && status >= 500)) {
        rotator.mute(pick.index, MUTE_RATE_LIMIT_MS);
      } else {
        // Unknown error — short mute so we still cycle off this key
        // for a moment but don't burn it for the whole session.
        rotator.mute(pick.index, 30_000);
      }
      // Note parseRetried so the loop continues to next key cleanly.
      void parseRetried;
    }
  }

  throw new Error(
    `全 API キーが quota 超過 / エラー: ${lastErr?.message ?? 'unknown'}`,
  );
}

// Text-only generateContent call — no Files API upload, no audio.
// Used by the creator-search Gemini lookup ("which YouTube/Twitch
// handles does this VTuber have?"). Wraps key rotation + 401/429 retry
// in the same shape as analyzeVideoAudio's inner loop, but skips the
// upload pipeline since we just have a string prompt.
//
// Returns the raw text from candidates[0].content.parts[0].text. The
// caller is responsible for JSON.parse if the prompt requested JSON.
//
// `responseMimeType: 'application/json'` is set unconditionally — every
// current caller wants JSON. If a future caller wants free text, add
// an `options.json` parameter to opt out.
export async function generateTextWithRotation(prompt: string): Promise<string> {
  const rotator = new GeminiKeyRotator();
  await rotator.refresh();
  console.log(`[gemini-text] generateTextWithRotation: keys=${rotator.size}`);
  if (rotator.size === 0) {
    throw new Error('Gemini API キーが未設定です(API 管理画面で設定してください)');
  }

  const ac = new AbortController();
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < rotator.size + 1; attempt += 1) {
    const picked = rotator.pick();
    if (!picked) {
      console.warn('[gemini-text] no available key (all muted)');
      break;
    }
    const { key, index } = picked;
    console.log(`[gemini-text] attempt ${attempt + 1} using key #${index}`);
    try {
      const res = await fetch(
        `${API_BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: 2048,
            },
          }),
          signal: ac.signal,
        },
      );
      try {
        logGeminiRequest({
          apiKeyHash: hashApiKey(key),
          success: res.ok,
          statusCode: res.status,
          model: MODEL,
        });
      } catch {
        // Logging failures don't break the call.
      }
      console.log(`[gemini-text] key #${index} response: HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        rotator.mute(index, 24 * 60 * 60 * 1000);
        lastErr = new Error(`Gemini auth failed on key ${index} (HTTP ${res.status})`);
        console.warn(`[gemini-text] key #${index} muted 24h (auth)`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        rotator.mute(index, 60 * 1000);
        lastErr = new Error(`Gemini transient error on key ${index} (HTTP ${res.status})`);
        console.warn(`[gemini-text] key #${index} muted 60s (transient)`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini generateContent: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
          safetyRatings?: unknown;
        }>;
        promptFeedback?: { blockReason?: string; safetyRatings?: unknown };
      };
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.[0]?.text ?? '';
      // Diagnostics — surface the finishReason and any block flags so
      // the renderer log can distinguish "empty content" from "content
      // blocked by safety filters" from "API responded but candidates
      // is empty array" (rare but happens on edge prompts).
      if (!text || cand?.finishReason !== 'STOP') {
        console.warn(
          `[gemini-text] key #${index} unusual response: finishReason=${cand?.finishReason ?? '?'}, ` +
            `text.length=${text.length}, blockReason=${json.promptFeedback?.blockReason ?? 'none'}, ` +
            `candidates.length=${json.candidates?.length ?? 0}`,
        );
      }
      return text;
    } catch (err) {
      console.warn(`[gemini-text] key #${index} threw:`, err instanceof Error ? err.message : err);
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('Gemini generateContent: 全 API キーが利用不可');
}

// Lightweight ping for the Settings UI "validate" button. Hits the
// `/v1beta/models` listing — costs effectively no quota and confirms
// the key is accepted by Google.
export async function validateApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey || apiKey.trim().length < 10) return false;
  try {
    const res = await fetch(
      `${API_BASE}/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function cancelAnalysis(): void {
  activeAc?.abort();
}

// IPC bridge — keeps a single inflight controller so the renderer can
// cancel mid-analysis. The IPC handler in main/index.ts wraps this to
// emit progress events.
export async function runAnalysis(
  audioFilePath: string,
  videoTitle: string,
  durationSec: number,
  onProgress: (phase: GeminiAnalysisPhase) => void,
): Promise<GeminiAnalysisResult> {
  const ac = new AbortController();
  activeAc = ac;
  try {
    return await analyzeVideoAudio(
      audioFilePath,
      videoTitle,
      durationSec,
      ac.signal,
      onProgress,
    );
  } finally {
    if (activeAc === ac) activeAc = null;
  }
}

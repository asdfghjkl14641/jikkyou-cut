import { GoogleGenAI, createPartFromUri } from '@google/genai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSrt } from '../common/srt';
import { buildPrompt } from '../common/transcriptionContext';
import type { TranscriptionContext } from '../common/config';
import {
  TRANSCRIPTION_CANCELLED,
  type ApiKeyValidationResult,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '../common/types';
import { extractAudioToTemp } from './audioExtraction';

// 60 minutes — generous enough for 1h+ videos on Gemini 2.5 Flash.
const HTTP_TIMEOUT_MS = 60 * 60 * 1000;
const VALIDATE_TIMEOUT_MS = 15_000;
const ACTIVE_POLL_TIMEOUT_MS = 120_000;
const ACTIVE_POLL_INTERVAL_MS = 2_000;

type Job = {
  ac: AbortController;
  client?: GoogleGenAI;
  uploadedFileName?: string;
  tmpAudioPath?: string;
};

let activeJob: Job | null = null;

const baseNameNoExt = (p: string): string =>
  path.basename(p, path.extname(p));

// Wraps a Promise so it rejects when the signal aborts. The original promise
// is left in flight (best-effort) — the SDK does not actually cancel
// in-flight HTTP requests on the server side.
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function maskMessage(msg: string): string {
  // Belt-and-braces: redact anything that looks like an API key in case the
  // SDK or fetch happens to echo it back. Google API keys are AIza-prefixed
  // 39-char strings, but we redact any long-ish alphanumeric run too.
  return msg
    .replaceAll(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted>')
    .replaceAll(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}

function mapError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = maskMessage(raw);
  const status =
    (err as { status?: number; code?: number }).status ??
    (err as { code?: number }).code;

  if (
    status === 401 ||
    status === 403 ||
    /API key not valid|invalid api key|UNAUTHENTICATED|PERMISSION_DENIED/i.test(msg)
  ) {
    return new Error('APIキーが無効です。設定を確認してください');
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit/i.test(msg)) {
    if (/quota/i.test(msg)) {
      return new Error(
        'Gemini APIの無料枠を超えました。Google AI Studioで使用状況を確認してください',
      );
    }
    return new Error(
      'APIレート制限に達しました。少し待ってから再試行してください',
    );
  }
  if (/network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    return new Error('ネットワーク接続を確認してください');
  }
  if (/deadline|timeout/i.test(msg)) {
    return new Error(
      '文字起こしがタイムアウトしました。動画が長すぎる可能性があります',
    );
  }
  return new Error(`文字起こしに失敗しました: ${msg.slice(0, 500)}`);
}

export async function validateApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    // ai.models.list resolves only after the first page has been fetched, so
    // any auth failure surfaces as a rejection here.
    await ai.models.list({
      config: { httpOptions: { timeout: VALIDATE_TIMEOUT_MS } },
    });
    return { valid: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = maskMessage(raw);
    const status =
      (err as { status?: number; code?: number }).status ??
      (err as { code?: number }).code;
    if (
      status === 401 ||
      status === 403 ||
      /API key not valid|UNAUTHENTICATED|PERMISSION_DENIED/i.test(msg)
    ) {
      return { valid: false, error: 'APIキーが無効です' };
    }
    if (/network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
      return { valid: false, error: 'ネットワーク接続を確認してください' };
    }
    return {
      valid: false,
      error: `検証に失敗しました: ${msg.slice(0, 200)}`,
    };
  }
}

async function uploadAndWaitActive(
  client: GoogleGenAI,
  filePath: string,
  signal: AbortSignal,
  onRatio: (r: number) => void,
): Promise<{ name: string; uri: string; mimeType: string }> {
  // No upload-progress callback in the SDK, so we simply mark 0 → 1.
  onRatio(0);
  const uploaded = await withAbort(
    client.files.upload({
      file: filePath,
      config: {
        mimeType: 'audio/mp3',
        abortSignal: signal,
      },
    }),
    signal,
  );
  onRatio(1);

  if (!uploaded.name || !uploaded.uri) {
    throw new Error('Geminiへのアップロード結果が無効です');
  }

  // Poll until the file becomes ACTIVE (or fails).
  const start = Date.now();
  let state = uploaded.state;
  while (state !== 'ACTIVE') {
    if (signal.aborted) throw new Error('aborted');
    if (state === 'FAILED') {
      throw new Error('アップロードした音声ファイルのGemini側処理が失敗しました');
    }
    if (Date.now() - start > ACTIVE_POLL_TIMEOUT_MS) {
      throw new Error('Gemini側のファイル処理がタイムアウトしました');
    }
    await new Promise((r) => setTimeout(r, ACTIVE_POLL_INTERVAL_MS));
    if (signal.aborted) throw new Error('aborted');
    const fetched = await client.files.get({ name: uploaded.name });
    state = fetched.state;
  }

  return {
    name: uploaded.name,
    uri: uploaded.uri,
    mimeType: uploaded.mimeType ?? 'audio/mp3',
  };
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/^```(?:srt)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
}

export async function transcribe({
  videoFilePath,
  durationSec,
  apiKey,
  context,
  onProgress,
}: {
  videoFilePath: string;
  durationSec: number;
  apiKey: string;
  context: TranscriptionContext;
  onProgress: (p: TranscriptionProgress) => void;
}): Promise<TranscriptionResult> {
  if (activeJob) throw new Error('別の文字起こしが実行中です');

  const ac = new AbortController();
  const job: Job = { ac };
  activeJob = job;

  const dir = path.dirname(videoFilePath);
  const base = baseNameNoExt(videoFilePath);
  const finalSrt = path.join(dir, `${base}.ja.srt`);

  let phaseTickInterval: NodeJS.Timeout | null = null;

  try {
    // Phase 1: extract audio.
    onProgress({ phase: 'extracting', ratio: 0 });
    job.tmpAudioPath = await extractAudioToTemp({
      videoFilePath,
      durationSec,
      signal: ac.signal,
      onRatio: (r) => onProgress({ phase: 'extracting', ratio: r }),
    });

    // Phase 2: upload + wait for ACTIVE.
    onProgress({ phase: 'uploading', ratio: 0 });
    const client = new GoogleGenAI({ apiKey });
    job.client = client;
    const uploaded = await uploadAndWaitActive(
      client,
      job.tmpAudioPath,
      ac.signal,
      (r) => onProgress({ phase: 'uploading', ratio: r }),
    );
    job.uploadedFileName = uploaded.name;

    // Phase 3: transcribe — Gemini gives no progress, so we tick elapsed time.
    const startedAt = Date.now();
    onProgress({ phase: 'transcribing', elapsedSec: 0 });
    phaseTickInterval = setInterval(() => {
      onProgress({
        phase: 'transcribing',
        elapsedSec: (Date.now() - startedAt) / 1000,
      });
    }, 1000);

    const response = await withAbort(
      client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              createPartFromUri(uploaded.uri, uploaded.mimeType),
              { text: buildPrompt(context) },
            ],
          },
        ],
        config: {
          abortSignal: ac.signal,
          httpOptions: { timeout: HTTP_TIMEOUT_MS },
        },
      }),
      ac.signal,
    );

    const srtText = stripCodeFences(response.text ?? '');
    const cues = parseSrt(srtText);

    await fs.rm(finalSrt, { force: true });
    await fs.writeFile(finalSrt, srtText, 'utf8');

    onProgress({ phase: 'transcribing', elapsedSec: (Date.now() - startedAt) / 1000 });

    return {
      language: 'ja',
      cues,
      srtFilePath: finalSrt,
      generatedAt: Date.now(),
    };
  } catch (err) {
    const cancelled =
      ac.signal.aborted ||
      (err as { name?: string }).name === 'AbortError' ||
      (err instanceof Error && err.message === 'aborted');
    if (cancelled) {
      const e = new Error('cancelled');
      e.name = TRANSCRIPTION_CANCELLED;
      throw e;
    }
    throw mapError(err);
  } finally {
    if (phaseTickInterval) clearInterval(phaseTickInterval);
    if (job.tmpAudioPath) {
      await fs.rm(job.tmpAudioPath, { force: true });
    }
    if (job.client && job.uploadedFileName) {
      // Best-effort cleanup; auto-deleted by Gemini after 48h regardless.
      try {
        await job.client.files.delete({ name: job.uploadedFileName });
      } catch {
        // intentionally swallowed
      }
    }
    activeJob = null;
  }
}

export async function cancelTranscription(): Promise<void> {
  activeJob?.ac.abort();
}

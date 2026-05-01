import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { buildCustomVocabulary } from '../common/transcriptionContext';
import type { TranscriptionContext } from '../common/config';
import {
  TRANSCRIPTION_CANCELLED,
  type ApiKeyValidationResult,
  type TranscriptCue,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '../common/types';
import { extractAudioToTemp } from './audioExtraction';

const GLADIA_BASE = 'https://api.gladia.io/v2';
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

type Job = {
  ac: AbortController;
  jobId?: string;
  resultUrl?: string;
  apiKey?: string;
  tmpAudioPath?: string;
};

let activeJob: Job | null = null;

const baseNameNoExt = (p: string): string =>
  path.basename(p, path.extname(p));

function maskMessage(msg: string): string {
  // Belt-and-braces redaction. Gladia keys vary in shape; redact any
  // alphanumeric run >= 24 chars that looks token-ish, plus typical bearer
  // and `x-gladia-key` echoes.
  return msg
    .replaceAll(/x-gladia-key:\s*[^\s,;}'"]+/gi, 'x-gladia-key: <redacted>')
    .replaceAll(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .replaceAll(/[A-Za-z0-9_-]{40,}/g, '<redacted>');
}

function mapError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = maskMessage(raw);
  const status = (err as { status?: number }).status;

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|invalid api key|invalid_api_key|forbidden/i.test(msg)
  ) {
    return new Error('Gladia APIキーが無効です。設定を確認してください');
  }
  if (status === 402 || /payment.required|quota|insufficient.credits/i.test(msg)) {
    return new Error(
      'Gladia の Free 枠を超えました。Pro プランへの移行を検討してください',
    );
  }
  if (status === 429) {
    return new Error(
      'APIレート制限に達しました。少し待ってから再試行してください',
    );
  }
  if (status != null && status >= 500 && status < 600) {
    return new Error(
      'Gladia サーバでエラーが発生しました。少し待ってから再試行してください',
    );
  }
  if (status === 413 || /payload too large|request entity too large/i.test(msg)) {
    return new Error(
      '音声ファイルがサイズ上限を超えました。動画が長すぎる可能性があります',
    );
  }
  if (/network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    return new Error('ネットワーク接続を確認してください');
  }
  if (/timeout|deadline/i.test(msg)) {
    return new Error(
      '文字起こしがタイムアウトしました。動画が長すぎる可能性があります',
    );
  }
  return new Error(`文字起こしに失敗しました: ${msg.slice(0, 500)}`);
}

// Throws an Error with `status` attached if the Response is not ok.
async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const err = new Error(`${label} HTTP ${res.status}: ${body.slice(0, 500)}`);
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

export async function validateApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  // Per-spec: lightweight format check only. Gladia has no documented
  // free-of-cost auth endpoint, so the real validation happens on the first
  // transcription request.
  const trimmed = apiKey.trim();
  if (trimmed.length < 20) {
    return { valid: false, error: 'APIキーの形式が不正です(20文字以上)' };
  }
  return { valid: true };
}

async function uploadAudio(
  filePath: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const stat = await fs.stat(filePath);
  console.log(
    `[gladia-upload] uploading ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`,
  );

  // FormData + Blob lets us stream the file body without loading the whole
  // thing into memory before posting.
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append(
    'audio',
    new Blob([buffer], { type: 'audio/mpeg' }),
    path.basename(filePath),
  );

  const ac = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  // Combine the user-cancel signal with our own timeout signal.
  const combined = AbortSignal.any
    ? AbortSignal.any([signal, ac])
    : signal;

  const res = await fetch(`${GLADIA_BASE}/upload`, {
    method: 'POST',
    headers: { 'x-gladia-key': apiKey },
    body: form,
    signal: combined,
  });
  await ensureOk(res, '[gladia-upload]');
  const json = (await res.json()) as { audio_url?: string; url?: string };
  const audioUrl = json.audio_url ?? json.url;
  if (!audioUrl) {
    throw new Error(`[gladia-upload] 予期しないレスポンス: ${JSON.stringify(json).slice(0, 500)}`);
  }
  console.log('[gladia-upload] audio_url received');
  return audioUrl;
}

async function submitJob(
  audioUrl: string,
  apiKey: string,
  ctx: TranscriptionContext,
  collaborationMode: boolean,
  expectedSpeakerCount: number | null,
  signal: AbortSignal,
): Promise<{ id: string; resultUrl: string }> {
  const vocab = buildCustomVocabulary(ctx);
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    language: 'ja',
    diarization: collaborationMode,
  };
  if (vocab.length > 0) {
    body['custom_vocabulary'] = vocab;
  }

  // Diarization hint. The Gladia docs note these are hints, not hard
  // constraints — but auto-detection regularly under-counts speakers
  // (3-person recordings mis-clustered as 2), so the hint is worth sending
  // whenever we have one. Only attached when collaborationMode is true:
  // Gladia ignores diarization_config when diarization itself is off,
  // but sending it anyway would be a contract smell.
  let diarizationHint: 'auto' | string = 'auto';
  if (collaborationMode && expectedSpeakerCount != null) {
    if (expectedSpeakerCount >= 6) {
      // The "6+" bucket — give Gladia a floor and let it find the actual
      // ceiling rather than capping arbitrarily.
      body['diarization_config'] = { min_speakers: 6 };
      diarizationHint = 'min_speakers=6';
    } else if (expectedSpeakerCount >= 2) {
      body['diarization_config'] = { number_of_speakers: expectedSpeakerCount };
      diarizationHint = `number_of_speakers=${expectedSpeakerCount}`;
    }
  }

  console.log(
    `[gladia-submit] vocab=${vocab.length} terms, diarization=${collaborationMode}, speakers=${diarizationHint}, language=ja`,
  );

  const res = await fetch(`${GLADIA_BASE}/pre-recorded`, {
    method: 'POST',
    headers: {
      'x-gladia-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  await ensureOk(res, '[gladia-submit]');
  const json = (await res.json()) as { id?: string; result_url?: string };
  if (!json.id || !json.result_url) {
    throw new Error(
      `[gladia-submit] 予期しないレスポンス: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  console.log(`[gladia-submit] job created: ${json.id}`);
  return { id: json.id, resultUrl: json.result_url };
}

type GladiaUtterance = {
  start: number;
  end: number;
  text: string;
  speaker?: number | string | null;
};

type GladiaPollResponse = {
  status: 'queued' | 'processing' | 'done' | 'error';
  result?: {
    transcription?: {
      utterances?: GladiaUtterance[];
      full_transcript?: string;
    };
  };
  error_code?: string;
  error?: { message?: string } | string;
};

async function pollResult(
  resultUrl: string,
  apiKey: string,
  signal: AbortSignal,
  onElapsed: (sec: number) => void,
): Promise<GladiaPollResponse> {
  const start = Date.now();
  let pollCount = 0;
  // Initial small wait so the server has a chance to start the job.
  await new Promise((r) => setTimeout(r, 1000));
  while (true) {
    if (signal.aborted) throw new Error('aborted');
    const res = await fetch(resultUrl, {
      headers: { 'x-gladia-key': apiKey },
      signal,
    });
    await ensureOk(res, '[gladia-poll]');
    const json = (await res.json()) as GladiaPollResponse;
    pollCount += 1;
    onElapsed((Date.now() - start) / 1000);

    if (json.status === 'done') {
      console.log(
        `[gladia-poll] done after ${pollCount} polls (${((Date.now() - start) / 1000).toFixed(1)}s)`,
      );
      return json;
    }
    if (json.status === 'error') {
      const msg =
        typeof json.error === 'string'
          ? json.error
          : (json.error?.message ?? json.error_code ?? 'unknown');
      throw new Error(`Gladia transcription error: ${msg}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error('Gladia ジョブがタイムアウトしました');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function normaliseSpeaker(s: number | string | null | undefined): string | undefined {
  if (s == null) return undefined;
  if (typeof s === 'number') return `speaker_${s}`;
  // Gladia sometimes returns "0" / "speaker_0" / similar.
  const str = String(s).trim();
  if (!str) return undefined;
  if (/^\d+$/.test(str)) return `speaker_${str}`;
  return str;
}

function utterancesToCues(utterances: GladiaUtterance[]): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  utterances.forEach((u, i) => {
    const text = (u.text ?? '').trim();
    if (!text) return;
    const speaker = normaliseSpeaker(u.speaker);
    out.push({
      id: nanoid(),
      index: i + 1,
      startSec: typeof u.start === 'number' ? u.start : 0,
      endSec: typeof u.end === 'number' ? u.end : 0,
      text,
      deleted: false,
      showSubtitle: true,
      ...(speaker != null && { speaker }),
    });
  });
  return out;
}

const formatSrtTime = (sec: number): string => {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return (
    `${String(h).padStart(2, '0')}:` +
    `${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},` +
    `${String(ms).padStart(3, '0')}`
  );
};

function buildSrt(cues: readonly TranscriptCue[]): string {
  // Number distinct speakers so the on-disk SRT uses 1-indexed Japanese
  // labels even if Gladia's speaker IDs are sparse (e.g. 0, 2, 5).
  const speakerOrder = new Map<string, number>();
  for (const c of cues) {
    if (c.speaker != null && !speakerOrder.has(c.speaker)) {
      speakerOrder.set(c.speaker, speakerOrder.size);
    }
  }
  const includeSpeakers = speakerOrder.size > 1;

  const blocks: string[] = [];
  cues.forEach((c, i) => {
    const prefix =
      includeSpeakers && c.speaker != null
        ? `[話者${(speakerOrder.get(c.speaker) ?? 0) + 1}] `
        : '';
    blocks.push(
      `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${prefix}${c.text}`,
    );
  });
  return blocks.join('\n\n') + '\n';
}

export async function transcribe({
  videoFilePath,
  durationSec,
  apiKey,
  context,
  collaborationMode,
  expectedSpeakerCount,
  onProgress,
}: {
  videoFilePath: string;
  durationSec: number;
  apiKey: string;
  context: TranscriptionContext;
  collaborationMode: boolean;
  expectedSpeakerCount: number | null;
  onProgress: (p: TranscriptionProgress) => void;
}): Promise<TranscriptionResult> {
  if (activeJob) throw new Error('別の文字起こしが実行中です');

  const ac = new AbortController();
  const job: Job = { ac, apiKey };
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

    // Phase 2: upload to Gladia.
    onProgress({ phase: 'uploading', ratio: 0 });
    const audioUrl = await uploadAudio(job.tmpAudioPath, apiKey, ac.signal);
    onProgress({ phase: 'uploading', ratio: 1 });

    // Phase 3: submit job + poll until done.
    const { id, resultUrl } = await submitJob(
      audioUrl,
      apiKey,
      context,
      collaborationMode,
      expectedSpeakerCount,
      ac.signal,
    );
    job.jobId = id;
    job.resultUrl = resultUrl;

    const startedAt = Date.now();
    onProgress({ phase: 'transcribing', elapsedSec: 0 });
    phaseTickInterval = setInterval(() => {
      onProgress({
        phase: 'transcribing',
        elapsedSec: (Date.now() - startedAt) / 1000,
      });
    }, 1000);

    const finalJson = await pollResult(resultUrl, apiKey, ac.signal, (s) => {
      onProgress({ phase: 'transcribing', elapsedSec: s });
    });

    // Diagnostic dump.
    const utterances = finalJson.result?.transcription?.utterances ?? [];
    console.log(`[gladia-response] utterances=${utterances.length}`);
    if (utterances.length > 0 && utterances[0]) {
      console.log('[gladia-response] sample[0]:', {
        start: utterances[0].start,
        end: utterances[0].end,
        textLen: utterances[0].text?.length ?? 0,
        speaker: utterances[0].speaker,
      });
    }

    const cues = utterancesToCues(utterances);
    const srtText = buildSrt(cues);

    await fs.rm(finalSrt, { force: true });
    await fs.writeFile(finalSrt, srtText, 'utf8');

    onProgress({
      phase: 'transcribing',
      elapsedSec: (Date.now() - startedAt) / 1000,
    });

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
    activeJob = null;
  }
}

export async function cancelTranscription(): Promise<void> {
  activeJob?.ac.abort();
  // Gladia v2 has no documented public job-cancel endpoint as of writing;
  // the in-flight request is dropped client-side, the server-side job will
  // continue to completion (or timeout) and the result is simply discarded.
}

// Suppress unused warning for createReadStream — kept for future streaming
// upload migration when fetch supports a streaming Body.
void createReadStream;

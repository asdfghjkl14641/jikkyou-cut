import { execa, type ResultPromise } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseSrt } from '../common/srt';
import {
  TRANSCRIPTION_CANCELLED,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '../common/types';
import { parseProgressLine } from './progress';

type RunArgs = {
  videoFilePath: string;
  modelPath: string;
  durationSec: number;
  onProgress: (p: TranscriptionProgress) => void;
};

type ActiveJob = {
  process: ResultPromise;
  abortController: AbortController;
  tmpSrtPath: string;
};

let activeJob: ActiveJob | null = null;

const baseNameNoExt = (p: string): string => {
  const ext = path.extname(p);
  return path.basename(p, ext);
};

// Maps known whisper / ffmpeg failure signatures onto user-facing messages.
function classifyError(stderr: string, originalMessage: string): Error {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('whisper_init') ||
    lower.includes('failed to load model') ||
    lower.includes('failed to read model header') ||
    lower.includes('whisper_model_load')
  ) {
    return new Error(
      'Whisperモデルの読み込みに失敗しました。別のモデルファイルをお試しください。',
    );
  }
  if (
    lower.includes('permission denied') ||
    lower.includes('access is denied') ||
    lower.includes('eacces') ||
    lower.includes('eperm')
  ) {
    return new Error(
      'SRTの書き出しに失敗しました。動画ファイルの保存先の権限を確認してください。',
    );
  }
  // Fall back to the raw ffmpeg stderr (or message) so we have actionable detail.
  const detail = stderr.trim() || originalMessage;
  return new Error(`文字起こしに失敗しました: ${detail}`);
}

export async function startTranscription(args: RunArgs): Promise<TranscriptionResult> {
  if (activeJob) {
    throw new Error('別の文字起こしが実行中です');
  }

  const { videoFilePath, modelPath, durationSec, onProgress } = args;
  const dir = path.dirname(videoFilePath);
  const base = baseNameNoExt(videoFilePath);
  const finalSrt = path.join(dir, `${base}.ja.srt`);
  const tmpSrt = `${finalSrt}.tmp`;

  // Clean any stale tmp from a previous crash.
  await fs.rm(tmpSrt, { force: true });

  const abortController = new AbortController();
  const durationMicros = Math.max(1, Math.round(durationSec * 1_000_000));

  // FFmpeg 8.1's whisper filter (and subtitles, etc.) splits filter options on
  // raw `:` regardless of `\:` escapes or `'...'` quoting — both confirmed
  // empirically. The only reliable way to pass a Windows path containing a
  // drive-letter colon is to remove the colon from the value altogether by
  // running ffmpeg with cwd at the drive root and passing a relative path.
  const driveOf = (absPath: string): string | null => {
    const m = /^([A-Za-z]):[\\/]/.exec(absPath);
    return m && m[1] ? m[1].toUpperCase() : null;
  };
  const stripDrive = (absPath: string): string => {
    const m = /^[A-Za-z]:[\\/](.*)$/.exec(absPath);
    if (!m || m[1] == null) {
      throw new Error(
        `絶対パス(ドライブレター付き)である必要があります: ${absPath}`,
      );
    }
    return m[1].replaceAll('\\', '/');
  };

  const modelDrive = driveOf(modelPath);
  const srtDrive = driveOf(tmpSrt);
  if (!modelDrive || !srtDrive) {
    throw new Error(
      'モデルパスと動画ファイルパスは絶対パス(ドライブレター付き)である必要があります。',
    );
  }
  if (modelDrive !== srtDrive) {
    throw new Error(
      `動画(${srtDrive}:)とWhisperモデル(${modelDrive}:)が別ドライブにあります。MVPでは同一ドライブ内のファイルのみサポートしています。モデルファイルを動画と同じドライブにコピーしてください。`,
    );
  }
  const driveRoot = `${modelDrive}:\\`;
  const modelRel = stripDrive(modelPath);
  const tmpSrtRel = stripDrive(tmpSrt);

  const filterGraph =
    `whisper=model=${modelRel}:` +
    `language=ja:` +
    `queue=3:` +
    `use_gpu=false:` +
    `destination=${tmpSrtRel}:` +
    `format=srt`;

  console.log('[whisper] cwd:', driveRoot);
  console.log('[whisper] filter graph:', filterGraph);

  const ffmpegArgs = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', videoFilePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-af', filterGraph,
    '-f', 'null',
    '-',
    '-progress', 'pipe:1',
  ];

  const proc = execa('ffmpeg', ffmpegArgs, {
    cancelSignal: abortController.signal,
    encoding: 'utf8',
    buffer: false,
    cwd: driveRoot,
  });

  activeJob = { process: proc, abortController, tmpSrtPath: tmpSrt };

  let lastSpeed: number | undefined;
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const parsed = parseProgressLine(line);
      if (!parsed) return;
      if (parsed.speed != null) lastSpeed = parsed.speed;
      if (parsed.outTimeMicros != null) {
        onProgress({
          outTimeMicros: parsed.outTimeMicros,
          durationMicros,
          ...(lastSpeed != null && { speed: lastSpeed }),
        });
      }
    });
  }

  let stderrBuffer = '';
  if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrBuffer += s;
      // Cap to avoid unbounded growth on very long jobs.
      if (stderrBuffer.length > 64 * 1024) {
        stderrBuffer = stderrBuffer.slice(-64 * 1024);
      }
    });
  }

  try {
    await proc;
  } catch (err) {
    const cancelled =
      abortController.signal.aborted ||
      (err as { isCanceled?: boolean; isTerminated?: boolean }).isCanceled ||
      (err as { isTerminated?: boolean }).isTerminated;
    if (cancelled) {
      await fs.rm(tmpSrt, { force: true });
      const e = new Error('cancelled');
      e.name = TRANSCRIPTION_CANCELLED;
      throw e;
    }
    throw classifyError(stderrBuffer, (err as Error).message);
  } finally {
    activeJob = null;
  }

  // Read the SRT and parse. Empty file is allowed (no speech detected).
  let srtContent = '';
  try {
    srtContent = await fs.readFile(tmpSrt, 'utf8');
  } catch {
    // The whisper filter may not produce a file at all if no audio was detected.
    srtContent = '';
  }
  const cues = parseSrt(srtContent);

  // Atomic-ish rename: tmp → final. Overwrite any prior .ja.srt.
  await fs.rm(finalSrt, { force: true });
  // If tmp doesn't exist (no speech), still create an empty final SRT for consistency.
  try {
    await fs.rename(tmpSrt, finalSrt);
  } catch {
    await fs.writeFile(finalSrt, srtContent, 'utf8');
    await fs.rm(tmpSrt, { force: true });
  }

  // Final progress event so the UI snaps to 100%.
  onProgress({ outTimeMicros: durationMicros, durationMicros, speed: lastSpeed });

  return {
    modelPath,
    language: 'ja',
    cues,
    srtFilePath: finalSrt,
    generatedAt: Date.now(),
  };
}

export async function cancelTranscription(): Promise<void> {
  const job = activeJob;
  if (!job) return;
  job.abortController.abort();
  // Best-effort cleanup; the catch in startTranscription also removes the tmp.
  await fs.rm(job.tmpSrtPath, { force: true });
}

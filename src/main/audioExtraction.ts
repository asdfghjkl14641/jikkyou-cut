import { app } from 'electron';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { nanoid } from 'nanoid';
import { parseProgressLine } from './progress';

type ExtractArgs = {
  videoFilePath: string;
  durationSec: number;
  signal: AbortSignal;
  onRatio: (ratio: number) => void;
};

// Pulls audio from the video into a temp MP3 (mono, 16 kHz, 64 kbps) — the
// shape Gemini downsamples to internally, so we minimise upload bytes.
export async function extractAudioToTemp(args: ExtractArgs): Promise<string> {
  const { videoFilePath, durationSec, signal, onRatio } = args;
  const tmpDir = app.getPath('temp');
  const id = nanoid(8);
  const tmpPath = path.join(tmpDir, `jcut-audio-${id}.mp3`);

  const ffmpegArgs = [
    '-hide_banner', '-nostdin', '-y',
    '-i', videoFilePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    '-f', 'mp3',
    tmpPath,
    '-progress', 'pipe:1',
  ];

  console.log('[audio-extract] cmd:', 'ffmpeg', ffmpegArgs.join(' '));
  console.log('[audio-extract] tmp:', tmpPath);

  const proc = execa('ffmpeg', ffmpegArgs, {
    cancelSignal: signal,
    encoding: 'utf8',
    buffer: false,
  });

  const durationMicros = Math.max(1, Math.round(durationSec * 1_000_000));
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const parsed = parseProgressLine(line);
      if (parsed?.outTimeMicros != null) {
        onRatio(Math.min(1, parsed.outTimeMicros / durationMicros));
      }
    });
  }

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (stderrBuf.length > 32 * 1024) {
      stderrBuf = stderrBuf.slice(-32 * 1024);
    }
  });

  try {
    await proc;
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    if (signal.aborted) throw err;
    const detail = stderrBuf.trim() || (err as Error).message;
    throw new Error(`動画から音声を取得できませんでした: ${detail}`);
  }
  onRatio(1);

  try {
    const st = await fs.stat(tmpPath);
    console.log(
      `[audio-extract] done: size=${st.size} bytes (${(st.size / 1024 / 1024).toFixed(2)} MB)`,
    );
    // Last few stderr lines tend to summarise final stats; capture for diagnostics.
    const stderrTail = stderrBuf.trim().split(/\r?\n/).slice(-5).join('\n');
    console.log('[audio-extract] stderr tail:\n' + stderrTail);
  } catch {
    // ignore
  }

  return tmpPath;
}

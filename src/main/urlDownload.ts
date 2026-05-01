import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, ChildProcess } from 'child_process';
import type { UrlDownloadProgress } from '../common/types';

let currentProcess: ChildProcess | null = null;

function getYtDlpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe');
  } else {
    return path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');
  }
}

// Optional `[height<=N]` filter built from the quality dropdown. Empty
// string for "best" / "worst" / unrecognised — those rely entirely on
// the codec/container constraints. We always combine it with the avc1+mp4
// preference below so a 1440p selection still falls back to 1080p AVC1
// rather than reaching for a 1440p VP9/AV1 that Chromium can't decode.
const heightFilter = (quality: string): string => {
  const n = Number.parseInt(quality, 10);
  return Number.isFinite(n) && n > 0 ? `[height<=${n}]` : '';
};

// Format selector that prioritises Chromium-playable streams.
//
//   1. bestvideo[ext=mp4][vcodec^=avc1]<heightFilter> + bestaudio[ext=m4a]
//      → MP4-AVC1 (H.264) video + M4A AAC audio. Native <video> support.
//   2. /best[ext=mp4]<heightFilter>
//      → single MP4 stream. May be AV1 in mp4 container — falls back here
//        for sources with no separate avc1 video stream.
//   3. /best<heightFilter>
//      → anything. Last-resort.
//
// "worst" uses the same ladder but inverted to `worstvideo` — only
// intended for quick smoke tests, MP4 still preferred.
//
// Trade-off: 4K AV1 / 1440p VP9 etc are sacrificed even when explicitly
// selected, because they don't play back natively in <video>. <handoff
// section 10 / DECISIONS 2026-05-02> for the rationale.
const buildFormatSelector = (quality: string): string => {
  const h = heightFilter(quality);
  if (quality === 'worst') {
    return 'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst';
  }
  return (
    `bestvideo[ext=mp4][vcodec^=avc1]${h}+bestaudio[ext=m4a]/` +
    `best[ext=mp4]${h}/best${h}`
  );
};

// Stable, machine-parseable progress format. yt-dlp's default
// `[download]  45.3% of 100.00MiB at 5.20MiB/s ETA 00:10` line is
// fragile: replaced by `Unknown%` / `N/A` for live archives, dropped
// during fragment merges, and chunked unpredictably across stdout
// flushes. The custom template emits a one-token-per-field line that we
// can match with a single regex even when fields are `NA`.
//
// The fields are wrapped in plain ASCII brackets that yt-dlp won't
// otherwise emit, so we can also distinguish progress lines from any
// other [...] log output.
const PROGRESS_TAG = 'JCUT_PROGRESS';
const PROGRESS_TEMPLATE = `download:${PROGRESS_TAG} %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s`;

export async function downloadVideo(args: {
  url: string;
  quality: string;
  outputDir: string;
  onProgress: (progress: UrlDownloadProgress) => void;
}): Promise<{ filePath: string; title: string }> {
  const format = buildFormatSelector(args.quality);

  // Ensure outputDir exists
  await fs.mkdir(args.outputDir, { recursive: true });

  // Use %(title)s.%(ext)s but restrict filenames to be safe.
  const template = '%(title)s.%(ext)s';
  const outputTemplate = `${args.outputDir}${path.sep}${template}`;

  console.log('[url-download] format selector:', format);

  const process: any = spawn(getYtDlpPath(), [
    args.url,
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    '--newline',
    '--progress-template', PROGRESS_TEMPLATE,
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--print', 'after_move:filepath', // To get the final file path
    '--print', 'title',               // To get the title
  ]);
  currentProcess = process;

  let outputFilePath: string | null = null;
  let videoTitle: string | null = null;

  // Last-known progress fields, so we can throttle and still respond if
  // a chunk lands without an updated value (e.g. only ETA changed).
  let lastEmittedAt = 0;
  const PROGRESS_THROTTLE_MS = 250;

  const handleLine = (line: string) => {
    if (!line.trim()) return;

    // Custom progress template: `JCUT_PROGRESS  45.3% 5.20MiB/s 00:10`
    // Width-padded fields can introduce extra whitespace — split on
    // runs of whitespace rather than fixed positions.
    if (line.startsWith(PROGRESS_TAG)) {
      const parts = line.slice(PROGRESS_TAG.length).trim().split(/\s+/);
      const [percentRaw, speedRaw, etaRaw] = parts;
      const percent = percentRaw ? parseFloat(percentRaw.replace(/%$/, '')) : NaN;
      // yt-dlp emits "NA" / "N/A" / "Unknown" for unknown fields. Pass
      // them through to the renderer as-is rather than blocking the
      // whole event — at least the % bar moves.
      const now = Date.now();
      if (now - lastEmittedAt >= PROGRESS_THROTTLE_MS) {
        lastEmittedAt = now;
        args.onProgress({
          percent: Number.isFinite(percent) ? percent : 0,
          speed: speedRaw ?? '',
          eta: etaRaw ?? '',
        });
      }
      return;
    }

    // Fallback for the default `[download] 45.3% of ...` format. Kept in
    // case the custom template is dropped for some yt-dlp build / phase.
    const legacyMatch = line.match(
      /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/,
    );
    if (legacyMatch && legacyMatch[1] && legacyMatch[2] && legacyMatch[3]) {
      const now = Date.now();
      if (now - lastEmittedAt >= PROGRESS_THROTTLE_MS) {
        lastEmittedAt = now;
        args.onProgress({
          percent: parseFloat(legacyMatch[1]),
          speed: legacyMatch[2],
          eta: legacyMatch[3],
        });
      }
      return;
    }

    // `--print after_move:filepath` and `--print title` emit bare lines
    // (no `[stage]` prefix) at the end of the run.
    if (!line.startsWith('[') && !line.startsWith(PROGRESS_TAG)) {
      if (!videoTitle) {
        videoTitle = line.trim();
      } else {
        outputFilePath = line.trim();
      }
      return;
    }

    // "[download] xxx has already been downloaded" — yt-dlp short-
    // circuits when the file is present. We still need the path.
    const alreadyDownloadedMatch = line.match(
      /\[download\]\s+(.+) has already been downloaded/,
    );
    if (alreadyDownloadedMatch && alreadyDownloadedMatch[1]) {
      outputFilePath = alreadyDownloadedMatch[1];
      return;
    }

    // Merger phase confirms the final container path.
    const mergerMatch = line.match(/\[Merger\]\s+Merging formats into "(.+)"/);
    if (mergerMatch && mergerMatch[1]) {
      outputFilePath = mergerMatch[1];
    }
  };

  process.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) handleLine(line);
  });

  process.stderr.on('data', (data: Buffer) => {
    console.warn('[yt-dlp stderr]', data.toString());
  });

  return new Promise((resolve, reject) => {
    process.on('exit', (code: number | null) => {
      currentProcess = null;
      if (code === 0 && outputFilePath) {
        resolve({ filePath: outputFilePath, title: videoTitle || path.basename(outputFilePath) });
      } else if (code === 0 && !outputFilePath) {
        reject(new Error('Download finished but output file path was not captured.'));
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    process.on('error', (err: Error) => {
      currentProcess = null;
      reject(err);
    });
  });
}

export async function cancelDownload(): Promise<void> {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}

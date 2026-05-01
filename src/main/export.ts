import { app } from 'electron';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  EXPORT_CANCELLED,
  type ExportProgress,
  type ExportRegion,
  type ExportResult,
  type SubtitleStyle,
  type TranscriptCue,
} from '../common/types';
import { deriveKeptRegions } from '../common/segments';
import { buildAss } from '../common/subtitle';
import { parseProgressLine } from './progress';
import { listInstalledFonts } from './fonts';
import { loadSubtitleSettings } from './subtitleSettings';

// Conservative threshold to switch from inline `-filter_complex` to
// `-filter_complex_script <file>`. Windows command line cap is ~8191 chars
// total, so 4096 leaves comfortable room for the rest of the args.
const FILTER_INLINE_LIMIT = 4096;

type ActiveJob = {
  ac: AbortController;
  finalPath: string;
  tmpPath: string;
  filterScriptPath?: string;
  assPath?: string;
};

let activeJob: ActiveJob | null = null;

const baseNameNoExt = (p: string): string =>
  path.basename(p, path.extname(p));

// Escape a Windows absolute path for use as a filter argument value. The
// filter-graph parser treats `\` as an escape, `:` as the option-pair
// separator, and `'` as a string delimiter. Forward slashes are accepted by
// FFmpeg on Windows for both file paths and directory args, so we
// normalise to `/` and escape only `:`.
//   `C:\Users\Sakan\foo.ass` -> `C\:/Users/Sakan/foo.ass`
const escapeFilterPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/:/g, '\\:');

function buildFilterComplex(
  regions: ExportRegion[],
  subtitleFilter: string | null,
): string {
  const parts: string[] = [];
  const concatInputs: string[] = [];
  regions.forEach((r, i) => {
    parts.push(
      `[0:v]trim=start=${r.startSec}:end=${r.endSec},setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[0:a]atrim=start=${r.startSec}:end=${r.endSec},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });
  // Concat → labelled outputs. When subtitles are enabled we splice the
  // `subtitles` filter onto the concatenated video stream before exposing
  // it as `[outv]`.
  if (subtitleFilter) {
    return (
      parts.join(';') +
      ';' +
      concatInputs.join('') +
      `concat=n=${regions.length}:v=1:a=1[concatv][outa];` +
      `[concatv]${subtitleFilter}[outv]`
    );
  }
  return (
    parts.join(';') +
    ';' +
    concatInputs.join('') +
    `concat=n=${regions.length}:v=1:a=1[outv][outa]`
  );
}

function classifyError(stderr: string, originalMessage: string): Error {
  const text = (stderr + '\n' + originalMessage).toLowerCase();
  if (text.includes('no space left') || text.includes('enospc')) {
    return new Error('ディスク容量が不足しています');
  }
  if (text.includes('no such file') || text.includes('enoent')) {
    return new Error('入力動画が見つかりません');
  }
  if (
    text.includes('resource busy') ||
    text.includes('ebusy') ||
    text.includes('being used by another process')
  ) {
    return new Error(
      '書き出し先ファイルが他のプログラムで開かれている可能性があります。エクスプローラのプレビュー、別の動画プレイヤー等を閉じてからお試しください。',
    );
  }
  if (
    text.includes('permission denied') ||
    text.includes('eacces') ||
    text.includes('eperm') ||
    text.includes('access is denied')
  ) {
    return new Error(
      '書き出し先の書き込み権限がありません。ディレクトリの権限を確認してください。',
    );
  }
  if (
    text.includes('unable to find a suitable output format') ||
    text.includes('decoder not found') ||
    text.includes('encoder not found')
  ) {
    return new Error('この動画形式は書き出しに対応していません');
  }
  const detail = stderr.trim().slice(-500) || originalMessage;
  return new Error(`書き出しに失敗しました: ${detail}`);
}

// Decides whether subtitles should be burned for this run, and if so writes
// the ASS file and returns the filter fragment + temp path. Returns null
// when subtitles are disabled, no cue opts in, or the active style cannot
// be resolved — those cases fall back silently to a sub-less export so the
// concat path still works.
async function prepareSubtitles(args: {
  cues: TranscriptCue[];
  durationSec: number;
  videoWidth: number;
  videoHeight: number;
}): Promise<{ filter: string; assPath: string } | null> {
  let settings;
  try {
    settings = await loadSubtitleSettings();
  } catch (err) {
    console.warn('[export] subtitle settings load failed, skipping:', err);
    return null;
  }
  if (!settings.enabled) return null;

  const style: SubtitleStyle | undefined = settings.styles.find(
    (s) => s.id === settings.activeStyleId,
  );
  if (!style) {
    console.warn(
      '[export] active subtitle style not found, skipping subtitles',
    );
    return null;
  }

  const optedIn = args.cues.some(
    (c) => !c.deleted && c.showSubtitle && c.text.trim().length > 0,
  );
  if (!optedIn) return null;

  const installed = await listInstalledFonts().catch(() => []);
  const hasFont = installed.some((f) => f.family === style.fontFamily);
  if (!hasFont) {
    console.warn(
      `[export] font "${style.fontFamily}" not installed; skipping subtitles. Open the font manager and install it to enable burn-in.`,
    );
    return null;
  }

  const keptRegions = deriveKeptRegions(args.cues, args.durationSec);
  const ass = buildAss({
    cues: args.cues,
    keptRegions,
    style,
    videoWidth: args.videoWidth,
    videoHeight: args.videoHeight,
  });
  if (!/^Dialogue:/m.test(ass)) {
    // No actual events made it through (e.g. all opted-in cues fell into
    // deleted gaps). Skip rather than emit an empty ASS.
    return null;
  }

  const assPath = path.join(
    app.getPath('temp'),
    `jcut-subs-${Date.now()}.ass`,
  );
  // UTF-8 with BOM (﻿) — libass on some Windows builds mis-detects
  // encoding without it.
  await fs.writeFile(assPath, '﻿' + ass, 'utf8');

  // Same drive lives userData/fonts on every default Electron install
  // (both under %LOCALAPPDATA% / %APPDATA%). Both paths are escaped so
  // their drive-letter colons don't terminate the filter option list.
  const fontsDir = path.join(app.getPath('userData'), 'fonts');
  const filter = `subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}`;
  return { filter, assPath };
}

export async function startExport(args: {
  videoFilePath: string;
  regions: ExportRegion[];
  cues: TranscriptCue[];
  videoWidth: number;
  videoHeight: number;
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  if (activeJob) throw new Error('別の書き出しが実行中です');

  const { videoFilePath, regions, cues, videoWidth, videoHeight, onProgress } = args;
  if (regions.length === 0) {
    throw new Error('書き出すべき区間がありません(全て削除されています)');
  }

  const dir = path.dirname(videoFilePath);
  const base = baseNameNoExt(videoFilePath);
  const finalPath = path.join(dir, `${base}.cut.mp4`);
  const tmpPath = `${finalPath}.tmp`;

  // Sweep up any stale tmp file from a prior cancelled / crashed run.
  await fs.rm(tmpPath, { force: true });

  const totalKeptSec = regions.reduce(
    (s, r) => s + Math.max(0, r.endSec - r.startSec),
    0,
  );
  const totalKeptMicros = Math.max(1, Math.round(totalKeptSec * 1_000_000));

  // Generate ASS now, even though FFmpeg won't read it for several seconds.
  // If anything goes wrong we treat it as non-fatal and emit a warning —
  // MVP policy is "the cut still ships" rather than blocking the export on
  // a subtitle-only error.
  let subtitleSetup: { filter: string; assPath: string } | null = null;
  try {
    subtitleSetup = await prepareSubtitles({
      cues,
      // Use the regions sum as a conservative duration for kept-region
      // derivation — the renderer also includes durationSec via the
      // region start/end inputs, but inside main we don't have it
      // separately. Recomputing keptRegions here keeps the timecode
      // mapping deterministic regardless of which component derived
      // them.
      durationSec: totalKeptSec + 0.001,
      videoWidth,
      videoHeight,
    });
  } catch (err) {
    console.warn('[export] subtitle prepare failed, exporting without:', err);
    subtitleSetup = null;
  }

  const filterGraph = buildFilterComplex(
    regions,
    subtitleSetup?.filter ?? null,
  );

  let filterArgs: string[];
  let filterScriptPath: string | undefined;
  if (filterGraph.length > FILTER_INLINE_LIMIT) {
    filterScriptPath = path.join(
      app.getPath('temp'),
      `jcut-filter-${Date.now()}.txt`,
    );
    await fs.writeFile(filterScriptPath, filterGraph, 'utf8');
    filterArgs = ['-filter_complex_script', filterScriptPath];
  } else {
    filterArgs = ['-filter_complex', filterGraph];
  }

  const ffmpegArgs = [
    '-hide_banner', '-nostdin', '-y',
    '-i', videoFilePath,
    ...filterArgs,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    // Force mp4 muxer because the tmp filename ends in `.mp4.tmp` and ffmpeg
    // can't infer the format from the extension. Renamed to `.cut.mp4` after
    // success.
    '-f', 'mp4',
    tmpPath,
    '-progress', 'pipe:1',
  ];

  console.log(
    '[export] regions:',
    regions.length,
    'totalKeptSec:',
    totalKeptSec.toFixed(2),
    'filterLen:',
    filterGraph.length,
    'script:',
    filterScriptPath ? 'yes' : 'no',
    'subtitles:',
    subtitleSetup ? 'yes' : 'no',
  );

  const ac = new AbortController();
  const job: ActiveJob = { ac, finalPath, tmpPath };
  if (filterScriptPath) job.filterScriptPath = filterScriptPath;
  if (subtitleSetup) job.assPath = subtitleSetup.assPath;
  activeJob = job;

  const proc = execa('ffmpeg', ffmpegArgs, {
    cancelSignal: ac.signal,
    encoding: 'utf8',
    buffer: false,
  });

  const startedAt = Date.now();
  let lastSpeed: number | undefined;

  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const parsed = parseProgressLine(line);
      if (!parsed) return;
      if (parsed.speed != null) lastSpeed = parsed.speed;
      if (parsed.outTimeMicros != null) {
        const ratio = Math.min(1, parsed.outTimeMicros / totalKeptMicros);
        onProgress({
          ratio,
          elapsedSec: (Date.now() - startedAt) / 1000,
          ...(lastSpeed != null && { speed: lastSpeed }),
        });
      }
    });
  }

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
  });

  const cleanupTransients = async () => {
    if (filterScriptPath) {
      await fs.rm(filterScriptPath, { force: true }).catch(() => {});
    }
    if (subtitleSetup) {
      await fs.rm(subtitleSetup.assPath, { force: true }).catch(() => {});
    }
  };

  const cleanupAfterFailure = async () => {
    await fs.rm(tmpPath, { force: true });
    await cleanupTransients();
  };

  try {
    await proc;
  } catch (err) {
    const cancelled =
      ac.signal.aborted ||
      (err as { isCanceled?: boolean }).isCanceled ||
      (err as { isTerminated?: boolean }).isTerminated;
    await cleanupAfterFailure();
    if (cancelled) {
      const e = new Error('cancelled');
      e.name = EXPORT_CANCELLED;
      throw e;
    }
    throw classifyError(stderrBuf, (err as Error).message);
  } finally {
    activeJob = null;
  }

  // Clean transient files (success path).
  await cleanupTransients();

  // Atomic-ish swap: tmp → final. Overwrite any prior export.
  await fs.rm(finalPath, { force: true });
  await fs.rename(tmpPath, finalPath);

  const stat = await fs.stat(finalPath);
  if (stat.size === 0) {
    await fs.rm(finalPath, { force: true });
    throw new Error('書き出されたファイルが空です。書き出しに失敗しました。');
  }

  // Snap progress to 100%.
  onProgress({
    ratio: 1,
    elapsedSec: (Date.now() - startedAt) / 1000,
    ...(lastSpeed != null && { speed: lastSpeed }),
  });

  return {
    outputPath: finalPath,
    sizeBytes: stat.size,
    durationSec: totalKeptSec,
    generatedAt: Date.now(),
  };
}

export async function cancelExport(): Promise<void> {
  activeJob?.ac.abort();
}

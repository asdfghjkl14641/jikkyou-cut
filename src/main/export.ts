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
} from '../common/types';
import { parseProgressLine } from './progress';

// Conservative threshold to switch from inline `-filter_complex` to
// `-filter_complex_script <file>`. Windows command line cap is ~8191 chars
// total, so 4096 leaves comfortable room for the rest of the args.
const FILTER_INLINE_LIMIT = 4096;

type ActiveJob = {
  ac: AbortController;
  finalPath: string;
  tmpPath: string;
  filterScriptPath?: string;
};

let activeJob: ActiveJob | null = null;

const baseNameNoExt = (p: string): string =>
  path.basename(p, path.extname(p));

function buildFilterComplex(regions: ExportRegion[]): string {
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

export async function startExport(args: {
  videoFilePath: string;
  regions: ExportRegion[];
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  if (activeJob) throw new Error('別の書き出しが実行中です');

  const { videoFilePath, regions, onProgress } = args;
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

  const filterGraph = buildFilterComplex(regions);

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
  );

  const ac = new AbortController();
  const job: ActiveJob = { ac, finalPath, tmpPath };
  if (filterScriptPath) job.filterScriptPath = filterScriptPath;
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

  const cleanupAfterFailure = async () => {
    await fs.rm(tmpPath, { force: true });
    if (filterScriptPath) {
      await fs.rm(filterScriptPath, { force: true }).catch(() => {});
    }
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

  // Clean filter script (success path).
  if (filterScriptPath) {
    await fs.rm(filterScriptPath, { force: true }).catch(() => {});
  }

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

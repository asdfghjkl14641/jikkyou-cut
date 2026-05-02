import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { logWarn } from './logger';

// Pulls metadata + heatmap + chapters + thumbnail from a single yt-dlp
// invocation. Used by the data-collection pipeline; not the same path
// as urlDownload.ts (which runs an actual download).
//
// Output: { meta, peaks, chapters, thumbnailPath } — all renderer-safe
// shapes. The DB layer takes these directly.

export type ExtractedHeatmapPoint = {
  start_time: number;
  end_time: number;
  value: number;
};

export type ExtractedChapter = {
  title: string;
  start_time: number;
  end_time: number;
};

export type ExtractedVideoMeta = {
  id: string;
  title: string;
  channel?: string;
  channel_id?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  duration?: number;
  upload_date?: string;       // YYYYMMDD per yt-dlp
  description?: string;
  heatmap?: ExtractedHeatmapPoint[] | null;
  chapters?: ExtractedChapter[] | null;
};

export type ExtractedTopPeak = {
  rank: number;
  startSec: number;
  endSec: number;
  peakValue: number;
  chapterTitle: string | null;
};

export type ExtractResult = {
  meta: ExtractedVideoMeta;
  peaks: ExtractedTopPeak[];
  chapters: ExtractedChapter[];
  thumbnailPath: string | null;
};

const MAX_PEAKS = 3;
// Peaks within this many seconds of an already-picked peak are skipped.
// Keeps the top-3 from collapsing onto a single broad cluster.
const PEAK_SPACING_SEC = 30;

const YT_DLP_PRINT_TAG = 'JCUT_DATA||';

function getYtDlpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');
}

const thumbnailDir = (): string =>
  path.join(app.getPath('userData'), 'data-collection', 'thumbnails');

// Pick top-N peaks with non-overlap spacing. Returns chronological order.
export function pickTopPeaks(
  heatmap: ExtractedHeatmapPoint[] | null | undefined,
  chapters: ExtractedChapter[] | null | undefined,
  windowSec = PEAK_SPACING_SEC,
): ExtractedTopPeak[] {
  if (!heatmap || heatmap.length === 0) return [];
  // Sort by value desc, then greedy non-overlap with already-picked.
  const sorted = [...heatmap].sort((a, b) => b.value - a.value);
  const picked: ExtractedHeatmapPoint[] = [];
  for (const point of sorted) {
    if (picked.length >= MAX_PEAKS) break;
    const tooClose = picked.some((p) => {
      const ac = (p.start_time + p.end_time) / 2;
      const bc = (point.start_time + point.end_time) / 2;
      return Math.abs(ac - bc) < windowSec;
    });
    if (tooClose) continue;
    picked.push(point);
  }
  picked.sort((a, b) => a.start_time - b.start_time);

  return picked.map((p, i) => {
    let chapterTitle: string | null = null;
    if (chapters && chapters.length > 0) {
      const peakCentre = (p.start_time + p.end_time) / 2;
      const ch = chapters.find(
        (c) => peakCentre >= c.start_time && peakCentre < c.end_time,
      );
      chapterTitle = ch?.title ?? null;
    }
    return {
      rank: i + 1,
      startSec: p.start_time,
      endSec: p.end_time,
      peakValue: p.value,
      chapterTitle,
    };
  });
}

// Strip the leading "JCUT_DATA||" wrapper and parse JSON. yt-dlp's
// `--print` template gives us one fully-formed JSON object per video.
function parseDataLine(line: string): ExtractedVideoMeta | null {
  if (!line.startsWith(YT_DLP_PRINT_TAG)) return null;
  const json = line.slice(YT_DLP_PRINT_TAG.length).trim();
  if (!json || json === 'NA') return null;
  try {
    return JSON.parse(json) as ExtractedVideoMeta;
  } catch {
    return null;
  }
}

export async function extractVideoData(args: {
  url: string;
  withThumbnail?: boolean;
}): Promise<ExtractResult | null> {
  await fs.mkdir(thumbnailDir(), { recursive: true });
  const ytdlp = getYtDlpPath();

  const ytArgs = [
    '--skip-download',
    '--no-warnings',
    '--no-playlist',
    // Single combined-print template — one line per video, our parser
    // peels the JCUT_DATA prefix and JSON.parses the rest.
    '--print',
    `${YT_DLP_PRINT_TAG}%(.{id,title,channel,channel_id,view_count,like_count,comment_count,duration,upload_date,description,heatmap,chapters})j`,
  ];
  if (args.withThumbnail) {
    ytArgs.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
    ytArgs.push('-o', `${thumbnailDir()}${path.sep}%(id)s.%(ext)s`);
  }
  ytArgs.push(args.url);

  return new Promise((resolve) => {
    const proc = spawn(ytdlp, ytArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('exit', (code) => {
      if (code !== 0) {
        // Common: video deleted / region-blocked. We log and let the
        // caller record this as a failed-to-collect entry.
        const reason = stderr.split(/\r?\n/).find((l) => l.trim().length > 0)?.slice(0, 200) ?? '';
        logWarn(`yt-dlp failed for ${args.url} (code=${code}): ${reason}`);
        resolve(null);
        return;
      }
      const meta = stdout
        .split(/\r?\n/)
        .map(parseDataLine)
        .find((m): m is ExtractedVideoMeta => m != null) ?? null;
      if (!meta) {
        logWarn(`no JCUT_DATA line in yt-dlp output for ${args.url}`);
        resolve(null);
        return;
      }
      const peaks = pickTopPeaks(meta.heatmap, meta.chapters);
      const chapters = (meta.chapters ?? []).map((c) => ({
        title: c.title,
        start_time: c.start_time,
        end_time: c.end_time,
      }));

      // Thumbnail file lookup. yt-dlp writes the converted .jpg next to
      // the path template we set above, but only when --write-thumbnail
      // succeeded — silent failures (private video etc) leave nothing
      // there.
      const thumbnailPath = args.withThumbnail
        ? path.join(thumbnailDir(), `${meta.id}.jpg`)
        : null;
      // Async existence check would be nice but the calling site is
      // already awaiting the whole resolve, so a sync stat lookup
      // costs us nothing extra.
      let resolvedThumbPath: string | null = null;
      if (thumbnailPath) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fsSync = require('node:fs') as typeof import('node:fs');
          if (fsSync.existsSync(thumbnailPath)) resolvedThumbPath = thumbnailPath;
        } catch {
          // ignore — thumbnail is best-effort
        }
      }

      resolve({
        meta,
        peaks,
        chapters,
        thumbnailPath: resolvedThumbPath,
      });
    });
    proc.on('error', (err) => {
      logWarn(`yt-dlp spawn failed: ${err.message}`);
      resolve(null);
    });
  });
}

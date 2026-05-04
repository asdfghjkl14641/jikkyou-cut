import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { loadConfig } from './config';
import { streamRecorder } from './streamRecorder';
import type { RecentVideo } from '../common/types';

// File extensions we'll surface in the URL-DL scan.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.mov']);

export async function listRecentVideos(maxAgeHours: number): Promise<RecentVideo[]> {
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const result: RecentVideo[] = [];
  const seenPaths = new Set<string>();

  // a. Auto-recorded streams.
  try {
    const recordings = await streamRecorder.list();
    for (const meta of recordings) {
      const startedAtMs = new Date(meta.startedAt).getTime();
      if (!Number.isFinite(startedAtMs) || startedAtMs < cutoffMs) continue;

      const fname = meta.files.vod ?? meta.files.live;
      if (!fname) continue;
      const filePath = path.join(meta.folder, fname);
      const sizeBytes =
        meta.files.vod && meta.fileSizeBytes.vod != null
          ? meta.fileSizeBytes.vod
          : (meta.fileSizeBytes.live ?? 0);

      seenPaths.add(filePath);

      const thumbPath = path.join(meta.folder, `${meta.recordingId}.thumb.jpg`);
      const finalThumbPath = await getOrGenerateThumbnail(filePath, thumbPath);

      result.push({
        source: 'recording',
        filePath,
        fileName: fname,
        fileSizeBytes: sizeBytes,
        createdAt: meta.startedAt,
        platform: meta.platform,
        channelDisplayName: meta.displayName,
        title: meta.title,
        recordingId: meta.recordingId,
        recordingStatus: meta.status,
        thumbnailPath: finalThumbPath,
      });
    }
  } catch (err) {
    console.warn('[recent-videos] streamRecorder.list failed:', err);
  }

  // b. URL-download directory scan.
  try {
    const cfg = await loadConfig();
    const dir = cfg.defaultDownloadDir;
    if (dir) {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      for (const fileName of entries) {
        const ext = path.extname(fileName).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        const filePath = path.join(dir, fileName);
        if (seenPaths.has(filePath)) continue;

        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < cutoffMs) continue;

        seenPaths.add(filePath);

        // Try to get metadata from .info.json
        const info = await getUrlDownloadMetadata(filePath);
        let thumbnailPath: string | null = null;

        if (info.thumbnailUrl) {
          thumbnailPath = await downloadAndCacheThumbnail(info.thumbnailUrl, filePath);
        }

        // Fallback to ffmpeg if no thumbnail yet
        if (!thumbnailPath) {
          const fallbackThumbPath = filePath.replace(/\.[^.]+$/, '.thumb.jpg');
          thumbnailPath = await getOrGenerateThumbnail(filePath, fallbackThumbPath);
        }

        result.push({
          source: 'url-download',
          filePath,
          fileName,
          fileSizeBytes: stat.size,
          createdAt: new Date(stat.mtimeMs).toISOString(),
          // RecentVideo's optional fields use `string | undefined`;
          // the .info.json parser returns `string | null`. Coerce so
          // an absent yt-dlp metadata file doesn't poison the typed
          // boundary with `null`.
          title: info.title ?? undefined,
          channelDisplayName: info.channel ?? undefined,
          thumbnailPath: thumbnailPath,
          thumbnailUrl: info.thumbnailUrl,
        });
      }
    }
  } catch (err) {
    console.warn('[recent-videos] download-dir scan failed:', err);
  }

  // Newest first.
  result.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return result;
}

// Minimum file size before we bother trying ffmpeg. Growing live captures
// under ~5 MB rarely have a usable moov atom yet — ffmpeg either fails
// outright or produces a 0-byte thumb, both of which we want to avoid
// retrying every 60s.
const MIN_FILE_BYTES_FOR_THUMB = 5 * 1024 * 1024;

// In-memory failure cache: thumbPath → ts of the last failed attempt.
// 5 minute backoff before re-trying. Without this, the renderer's 60s
// poll would re-run ffmpeg on the same growing file every minute,
// burning CPU + filling logs with the same warnings.
const FAILED_THUMB_TTL_MS = 5 * 60 * 1000;
const failedThumbCache = new Map<string, number>();

async function safeStat(p: string): Promise<{ size: number } | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * Extract a single frame as the recording's thumbnail. Cached to disk
 * next to the video. Robust against:
 *   - growing live captures (we skip if file is too small / abort if
 *     ffmpeg produces a 0-byte output)
 *   - repeated calls on a known-failed file (5 min in-memory backoff)
 *   - source files shorter than 60s (we re-try at 0s)
 */
async function getOrGenerateThumbnail(videoPath: string, thumbPath: string): Promise<string | null> {
  // Existing-and-non-empty thumb wins immediately.
  const existing = await safeStat(thumbPath);
  if (existing && existing.size > 0) return thumbPath;
  // 0-byte residue from a prior failed attempt — delete so the
  // generation loop below isn't fooled by existsSync.
  if (existing && existing.size === 0) {
    await fs.unlink(thumbPath).catch(() => undefined);
  }

  // Recent-failure backoff.
  const lastFail = failedThumbCache.get(thumbPath);
  if (lastFail && Date.now() - lastFail < FAILED_THUMB_TTL_MS) {
    return null;
  }

  // Source-file size gate. Live captures don't have a usable moov atom
  // until they've grown past a few seconds of fragments.
  const srcStat = await safeStat(videoPath);
  if (!srcStat || srcStat.size < MIN_FILE_BYTES_FOR_THUMB) {
    failedThumbCache.set(thumbPath, Date.now());
    return null;
  }

  // Try at 60s first (skip past intro / standby screen), then fall back
  // to the very first frame for short clips. `-update 1` is required by
  // FFmpeg 8+ for single-image output when the path doesn't contain a
  // `%d` pattern; without it FFmpeg logs a parse warning that's
  // confusing in the dev console.
  for (const seekArgs of [['-ss', '60'], [] as string[]]) {
    try {
      await execa('ffmpeg', [
        '-hide_banner', '-nostdin', '-y',
        ...seekArgs,
        '-i', videoPath,
        '-frames:v', '1',
        '-update', '1',
        '-q:v', '4',
        thumbPath,
      ], { timeout: 30_000 });
      const out = await safeStat(thumbPath);
      if (out && out.size > 0) {
        failedThumbCache.delete(thumbPath);
        return thumbPath;
      }
      // ffmpeg "succeeded" but wrote a 0-byte file. Clean up + try the
      // next seek position.
      await fs.unlink(thumbPath).catch(() => undefined);
    } catch {
      // fall through to next seek position
    }
  }

  failedThumbCache.set(thumbPath, Date.now());
  return null;
}

async function getUrlDownloadMetadata(filePath: string): Promise<{
  title: string | null;
  channel: string | null;
  thumbnailUrl: string | null;
}> {
  const infoJsonPath = filePath.replace(/\.[^.]+$/, '.info.json');
  if (!existsSync(infoJsonPath)) return { title: null, channel: null, thumbnailUrl: null };

  try {
    const raw = await fs.readFile(infoJsonPath, 'utf8');
    const info = JSON.parse(raw);
    return {
      title: info.title || null,
      channel: info.channel || info.uploader || null,
      thumbnailUrl: info.thumbnail || (info.thumbnails?.length ? info.thumbnails[info.thumbnails.length - 1].url : null),
    };
  } catch {
    return { title: null, channel: null, thumbnailUrl: null };
  }
}

async function downloadAndCacheThumbnail(url: string, videoPath: string): Promise<string | null> {
  const thumbPath = videoPath.replace(/\.[^.]+$/, '.thumb.jpg');
  // Existing non-empty cache wins. 0-byte residue from a previous
  // botched download would otherwise be served as a broken image.
  const existing = await safeStat(thumbPath);
  if (existing && existing.size > 0) return thumbPath;
  if (existing) await fs.unlink(thumbPath).catch(() => undefined);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    await fs.writeFile(thumbPath, Buffer.from(buf));
    return thumbPath;
  } catch (err) {
    console.warn('[recent-videos] thumbnail download failed:', err);
    return null;
  }
}

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

/**
 * Extracts a frame from the video at 60s mark to use as a thumbnail.
 * Cached to disk next to the video file.
 */
async function getOrGenerateThumbnail(videoPath: string, thumbPath: string): Promise<string | null> {
  if (existsSync(thumbPath)) return thumbPath;

  try {
    // If the file is still being recorded, ffmpeg might fail or produce a partial result.
    // We try anyway; worst case it fails and we show the fallback icon.
    await execa('ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-i', videoPath,
      '-ss', '60',
      '-frames:v', '1',
      '-q:v', '4', // slightly lower quality for smaller thumbs
      thumbPath,
    ]);
    return thumbPath;
  } catch (err) {
    // Some videos are shorter than 60s, try at 0s.
    try {
      await execa('ffmpeg', [
        '-hide_banner', '-nostdin', '-y',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '4',
        thumbPath,
      ]);
      return thumbPath;
    } catch {
      return null;
    }
  }
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
  if (existsSync(thumbPath)) return thumbPath;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    await fs.writeFile(thumbPath, Buffer.from(buf));
    return thumbPath;
  } catch (err) {
    console.warn('[recent-videos] thumbnail download failed:', err);
    return null;
  }
}

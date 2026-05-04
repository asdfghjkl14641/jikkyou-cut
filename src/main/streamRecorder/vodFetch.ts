// Post-live VOD acquisition.
//
// Twitch:
//   - After the broadcast ends, helix/videos?type=archive lists the
//     auto-archived VOD. There's usually a delay of seconds-to-
//     minutes before it appears.
//   - We poll up to 3 attempts with 5-minute backoff. Long stretches
//     of unavailability typically mean the streamer disabled archives.
//
// YouTube:
//   - A live stream's video_id stays the same after it ends; we just
//     wait for `liveStreamingDetails.actualEndTime` to be populated
//     so the archive is known to be processed.
//   - actualEndTime arrives within a minute or two; processing into
//     a fully-seekable VOD can take longer for long streams. Once
//     actualEndTime is set we hand off to yt-dlp regardless — it
//     handles "still processing" gracefully and downloads what's ready.
//
// Once the URL is known, we spawn yt-dlp directly. We deliberately
// do NOT call urlDownload.downloadVideoOnly: that path uses an
// abort-on-unavailable-fragment + 30-retry posture suited to one-off
// user clicks, and the format selector / output template don't fit
// the recordings folder layout we want.

import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from '../config';
import { loadTwitchSecret } from '../secureStorage';
import { fetchVideoLiveDetails } from '../dataCollection/youtubeApi';
import { getLatestArchiveVod } from '../twitchHelix';
import type { RecordingMetadata } from '../../common/types';

function getYtDlpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');
}

const TWITCH_VOD_ATTEMPTS = 3;
const TWITCH_VOD_BACKOFF_MS = 5 * 60_000;
const YOUTUBE_VOD_ATTEMPTS = 4;
const YOUTUBE_VOD_BACKOFF_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type VodResolution =
  | { kind: 'ready'; url: string }
  | { kind: 'unavailable'; reason: string };

// Resolve the post-live VOD URL for the recording. Polls with backoff;
// returns 'unavailable' when the platform never publishes one
// (private archive, channel disabled it, etc.).
export async function resolveVodUrl(meta: RecordingMetadata): Promise<VodResolution> {
  if (meta.platform === 'twitch') {
    return resolveTwitchVod(meta);
  }
  return resolveYouTubeVod(meta);
}

async function resolveTwitchVod(meta: RecordingMetadata): Promise<VodResolution> {
  const cfg = await loadConfig();
  const sec = await loadTwitchSecret();
  if (!cfg.twitchClientId || !sec) {
    return { kind: 'unavailable', reason: 'Twitch credentials not configured' };
  }
  for (let attempt = 0; attempt < TWITCH_VOD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      console.log(
        `[stream-recorder] twitch VOD wait: ${TWITCH_VOD_BACKOFF_MS / 1000}s before attempt ${attempt + 1}`,
      );
      await sleep(TWITCH_VOD_BACKOFF_MS);
    }
    try {
      const archive = await getLatestArchiveVod(cfg.twitchClientId, sec, meta.creatorKey);
      if (!archive) continue;
      // Sanity: ensure the archive's `published_at` is at-or-after our
      // `startedAt`. Otherwise we'd grab a pre-existing earlier VOD.
      const archiveTs = new Date(archive.publishedAt).getTime();
      const startTs = new Date(meta.startedAt).getTime();
      if (archiveTs + 60_000 < startTs) {
        // Archive predates our recording's start — wait and retry.
        continue;
      }
      return { kind: 'ready', url: archive.url };
    } catch (err) {
      console.warn('[stream-recorder] twitch VOD lookup error:', err);
    }
  }
  return { kind: 'unavailable', reason: 'Twitch archive not available within retry window' };
}

async function resolveYouTubeVod(meta: RecordingMetadata): Promise<VodResolution> {
  // YouTube live's video_id was the streamMonitor's videoId, which
  // is encoded in `meta.sourceUrl` as `?v=<id>`. Extract.
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(meta.sourceUrl);
  if (!m) {
    return { kind: 'unavailable', reason: 'Could not extract YouTube videoId from sourceUrl' };
  }
  const videoId = m[1]!;
  for (let attempt = 0; attempt < YOUTUBE_VOD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      console.log(
        `[stream-recorder] youtube VOD wait: ${YOUTUBE_VOD_BACKOFF_MS / 1000}s before attempt ${attempt + 1}`,
      );
      await sleep(YOUTUBE_VOD_BACKOFF_MS);
    }
    try {
      const details = await fetchVideoLiveDetails([videoId]);
      const d = details[0];
      if (d && d.actualEndTime) {
        return { kind: 'ready', url: meta.sourceUrl };
      }
    } catch (err) {
      console.warn('[stream-recorder] youtube VOD lookup error:', err);
    }
  }
  return { kind: 'unavailable', reason: 'YouTube actualEndTime not populated within retry window' };
}

// Spawn yt-dlp to download the resolved VOD into the recording folder.
// Resolves with the produced file's basename on success, or null on
// failure. We don't throw — the caller updates metadata to 'failed'
// based on the null return.
export async function downloadVod(opts: {
  url: string;
  meta: RecordingMetadata;
  quality: 'best' | '1080p' | '720p';
  cookiesArgs: string[]; // pre-built --cookies-from-browser / --cookies args
}): Promise<string | null> {
  const exe = getYtDlpPath();
  const heightFilter = opts.quality === 'best' ? '' : `[height<=${opts.quality.replace('p', '')}]`;
  const format = `bestvideo${heightFilter}+bestaudio/best${heightFilter}/best`;
  const outputTemplate = path.join(opts.meta.folder, `${opts.meta.recordingId}.vod.%(ext)s`);

  const args: string[] = [
    opts.url,
    ...opts.cookiesArgs,
    '--js-runtimes', 'node',
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
    '--concurrent-fragments', '8',
    '--no-playlist',
    '--no-warnings',
    '--retries', '30',
    '--fragment-retries', '30',
    '--abort-on-unavailable-fragment',
    '--print', 'after_move:filepath',
  ];

  return new Promise<string | null>((resolve) => {
    console.log('[stream-recorder] vod yt-dlp spawn:', exe, '<args>');
    const proc = spawn(exe, args, { windowsHide: true });
    let producedPath: string | null = null;
    proc.stdout?.on('data', (b: Buffer) => {
      for (const line of b.toString().split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('[')) continue;
        if (trimmed.includes(path.sep) || trimmed.startsWith('/')) {
          producedPath = trimmed;
        }
      }
    });
    proc.stderr?.on('data', (b: Buffer) => {
      const text = b.toString().slice(0, 400);
      if (text.trim()) console.warn('[stream-recorder] vod yt-dlp stderr:', text);
    });
    proc.on('exit', (code) => {
      console.log('[stream-recorder] vod yt-dlp exit code:', code, 'path:', producedPath);
      if (code !== 0 || !producedPath) {
        resolve(null);
        return;
      }
      resolve(path.basename(producedPath));
    });
    proc.on('error', (err) => {
      console.warn('[stream-recorder] vod yt-dlp spawn error:', err);
      resolve(null);
    });
  });
}

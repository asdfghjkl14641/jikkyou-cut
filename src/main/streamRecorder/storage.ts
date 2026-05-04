// Recording metadata + filesystem layout helpers.
//
// Layout under `recordingDir`:
//   <recordingDir>/
//     <platform>/                 # 'twitch' or 'youtube'
//       <creator-folder>/          # sanitised displayName for human-
//                                  # readable directory names
//         <recordingId>.json       # metadata
//         <recordingId>.live.<ext> # live capture (mkv from streamlink,
//                                  # whatever yt-dlp picked otherwise)
//         <recordingId>.vod.mp4    # post-stream archive (yt-dlp)
//
// `recordingId` is `<platform>_<creatorKey>_<startedAt>` with the
// timestamp written as `YYYY-MM-DD_HH-mm-ss` so the disk listing
// already sorts chronologically.

import { app } from 'electron';
import {
  promises as fs,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RecordingMetadata, RecordingStatus } from '../../common/types';

// Default recording dir. Honoured when AppConfig.recordingDir is null.
export function defaultRecordingDir(): string {
  return path.join(app.getPath('userData'), 'recordings');
}

// File-system safe slug. Replaces anything that's not [A-Za-z0-9._-]
// or a CJK char with `-`, collapses runs, trims to a sensible length.
// CJK is preserved because the user-visible folder names look better
// with "葛葉" than with the URL-encoded escape.
export function sanitiseForFilesystem(s: string, maxLen = 60): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|]/g, '-') // hard-banned on Windows
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .trim();
  if (cleaned.length <= maxLen) return cleaned || 'unknown';
  return cleaned.slice(0, maxLen);
}

// Format an ISO timestamp into the filesystem-friendly stem we use
// for recording IDs. Produces `2026-05-04_03-15-00` (UTC).
export function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  );
}

export function makeRecordingId(opts: {
  platform: 'twitch' | 'youtube';
  creatorKey: string;
  startedAt: string;
}): string {
  return `${opts.platform}_${opts.creatorKey}_${formatStartedAt(opts.startedAt)}`;
}

export function recordingFolder(
  baseDir: string,
  meta: { platform: 'twitch' | 'youtube'; displayName: string; creatorKey: string },
): string {
  // Combine displayName + a short creatorKey suffix so two streamers
  // with identical display names don't clash on disk. Example:
  //   葛葉_kuzuha
  const folder = `${sanitiseForFilesystem(meta.displayName)}_${sanitiseForFilesystem(meta.creatorKey, 16)}`;
  return path.join(baseDir, meta.platform, folder);
}

export async function ensureFolder(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true });
}

export function metadataPath(folder: string, recordingId: string): string {
  return path.join(folder, `${recordingId}.json`);
}

export async function writeMetadata(meta: RecordingMetadata): Promise<void> {
  await ensureFolder(meta.folder);
  const p = metadataPath(meta.folder, meta.recordingId);
  await fs.writeFile(p, JSON.stringify(meta, null, 2), 'utf8');
}

// Synchronous variant for shutdown paths (`before-quit` handler).
// We need this because the async writeMetadata may not complete
// before Electron tears the process down — sync write blocks until
// the file is committed to disk so the next boot's recovery sweep
// sees the correct status. The folder mkdir is also sync for the
// same reason.
export function writeMetadataSync(meta: RecordingMetadata): void {
  try {
    mkdirSync(meta.folder, { recursive: true });
  } catch {
    // If mkdir fails the writeFileSync will throw too — let it
    // propagate one level up to the caller's try/catch.
  }
  const p = metadataPath(meta.folder, meta.recordingId);
  writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8');
}

export async function readMetadata(p: string): Promise<RecordingMetadata | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['recordingId'] !== 'string') return null;
    if (typeof parsed['platform'] !== 'string') return null;
    return parsed as unknown as RecordingMetadata;
  } catch {
    return null;
  }
}

// Walk the recording tree and return all metadata blobs. Used for
// list IPC + crash-recovery boot sweep. The walk is bounded — the
// only directories we descend into are <baseDir>/<platform>/<creator>,
// so depth is fixed at 3.
export async function listAllMetadata(baseDir: string): Promise<RecordingMetadata[]> {
  if (!existsSync(baseDir)) return [];
  const out: RecordingMetadata[] = [];
  for (const platformDir of safeListDirs(baseDir)) {
    if (platformDir !== 'twitch' && platformDir !== 'youtube') continue;
    const platformPath = path.join(baseDir, platformDir);
    for (const creatorDir of safeListDirs(platformPath)) {
      const creatorPath = path.join(platformPath, creatorDir);
      const entries = readdirSync(creatorPath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const meta = await readMetadata(path.join(creatorPath, e.name));
        if (!meta) continue;
        // Refresh fileSizeBytes on every read so the UI sees current
        // sizes without per-poll IPC. Cheap (just a stat per file).
        out.push(refreshFileSizes(meta));
      }
    }
  }
  // Newest first. A stable sort on startedAt descending matches the
  // user's natural "latest live first" expectation.
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return out;
}

function safeListDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function statSizeOrNull(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export function refreshFileSizes(meta: RecordingMetadata): RecordingMetadata {
  const live = meta.files.live ? statSizeOrNull(path.join(meta.folder, meta.files.live)) : null;
  const vod = meta.files.vod ? statSizeOrNull(path.join(meta.folder, meta.files.vod)) : null;
  // 2026-05-04 — Refresh per-segment sizes when the recording was
  // restart-rotated. Single-segment recordings skip this (liveSegments
  // is undefined, fileSizeBytes.live is the canonical size).
  const liveSegmentSizes = meta.liveSegments
    ? meta.liveSegments.map((f) => statSizeOrNull(path.join(meta.folder, f)) ?? 0)
    : undefined;
  const next: RecordingMetadata = {
    ...meta,
    fileSizeBytes: { live, vod },
  };
  if (liveSegmentSizes) next.liveSegmentSizes = liveSegmentSizes;
  return next;
}

// Crash-recovery sweep. Runs at app boot: any metadata stuck in
// 'recording' or 'vod-fetching' state means the previous process died
// mid-record. We mark those as 'failed' so the UI doesn't claim
// they're still in progress.
export async function recoverInterruptedRecordings(baseDir: string): Promise<number> {
  if (!existsSync(baseDir)) return 0;
  let recovered = 0;
  for (const meta of await listAllMetadata(baseDir)) {
    const stuck: RecordingStatus[] = ['recording', 'live-ended', 'vod-fetching'];
    if (stuck.includes(meta.status)) {
      const next: RecordingMetadata = {
        ...meta,
        status: 'failed',
        endedAt: meta.endedAt ?? new Date().toISOString(),
        errorMessage:
          (meta.errorMessage ? meta.errorMessage + ' / ' : '') +
          'previous app session ended unexpectedly',
      };
      await writeMetadata(next);
      recovered += 1;
    }
  }
  return recovered;
}

// Free-space probe for the recording disk. Returns null on platforms
// where statfs isn't available (we ship Windows-only so this is
// usually populated). The caller treats null as "unknown — proceed".
//
// node:fs.statfs landed in Node 18.15 / 20+; Electron 33 ships with
// Node 22 so it's available.
export async function freeBytes(absPath: string): Promise<number | null> {
  try {
    // statfs takes a directory, returns block count + size.
    const result = await fs.statfs(absPath);
    return result.bsize * Number(result.bavail);
  } catch {
    return null;
  }
}

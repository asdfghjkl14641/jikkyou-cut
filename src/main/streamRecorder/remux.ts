// 2026-05-04 — Post-record codec verification + lazy remux.
//
// HTML5 <video> in the renderer plays H.264/AAC/MP4 and VP9/Opus/WebM
// natively. yt-dlp's `--merge-output-format mp4` makes this work for
// most sources (Twitch HLS = h264/aac, YouTube live mostly avc1 at
// 1080p), but VP9 / AV1 / non-MP4 containers occasionally slip through
// and the editor refuses them silently. This module:
//   1) ffprobes the captured file
//   2) repackages to MP4 with `-c copy` when codecs allow (h264 + aac
//      or aac-adjacent), preserving quality + duration
//   3) leaves the file alone when codec forbids stream-copy (VP9 etc.)
//      and surfaces a `kind: 'incompatible'` result so the orchestrator
//      can warn the user
//
// Stream-copy remux is fast — typically a few seconds even on multi-GB
// files because ffmpeg just rewrites the container, no re-encode.

import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type CodecInfo = {
  videoCodec: string;
  audioCodec: string;
  // ffprobe reports a comma-separated list (e.g. "mov,mp4,m4a,3gp,3g2,mj2").
  // We surface the raw value; callers do substring checks.
  containerFormat: string;
};

// Codec → MP4-stream-copy compatibility table. h264 video + (aac | mp3)
// audio fits cleanly into the MP4 ISO base-media file format. Anything
// else (vp9, av1, opus, vorbis) requires a re-encode which we don't do
// for cost reasons.
const MP4_VIDEO_OK = new Set(['h264', 'avc1', 'h265', 'hevc']);
const MP4_AUDIO_OK = new Set(['aac', 'mp4a', 'mp3']);

export type RemuxResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'remuxed'; oldExt: string; newPath: string }
  | { kind: 'incompatible'; videoCodec: string; audioCodec: string }
  | { kind: 'failed'; error: string };

export async function getCodecInfo(filePath: string): Promise<CodecInfo | null> {
  try {
    const r = await execa(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,codec_type:format=format_name',
        '-of', 'json',
        filePath,
      ],
      { timeout: 10_000 },
    );
    const data = JSON.parse(r.stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string }>;
      format?: { format_name?: string };
    };
    const v = data.streams?.find((s) => s.codec_type === 'video')?.codec_name ?? 'unknown';
    const a = data.streams?.find((s) => s.codec_type === 'audio')?.codec_name ?? 'unknown';
    return {
      videoCodec: v,
      audioCodec: a,
      containerFormat: data.format?.format_name ?? 'unknown',
    };
  } catch (err) {
    console.warn('[remux] ffprobe failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Returns true when the file's container format string includes "mp4"
// (ffprobe reports a comma-separated alias list — e.g. "mov,mp4,m4a"
// for any ISO base-media variant including .mp4).
function isMp4Container(formatName: string): boolean {
  return formatName.split(',').some((s) => s === 'mp4' || s === 'mov');
}

// In-place remux from whatever container yt-dlp wrote into a clean
// `.mp4` with `-movflags +faststart` (moov atom at front so the
// renderer's <video> can start playing without seeking). Stream-copy
// only — no re-encode. Returns the FINAL absolute path, which may
// differ from `filePath` if the original extension wasn't `.mp4`.
async function remuxInPlace(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const baseNoExt = path.basename(filePath, path.extname(filePath));
  const targetPath = path.join(dir, `${baseNoExt}.mp4`);
  // Use a sibling tmp file so an interrupted ffmpeg doesn't corrupt
  // the source file before we've confirmed success.
  const tmpPath = path.join(dir, `${baseNoExt}.remux.tmp.mp4`);

  await execa(
    'ffmpeg',
    [
      '-hide_banner', '-nostdin', '-y',
      '-i', filePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      // Some HLS captures have spurious data streams (timed metadata,
      // SCTE-35, etc.) that the MP4 muxer rejects. Map only A/V.
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      tmpPath,
    ],
    // Multi-GB files take seconds at most — stream-copy throughput is
    // disk-limited, not CPU-limited. 10 minute upper bound is generous.
    { timeout: 10 * 60_000 },
  );

  // Replace original. If targetPath === filePath (already .mp4) the
  // unlink+rename collapses into "delete the bad one, rename tmp".
  // If they differ (.ts → .mp4) the original .ts is removed.
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Source might still be locked on Windows; the rename below will
    // still succeed because tmp → target is a different path. Just
    // log and leave the orphan for the user to delete manually.
    console.warn(`[remux] could not unlink original ${filePath}:`, err);
  }
  await fs.rename(tmpPath, targetPath);
  return targetPath;
}

// Top-level entry point. Caller passes the absolute path to a
// just-finished segment file; we decide what (if anything) to do.
export async function verifyAndRemuxIfNeeded(filePath: string): Promise<RemuxResult> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { kind: 'failed', error: 'file not found' };
  }
  if (stat.size === 0) {
    return { kind: 'failed', error: 'file is 0 bytes' };
  }

  const codec = await getCodecInfo(filePath);
  if (!codec) {
    return { kind: 'failed', error: 'ffprobe unavailable' };
  }

  const container = codec.containerFormat;
  const ext = path.extname(filePath).toLowerCase();
  const wantsMp4Container = isMp4Container(container) && ext === '.mp4';

  // Common case: yt-dlp + --merge-output-format mp4 already produced
  // h264+aac MP4. ffprobe confirms; we're done.
  if (
    wantsMp4Container &&
    MP4_VIDEO_OK.has(codec.videoCodec.toLowerCase()) &&
    MP4_AUDIO_OK.has(codec.audioCodec.toLowerCase())
  ) {
    return { kind: 'noop', reason: `already ${codec.videoCodec}/${codec.audioCodec}/mp4` };
  }

  // Codec forbids stream-copy to MP4 (VP9 / AV1 / Opus / Vorbis).
  // Re-encode is too expensive for a multi-hour archive; surface the
  // problem so the orchestrator can warn the user.
  if (
    !MP4_VIDEO_OK.has(codec.videoCodec.toLowerCase()) ||
    !MP4_AUDIO_OK.has(codec.audioCodec.toLowerCase())
  ) {
    console.warn(
      `[remux] incompatible codecs for stream-copy mp4: video=${codec.videoCodec}, audio=${codec.audioCodec}`,
    );
    return {
      kind: 'incompatible',
      videoCodec: codec.videoCodec,
      audioCodec: codec.audioCodec,
    };
  }

  // Codecs are MP4-friendly but the container is wrong (e.g. .ts wrapper
  // from HLS, or .mkv from yt-dlp falling back). Stream-copy remux.
  console.log(
    `[remux] repackaging ${path.basename(filePath)}: ` +
      `${codec.videoCodec}/${codec.audioCodec} in ${container}/${ext} → mp4`,
  );
  const oldExt = ext;
  try {
    const newPath = await remuxInPlace(filePath);
    return { kind: 'remuxed', oldExt, newPath };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

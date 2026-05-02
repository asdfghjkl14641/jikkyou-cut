import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, ChildProcess } from 'child_process';
import type { UrlDownloadProgress } from '../common/types';

// Post-DL sanity check: run ffprobe and verify video.duration ≈
// audio.duration. This is the second-line defence against the
// "truncated audio fragment" bug — even with --abort-on-unavailable-
// fragment in the yt-dlp args, a network glitch could still produce a
// duration-mismatched mp4 in edge cases (HLS manifest weirdness, server
// returning short fragments etc.). If we detect mismatch we surface it
// as a hard error so the user re-downloads instead of getting a file
// that plays video-only past some midway point.
const PROBE_DURATION_TOLERANCE_SEC = 5;

type ProbeStream = {
  index: number;
  codec_type: 'video' | 'audio' | string;
  codec_name?: string;
  duration?: string;
};

type ProbeOutput = {
  streams?: ProbeStream[];
};

async function probeDurations(filePath: string): Promise<{
  videoDuration: number | null;
  audioDuration: number | null;
  audioCodec: string | null;
  hasAudio: boolean;
}> {
  return new Promise((resolve) => {
    const ffprobeArgs = [
      '-v', 'error',
      '-show_streams',
      '-show_entries', 'stream=index,codec_type,codec_name,duration',
      '-of', 'json',
      filePath,
    ];
    // ffprobe is on PATH per the project's "system-installed FFmpeg 8.1"
    // requirement. We don't bundle our own copy — same as how export.ts
    // and audioExtraction.ts call ffmpeg.
    const proc = spawn('ffprobe', ffprobeArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('exit', (code) => {
      if (code !== 0) {
        // Don't fail the DL just because ffprobe choked — the user's
        // file might still be usable. Log the error and skip
        // validation rather than rejecting a healthy DL.
        console.warn('[url-download] ffprobe failed (skipping validation):', stderr.slice(0, 200));
        resolve({ videoDuration: null, audioDuration: null, audioCodec: null, hasAudio: false });
        return;
      }
      try {
        const json = JSON.parse(stdout) as ProbeOutput;
        let videoDuration: number | null = null;
        let audioDuration: number | null = null;
        let audioCodec: string | null = null;
        for (const s of json.streams ?? []) {
          const dur = s.duration ? parseFloat(s.duration) : NaN;
          if (s.codec_type === 'video' && Number.isFinite(dur) && videoDuration == null) {
            videoDuration = dur;
          } else if (s.codec_type === 'audio' && Number.isFinite(dur) && audioDuration == null) {
            audioDuration = dur;
            audioCodec = s.codec_name ?? null;
          }
        }
        resolve({
          videoDuration,
          audioDuration,
          audioCodec,
          hasAudio: audioDuration != null,
        });
      } catch (err) {
        console.warn('[url-download] ffprobe JSON parse failed:', err);
        resolve({ videoDuration: null, audioDuration: null, audioCodec: null, hasAudio: false });
      }
    });
    proc.on('error', (err) => {
      console.warn('[url-download] ffprobe spawn failed:', err);
      resolve({ videoDuration: null, audioDuration: null, audioCodec: null, hasAudio: false });
    });
  });
}

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
//   1. bestvideo[ext=mp4][vcodec^=avc1]<h> + bestaudio[ext=m4a]
//      → ideal: MP4-AVC1 (H.264) video + M4A AAC audio. Native <video>
//        support, merger runs as pure remux.
//   2. bestvideo[ext=mp4][vcodec^=avc1]<h> + bestaudio
//      → AVC1 video + ANY audio (often Opus webm). Merger transcodes
//        audio to AAC via the postprocessor-args set in the spawn call.
//   3. bestvideo<h> + bestaudio<h>
//      → last fallback when the source has no AVC1 variant. Both streams
//        get re-encoded by the postprocessor.
//   4. best[ext=mp4]<h> / best<h>
//      → single-file fallbacks. Already merged at source so we trust
//        them as-is.
//
// Why this is wider than before: the old selector was
// `avc1+m4a / mp4 / anything` and several real videos slipped into the
// `/anything` arm with non-AAC audio (Opus in webm) which Chromium then
// either silently dropped at decode or muted. Branch 2 keeps AVC1 video
// and lets the merger transcode audio, which is the real fix.
const buildFormatSelector = (quality: string): string => {
  const h = heightFilter(quality);
  if (quality === 'worst') {
    return 'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worstvideo+worstaudio/worst[ext=mp4]/worst';
  }
  return (
    `bestvideo[ext=mp4][vcodec^=avc1]${h}+bestaudio[ext=m4a]/` +
    `bestvideo[ext=mp4][vcodec^=avc1]${h}+bestaudio/` +
    `bestvideo${h}+bestaudio${h}/` +
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

  const ytDlpProcess: any = spawn(getYtDlpPath(), [
    args.url,
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    // Force the merger to produce an AAC audio track + faststart-flagged
    // moov atom. Reasons:
    //   * `-c:v copy` keeps the AVC1 video bitstream intact (we already
    //     selected avc1 in the format selector — re-encoding video would
    //     waste minutes for no quality gain).
    //   * `-c:a aac -b:a 192k` guarantees Chromium-decodable audio even
    //     when the source audio is Opus / Vorbis / etc. This is the
    //     load-bearing change for the "音声が出ない" bug — AVC1 + Opus
    //     in MP4 plays video but silently drops audio in <video>.
    //   * `-movflags +faststart` reorders the moov atom to the head so
    //     media:// Range requests don't have to fetch the tail before
    //     seeking works. Quality-of-life, not strictly required.
    '--postprocessor-args', 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
    // Diagnostic: log the resolved video + audio format ids before
    // download starts. Lets us verify in `[yt-dlp stderr]` that the
    // selector actually grabbed an audio stream — a video-only result
    // would show `acodec=none`.
    '--print', 'before_dl:JCUT_FMT vfmt=%(format_id)s vcodec=%(vcodec)s acodec=%(acodec)s ext=%(ext)s',
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    // Resilience for fragment-based downloads (DASH / HLS, which is
    // every YouTube DL with separate streams). yt-dlp's defaults are:
    //   * --retries 10        — entire-DL retries
    //   * --fragment-retries 10 — per-fragment retries
    //   * --skip-unavailable-fragments (DEFAULT) → skip a fragment that
    //     keeps failing and continue with the rest. ★ This is the load-
    //     bearing default that produced the 16-min-audio-vs-2.5-hour-
    //     video file the user reported. The merger then ran on the
    //     truncated audio and produced a silent-tail mp4.
    // Bumping retries higher and forcing abort-on-unavailable means a
    // partial fragment failure now surfaces as a hard error to the
    // renderer (alert dialog) instead of a silent truncation.
    '--retries', '30',
    '--fragment-retries', '30',
    '--abort-on-unavailable-fragment',
    '--print', 'after_move:filepath',
    '--print', 'title',
  ]);
  currentProcess = ytDlpProcess;

  let outputFilePath: string | null = null;
  let videoTitle: string | null = null;

  let lastEmittedAt = 0;
  const PROGRESS_THROTTLE_MS = 250;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Diagnostic line emitted by `--print before_dl:JCUT_FMT ...`. Echo
    // to console (caught in the [url-download] log) so we can verify
    // post-mortem that yt-dlp picked an audio stream — `acodec=none`
    // here means the format selector grabbed video-only, which is the
    // most common cause of silent playback.
    if (trimmed.startsWith('JCUT_FMT')) {
      console.log('[url-download] yt-dlp resolved formats:', trimmed);
      return;
    }

    if (trimmed.startsWith(PROGRESS_TAG)) {
      const parts = trimmed.slice(PROGRESS_TAG.length).trim().split(/\s+/);
      const [percentRaw, speedRaw, etaRaw] = parts;
      const percent = percentRaw ? parseFloat(percentRaw.replace(/%$/, '')) : NaN;
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

    // Capture filepath and title from bare lines (from --print)
    if (!trimmed.startsWith('[') && !trimmed.startsWith(PROGRESS_TAG)) {
      // yt-dlp prints title then filepath based on our --print order.
      // But we check for existence to avoid catching random logs.
      if (!videoTitle) {
        videoTitle = trimmed;
      } else {
        outputFilePath = trimmed;
      }
      return;
    }

    const mergerMatch = trimmed.match(/\[Merger\]\s+Merging formats into "(.+)"/);
    if (mergerMatch && mergerMatch[1]) {
      outputFilePath = mergerMatch[1];
    }
  };

  ytDlpProcess.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) handleLine(line);
  });

  ytDlpProcess.stderr.on('data', (data: Buffer) => {
    console.warn('[yt-dlp stderr]', data.toString());
  });

  return new Promise((resolve, reject) => {
    ytDlpProcess.on('exit', async (code: number | null) => {
      currentProcess = null;
      console.log('[url-download] yt-dlp exit code:', code, 'path:', outputFilePath);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      if (!outputFilePath) {
        reject(new Error('Download finished but output file path was not captured.'));
        return;
      }

      // Post-DL validation: ffprobe the output and confirm video / audio
      // durations line up. The user's earlier "音声出ない" report was
      // actually this exact failure mode — yt-dlp finished with exit 0
      // but produced a file with 16-min audio and 2h-38m video, because
      // a fragment had silently been skipped. With the new
      // --abort-on-unavailable-fragment arg this should be unreachable,
      // but we keep the check as a belt-and-braces second line.
      try {
        const probe = await probeDurations(outputFilePath);
        console.log(
          '[url-download] post-DL probe:',
          `video=${probe.videoDuration?.toFixed(1) ?? 'none'}s`,
          `audio=${probe.audioDuration?.toFixed(1) ?? 'none'}s`,
          `acodec=${probe.audioCodec ?? 'none'}`,
        );
        if (!probe.hasAudio) {
          reject(new Error(
            'ダウンロード完了しましたが、音声トラックがありません。' +
            '同じURLでもう一度試してください。',
          ));
          return;
        }
        if (
          probe.videoDuration != null &&
          probe.audioDuration != null &&
          Math.abs(probe.videoDuration - probe.audioDuration) > PROBE_DURATION_TOLERANCE_SEC
        ) {
          const vMin = (probe.videoDuration / 60).toFixed(1);
          const aMin = (probe.audioDuration / 60).toFixed(1);
          reject(new Error(
            `ダウンロード完了しましたが、音声が途中で切れています(動画 ${vMin} 分 / 音声 ${aMin} 分)。` +
            'ネットワーク不具合で一部フラグメントを取得できなかった可能性があります。' +
            '同じURLでもう一度試してください。',
          ));
          return;
        }
      } catch (err) {
        console.warn('[url-download] post-DL validation error (continuing):', err);
        // ffprobe failure shouldn't block a successful DL — log and
        // proceed so the user isn't stuck on probe issues.
      }

      resolve({ filePath: outputFilePath, title: videoTitle || path.basename(outputFilePath) });
    });

    ytDlpProcess.on('error', (err: Error) => {
      currentProcess = null;
      console.error('[url-download] yt-dlp process error:', err);
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

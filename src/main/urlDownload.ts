import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, ChildProcess } from 'child_process';
import type { UrlDownloadProgress } from '../common/types';
import type { YtdlpCookiesBrowser } from '../common/config';

export type CookiesPlatform = 'youtube' | 'twitch' | 'unknown';

// yt-dlp cookies builder with priority:
//   1. Platform-specific `--cookies <file>` (ytdlpCookiesFileYoutube /
//      ytdlpCookiesFileTwitch) if both the platform is known AND the
//      matching field is set. This is the most-explicit signal: "use
//      THIS file for THIS platform".
//   2. Generic `--cookies <file>` (ytdlpCookiesFile) — applies when
//      the user just wants one cookie file across both platforms.
//   3. `--cookies-from-browser <browser>` if a browser is selected.
//   4. `[]` (anonymous) — pre-cookies behaviour.
// We never combine: yt-dlp would accept multiple cookie sources but
// the SettingsDialog promises a strict precedence to the user.
export function getCookiesArgs(opts: {
  cookiesBrowser: YtdlpCookiesBrowser;
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
  cookiesFileTwitch: string | null;
  platform: CookiesPlatform;
}): string[] {
  const youtube = opts.cookiesFileYoutube?.trim();
  const twitch = opts.cookiesFileTwitch?.trim();
  const generic = opts.cookiesFile?.trim();

  if (opts.platform === 'youtube' && youtube) return ['--cookies', youtube];
  if (opts.platform === 'twitch' && twitch) return ['--cookies', twitch];
  if (generic) return ['--cookies', generic];
  if (opts.cookiesBrowser !== 'none') return ['--cookies-from-browser', opts.cookiesBrowser];
  return [];
}

// URL → platform classifier. Mirrors the regex set in
// chatReplay.extractVideoId so a session that passes one detector
// passes both. `'unknown'` is the "neither matched, use generic
// cookies" fallback — local file drops, magnet links, and bespoke
// download sites all land here.
export function classifyUrlPlatform(url: string): CookiesPlatform {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/twitch\.tv/i.test(url)) return 'twitch';
  return 'unknown';
}

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

// Cached yt-dlp --version. Resolved lazily on first use so we don't
// pay the spawn cost during app boot, but every subsequent DL reuses
// the same string. `null` means "not yet probed", `'unknown'` means
// the probe failed and we shouldn't keep retrying.
let cachedYtDlpVersion: string | null = null;

async function getYtDlpVersion(): Promise<string> {
  if (cachedYtDlpVersion != null) return cachedYtDlpVersion;
  return new Promise((resolve) => {
    try {
      const proc = spawn(getYtDlpPath(), ['--version'], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (b) => { out += b.toString(); });
      proc.on('exit', () => {
        const v = out.trim().split(/\r?\n/)[0]?.trim() || 'unknown';
        cachedYtDlpVersion = v;
        resolve(v);
      });
      proc.on('error', () => {
        cachedYtDlpVersion = 'unknown';
        resolve('unknown');
      });
    } catch {
      cachedYtDlpVersion = 'unknown';
      resolve('unknown');
    }
  });
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

// Format selector. As of 2026-05-03 (段階 6d) we deliberately DO NOT
// constrain the codec or container any more, because:
//   1. With `--js-runtimes node` enabled, yt-dlp can resolve YouTube's
//      full format list including separate VP9 / AV1 video streams.
//      The previous avc1+m4a-preferred selector regressed to "Requested
//      format is not available" on videos where YouTube hadn't published
//      the AVC1 variant yet at extraction time.
//   2. Chromium plays MP4+VP9 natively (since Chrome ~70), so the
//      AVC1-only invariant the old comment block claimed isn't load-
//      bearing. The Merger runs `-c:v copy` either way; we let it copy
//      whatever video codec was picked into the MP4 container.
//   3. The audio postprocessor (`-c:a aac -b:a 192k`) transcodes Opus
//      to AAC inline, so a webm/opus audio pick still ends up as a
//      Chromium-playable MP4 file.
// Selector chain:
//   1. bestvideo<h> + bestaudio   — separate streams, merger runs
//   2. best<h>                     — single muxed file fallback (no merge needed)
//   3. best                        — final unconstrained fallback
const buildFormatSelector = (quality: string): string => {
  const h = heightFilter(quality);
  if (quality === 'worst') {
    return `worstvideo${h}+worstaudio/worst${h}/worst`;
  }
  return `bestvideo${h}+bestaudio/best${h}/best`;
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
  cookiesBrowser: YtdlpCookiesBrowser;
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
  cookiesFileTwitch: string | null;
  onProgress: (progress: UrlDownloadProgress) => void;
}): Promise<{ filePath: string; title: string }> {
  const format = buildFormatSelector(args.quality);

  // Ensure outputDir exists
  await fs.mkdir(args.outputDir, { recursive: true });

  // Use %(title)s.%(ext)s but restrict filenames to be safe.
  const template = '%(title)s.%(ext)s';
  const outputTemplate = `${args.outputDir}${path.sep}${template}`;

  console.log('[url-download] format selector:', format);
  const startedAt = Date.now();
  // Bench logging — version + concurrency in the start line so a
  // post-mortem comparing two DL runs can confirm the binary version
  // and the args at the time. getYtDlpVersion caches after the first
  // call so subsequent DLs don't pay the spawn cost.
  const ytDlpVersion = await getYtDlpVersion();
  const platform = classifyUrlPlatform(args.url);
  console.log(
    `[url-download] yt-dlp start: url=${args.url}, quality=${args.quality}, ` +
      `version=${ytDlpVersion}, concurrent=8, platform=${platform}, ` +
      `cookiesBrowser=${args.cookiesBrowser}, cookiesFile=${args.cookiesFile ?? '<none>'}, ` +
      `cookiesFileYT=${args.cookiesFileYoutube ?? '<none>'}, cookiesFileTW=${args.cookiesFileTwitch ?? '<none>'}`,
  );

  const ytDlpProcess: any = spawn(getYtDlpPath(), [
    args.url,
    ...getCookiesArgs({
      cookiesBrowser: args.cookiesBrowser,
      cookiesFile: args.cookiesFile,
      cookiesFileYoutube: args.cookiesFileYoutube,
      cookiesFileTwitch: args.cookiesFileTwitch,
      platform,
    }),
    // Force a JavaScript runtime for YouTube's nsig / SABR challenges.
    // Without this, yt-dlp falls back to "deprecated, formats may be
    // missing" mode and the renderer's format selector can fail with
    // "Requested format is not available". `node` is always present
    // because this app ships with Electron, and yt-dlp resolves it via
    // PATH (electron-vite dev server's parent shell, packaged build's
    // system PATH).
    '--js-runtimes', 'node',
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    // Parallel fragment download. yt-dlp's default is single-fragment
    // sequential, which leaves bandwidth on the table for HLS/DASH
    // streams (every YouTube DL with separate video+audio is a fragment
    // pull). 8 is a pragmatic balance — past ~12 the gains taper while
    // server-side throttling risk grows. The custom progress template
    // (PROGRESS_TEMPLATE) emits per-fragment lines that interleave at
    // this point; the renderer's last-line wins display may oscillate
    // briefly, but absolute monotonic % is not promised by yt-dlp here
    // anyway. Revisit if user reports confusing UX.
    '--concurrent-fragments', '8',
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
    '--write-info-json',
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

      // Bench summary so the user can compare runs (e.g. before vs.
      // after the 2026-05-03 --concurrent-fragments change). Both
      // size + speed are best-effort: a stat failure here doesn't
      // affect the resolved file, just trims the log line.
      const elapsedSec = (Date.now() - startedAt) / 1000;
      try {
        const fileStat = await fs.stat(outputFilePath);
        const sizeMB = fileStat.size / 1024 / 1024;
        const avgMBs = elapsedSec > 0 ? sizeMB / elapsedSec : 0;
        console.log(
          `[url-download] yt-dlp done: ${elapsedSec.toFixed(1)}s, ` +
            `size=${sizeMB.toFixed(1)}MB, avg=${avgMBs.toFixed(2)}MB/s`,
        );
      } catch {
        console.log(`[url-download] yt-dlp done: ${elapsedSec.toFixed(1)}s (size unknown)`);
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

// ===========================================================================
// Stage 2 — audio-first / video-background split
// ===========================================================================

// Stable session identifier shared by the audio + video downloads of the
// same URL. AI-extract caches key off this so the audio-only run and the
// follow-up video run hit the same entry. YouTube/Twitch IDs are tried
// first (cleaner cache keys, recognisable in disk listings); we fall
// back to a sha256 prefix of the URL for unknown providers.
export function deriveSessionId(url: string): string {
  const ytWatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (ytWatch) return `youtube_${ytWatch[1]}`;
  const ytShort = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (ytShort) return `youtube_${ytShort[1]}`;
  const twitch = url.match(/twitch\.tv\/.*\/?videos?\/(\d+)/) ?? url.match(/\/videos\/(\d+)/);
  if (twitch) return `twitch_${twitch[1]}`;
  return `url_${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
}

let currentAudioProcess: ChildProcess | null = null;
let currentVideoProcess: ChildProcess | null = null;

// Stage 5 — translate yt-dlp's verbose stderr into actionable Japanese
// error messages. Detects the common 404/410/unavailable patterns and,
// when running against a Twitch sessionId, points at the 14-day VOD
// retention quirk specifically.
//
// 2026-05-03 update: split the original "Sign in to confirm" lump into
// three buckets so the user gets specific advice:
//   (A) bot detection — anonymous yt-dlp rejected by YouTube heuristics
//   (B) auth-required content — age-restricted / members-only / private
//   (C) cookie DB lock — yt-dlp couldn't read the browser's cookie file
//       (browser is open with an exclusive handle, or perms blocked)
// Each points at the SettingsDialog "ブラウザクッキー使用" toggle when
// applicable, so the user can self-recover without grepping logs.
function friendlyDownloadError(
  stderr: string,
  sessionId: string,
  fallback: string,
): string {
  const isTwitch = sessionId.startsWith('twitch_');
  if (
    /HTTP Error 404|HTTP Error 410|Video does not exist|This video is unavailable|Sorry, the streamer/i.test(
      stderr,
    )
  ) {
    return isTwitch
      ? 'Twitch VOD が見つかりません(配信から 14 日以上経過、または非公開の可能性があります)'
      : '動画が見つかりません(404)。URL を確認してください';
  }
  // (D) Cookies-file-not-found — distinct from cookie-DB lock because
  // the failure mode is path-level (typo / moved file / permission)
  // rather than process contention. The advice is also different
  // (re-pick the file vs. close the browser). Match before the
  // browser-DB branch so a missing file doesn't get misdiagnosed when
  // the user has both fields set.
  if (/cookies file (?:does not exist|not found|cannot be opened)|No such file or directory.*cookies/i.test(stderr)) {
    return 'クッキーファイルが見つかりません。設定で正しいパスを指定するか、ブラウザクッキー使用に切替してください。';
  }
  // (C) Cookie-DB lock — match BEFORE the bot-detection branch, since a
  // locked cookie DB while cookies-from-browser is enabled can ALSO
  // produce a follow-on bot-detection error. The cookie-lock advice is
  // the actionable one in that combination.
  if (/cookies database is locked|could not copy cookies|Permission denied.*cookies/i.test(stderr)) {
    return 'ブラウザのクッキーにアクセスできませんでした。ブラウザを完全に閉じてから再試行するか、設定で別のブラウザを選択してください(クッキーファイル指定もご検討ください)。';
  }
  // (A) bot detection — distinct from age/members because the user-
  // visible message includes the literal "you're not a bot" string. We
  // match that specifically so wording changes to other "Sign in to
  // confirm ..." prompts don't sweep the wrong error into this bucket.
  if (/Sign in to confirm you'?re not a bot/i.test(stderr)) {
    return 'YouTube の bot 検出によりダウンロードできません。設定で「ブラウザクッキー使用」を有効にしてください(推奨: Edge または Chrome)。';
  }
  // (B) auth-required content
  if (/Sign in to confirm your age|members?-only|This video is private|age-restricted/i.test(stderr)) {
    return 'ログイン認証が必要な動画です(年齢制限 / メンバー限定 / 非公開)。設定で「ブラウザクッキー使用」を有効にしてください。';
  }
  // (E) Format-not-available — the format selector resolved against an
  // empty set of YouTube formats. Almost always one of: video deleted /
  // privated / region-locked, OR yt-dlp's bundled extractor doesn't
  // recognise YouTube's current format manifest (binary needs updating).
  // Match LATE — "Sign in to confirm" branches above are more specific
  // than this catch-all.
  if (/Requested format is not available|No suitable formats|format not available/i.test(stderr)) {
    return '利用可能な動画フォーマットが見つかりません。動画が削除・地域制限されているか、yt-dlp のバージョンが古い可能性があります。';
  }
  return fallback;
}

// Probe ffprobe for duration. Reused by audio-only DL since the audio
// stream's duration is what AI extract uses for its `videoDurationSec`
// field — sample-accurate and ~always within 1s of the true video
// length for standard YouTube/Twitch encodes.
async function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { windowsHide: true },
    );
    let out = '';
    proc.stdout.on('data', (b) => { out += b.toString(); });
    proc.on('exit', () => {
      try {
        const json = JSON.parse(out) as { format?: { duration?: string } };
        const d = json.format?.duration ? parseFloat(json.format.duration) : 0;
        resolve(Number.isFinite(d) ? d : 0);
      } catch {
        resolve(0);
      }
    });
    proc.on('error', () => resolve(0));
  });
}

export async function downloadAudioOnly(args: {
  url: string;
  outputDir: string;
  cookiesBrowser: YtdlpCookiesBrowser;
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
  cookiesFileTwitch: string | null;
  onProgress: (progress: UrlDownloadProgress) => void;
}): Promise<{ audioFilePath: string; sessionId: string; durationSec: number; videoTitle: string }> {
  await fs.mkdir(args.outputDir, { recursive: true });
  const sessionId = deriveSessionId(args.url);
  // Stable filename anchored to sessionId (not title) so re-runs with
  // the same URL hit the same disk slot — predictable for cleanup and
  // cache reuse. Extension is added by yt-dlp based on the chosen
  // format (m4a usually, sometimes webm/opus).
  const outputTemplate = path.join(args.outputDir, `${sessionId}-audio.%(ext)s`);

  const startedAt = Date.now();
  const ytDlpVersion = await getYtDlpVersion();
  const platform = classifyUrlPlatform(args.url);
  console.log(
    `[url-download] audio-only start: url=${args.url}, sessionId=${sessionId}, ` +
      `version=${ytDlpVersion}, concurrent=8, platform=${platform}, ` +
      `cookiesBrowser=${args.cookiesBrowser}, cookiesFile=${args.cookiesFile ?? '<none>'}, ` +
      `cookiesFileYT=${args.cookiesFileYoutube ?? '<none>'}, cookiesFileTW=${args.cookiesFileTwitch ?? '<none>'}`,
  );

  const proc = spawn(getYtDlpPath(), [
    args.url,
    ...getCookiesArgs({
      cookiesBrowser: args.cookiesBrowser,
      cookiesFile: args.cookiesFile,
      cookiesFileYoutube: args.cookiesFileYoutube,
      cookiesFileTwitch: args.cookiesFileTwitch,
      platform,
    }),
    // See downloadVideo for the rationale on --js-runtimes node.
    '--js-runtimes', 'node',
    // Prefer m4a for direct decode (codec id 140 typically), fall back
    // to webm/opus (251), then to whatever bestaudio resolves to. The
    // explicit webm step matters when YouTube's m4a variant isn't
    // published for a given video (live archives, restricted age tiers
    // delivered as DASH-only) — without it yt-dlp would skip straight
    // to the unconstrained final fallback and might pick a worse
    // bitrate.
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '-o', outputTemplate,
    '--concurrent-fragments', '8',
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--no-playlist',
    '--no-warnings',
    '--write-info-json',
    '--retries', '30',
    '--fragment-retries', '30',
    '--abort-on-unavailable-fragment',
    '--print', 'after_move:filepath',
    '--print', 'title',
  ]);
  currentAudioProcess = proc;

  let outputFilePath: string | null = null;
  let videoTitle: string | null = null;
  let lastEmittedAt = 0;
  const PROGRESS_THROTTLE_MS = 250;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
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
    if (!trimmed.startsWith('[')) {
      // bare line from --print: title first, filepath second.
      if (!videoTitle) videoTitle = trimmed;
      else outputFilePath = trimmed;
    }
  };

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) handleLine(line);
  });
  // Stage 5 — buffer stderr for friendlyDownloadError parsing while
  // also echoing to console for live diagnostics. 16 KB rolling cap so
  // a chatty yt-dlp run doesn't balloon RAM.
  let stderrBuf = '';
  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stderrBuf += chunk;
    if (stderrBuf.length > 16 * 1024) stderrBuf = stderrBuf.slice(-16 * 1024);
    console.warn('[yt-dlp audio stderr]', chunk);
  });

  return new Promise((resolve, reject) => {
    proc.on('exit', async (code: number | null) => {
      if (currentAudioProcess === proc) currentAudioProcess = null;
      if (code !== 0) {
        reject(
          new Error(
            friendlyDownloadError(
              stderrBuf,
              sessionId,
              `yt-dlp (audio) exited with code ${code}`,
            ),
          ),
        );
        return;
      }
      if (!outputFilePath) {
        reject(new Error('Audio download finished but output file path was not captured.'));
        return;
      }
      const durationSec = await probeDurationSec(outputFilePath);
      const elapsedSec = (Date.now() - startedAt) / 1000;
      try {
        const st = await fs.stat(outputFilePath);
        const sizeMB = st.size / 1024 / 1024;
        console.log(
          `[url-download] audio-only done: ${elapsedSec.toFixed(1)}s, ` +
            `size=${sizeMB.toFixed(1)}MB, avg=${(sizeMB / Math.max(0.1, elapsedSec)).toFixed(2)}MB/s, ` +
            `duration=${durationSec.toFixed(1)}s`,
        );
      } catch {
        console.log(`[url-download] audio-only done: ${elapsedSec.toFixed(1)}s (size unknown)`);
      }
      resolve({
        audioFilePath: outputFilePath,
        sessionId,
        durationSec,
        videoTitle: videoTitle || path.basename(outputFilePath),
      });
    });
    proc.on('error', (err: Error) => {
      if (currentAudioProcess === proc) currentAudioProcess = null;
      reject(err);
    });
  });
}

export async function cancelAudioDownload(): Promise<void> {
  if (currentAudioProcess) {
    currentAudioProcess.kill();
    currentAudioProcess = null;
  }
}

export async function downloadVideoOnly(args: {
  url: string;
  quality: string;
  outputDir: string;
  sessionId: string;
  cookiesBrowser: YtdlpCookiesBrowser;
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
  cookiesFileTwitch: string | null;
  onProgress: (progress: UrlDownloadProgress) => void;
}): Promise<{ videoFilePath: string; sessionId: string }> {
  await fs.mkdir(args.outputDir, { recursive: true });
  // Same format selector as the legacy `start()` path — produces an
  // mp4 with avc1 video + AAC audio so Chromium can play it natively.
  // The audio track here is bundled because we don't know whether the
  // user will accept the audio-only file as the eventual playback
  // source (currently no — playback always uses the video file).
  const format = buildFormatSelector(args.quality);
  const outputTemplate = path.join(args.outputDir, '%(title)s.%(ext)s');

  const startedAt = Date.now();
  const ytDlpVersion = await getYtDlpVersion();
  const platform = classifyUrlPlatform(args.url);
  console.log(
    `[url-download] video-only start: url=${args.url}, sessionId=${args.sessionId}, ` +
      `quality=${args.quality}, version=${ytDlpVersion}, concurrent=8, platform=${platform}, ` +
      `cookiesBrowser=${args.cookiesBrowser}, cookiesFile=${args.cookiesFile ?? '<none>'}, ` +
      `cookiesFileYT=${args.cookiesFileYoutube ?? '<none>'}, cookiesFileTW=${args.cookiesFileTwitch ?? '<none>'}`,
  );

  const proc = spawn(getYtDlpPath(), [
    args.url,
    ...getCookiesArgs({
      cookiesBrowser: args.cookiesBrowser,
      cookiesFile: args.cookiesFile,
      cookiesFileYoutube: args.cookiesFileYoutube,
      cookiesFileTwitch: args.cookiesFileTwitch,
      platform,
    }),
    // See downloadVideo for the rationale on --js-runtimes node.
    '--js-runtimes', 'node',
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
    '--concurrent-fragments', '8',
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--no-playlist',
    '--no-warnings',
    '--write-info-json',
    '--restrict-filenames',
    '--retries', '30',
    '--fragment-retries', '30',
    '--abort-on-unavailable-fragment',
    '--print', 'after_move:filepath',
  ]);
  currentVideoProcess = proc;

  let outputFilePath: string | null = null;
  let lastEmittedAt = 0;
  const PROGRESS_THROTTLE_MS = 250;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
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
    if (!trimmed.startsWith('[')) {
      outputFilePath = trimmed;
    }
    const mergerMatch = trimmed.match(/\[Merger\]\s+Merging formats into "(.+)"/);
    if (mergerMatch && mergerMatch[1]) outputFilePath = mergerMatch[1];
  };

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) handleLine(line);
  });
  let stderrBuf = '';
  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stderrBuf += chunk;
    if (stderrBuf.length > 16 * 1024) stderrBuf = stderrBuf.slice(-16 * 1024);
    console.warn('[yt-dlp video stderr]', chunk);
  });

  return new Promise((resolve, reject) => {
    proc.on('exit', (code: number | null) => {
      if (currentVideoProcess === proc) currentVideoProcess = null;
      if (code !== 0) {
        reject(
          new Error(
            friendlyDownloadError(
              stderrBuf,
              args.sessionId,
              `yt-dlp (video) exited with code ${code}`,
            ),
          ),
        );
        return;
      }
      if (!outputFilePath) {
        reject(new Error('Video download finished but output file path was not captured.'));
        return;
      }
      const elapsedSec = (Date.now() - startedAt) / 1000;
      console.log(
        `[url-download] video-only done: ${elapsedSec.toFixed(1)}s, sessionId=${args.sessionId}`,
      );
      resolve({ videoFilePath: outputFilePath, sessionId: args.sessionId });
    });
    proc.on('error', (err: Error) => {
      if (currentVideoProcess === proc) currentVideoProcess = null;
      reject(err);
    });
  });
}

export async function cancelVideoDownload(): Promise<void> {
  if (currentVideoProcess) {
    currentVideoProcess.kill();
    currentVideoProcess = null;
  }
}

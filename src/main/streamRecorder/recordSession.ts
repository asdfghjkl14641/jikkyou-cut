// One per active recording. Owns:
//   - the live-capture subprocess (yt-dlp or streamlink)
//   - graceful shutdown on stopRecording()
//   - status updates persisted via writeMetadata()
//   - 2026-05-04: auto-restart of yt-dlp on early exit while the
//     upstream stream is still live (file-rotation per segment)
//
// The session does NOT manage VOD re-capture — that's a separate
// follow-up phase orchestrated by the StreamRecorder after the live
// process has exited cleanly.

import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LiveStreamInfo } from '../../common/types';
import type { RecordingMetadata } from '../../common/types';
import { writeMetadata } from './storage';

// 2026-05-04 — Process-tree kill. yt-dlp's HLS path delegates fragment
// fetching to a child ffmpeg; SIGTERM-ing yt-dlp leaves ffmpeg as an
// orphan that keeps writing to the .live.mp4 file (we observed 12
// such zombies after a kill). `taskkill /F /T /PID` walks the whole
// process tree on Windows. macOS / Linux fall back to process.kill
// which is fine because there's no analogous orphan-ffmpeg pattern
// (those platforms get reaped by the parent's exit signal correctly).
function killProcessTreeWindows(pid: number): void {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (err) {
    console.warn('[stream-recorder] taskkill spawn failed:', err);
  }
}

// Resolve yt-dlp.exe path. Mirrors urlDownload.getYtDlpPath() —
// duplicated here because we don't want streamRecorder to import
// urlDownload (urlDownload is a heavy module with its own subprocess
// state and we'd rather keep the dependency tree clean).
function getYtDlpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');
}

// Optional Streamlink. Returns null if the user hasn't dropped the
// .exe into resources/streamlink/. Streamlink tends to be more
// resilient against ad-rolls and reconnect glitches on Twitch, so we
// prefer it when present. The user is expected to download
// streamlink.exe manually from streamlink/windows-builds.
function getStreamlinkPath(): string | null {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath || '', 'streamlink')
    : path.join(app.getAppPath(), 'resources', 'streamlink');
  const exe = path.join(dir, 'streamlink.exe');
  return existsSync(exe) ? exe : null;
}

export type RecorderKind = 'streamlink' | 'yt-dlp';

export type SessionDeps = {
  // Persists meta to disk + emits IPC progress event.
  onMetadataChange: (meta: RecordingMetadata) => void;
  // 2026-05-04 — Auto-restart probe. Returns true if the upstream
  // stream is STILL live (= we should respawn yt-dlp on early exit).
  // Returns false when the stream genuinely ended. The orchestrator
  // injects this because it owns the platform-specific credentials
  // (Twitch helix/streams ping, YouTube videos.list lookup).
  probeIsStillLive: () => Promise<boolean>;
};

// Auto-restart cap. yt-dlp dying repeatedly on the same stream is
// almost always a permanent failure (auth lapse, geo-block, etc.) —
// past 5 retries we'd just be wasting cycles. 5 covers the typical
// transient-network-hiccup pattern (1-2 restarts) with headroom.
const MAX_RESTARTS = 5;

// Cooldown between yt-dlp respawns. Just long enough that a transient
// HLS playlist 5xx has cleared but short enough that the user notices
// minimal gap in their archive.
const RESTART_COOLDOWN_MS = 5_000;

export class RecordingSession {
  readonly meta: RecordingMetadata;
  private deps: SessionDeps;
  private proc: ChildProcess | null = null;
  private kind: RecorderKind;
  // Saved at construction time so respawn() can rebuild yt-dlp args
  // without round-tripping through the orchestrator.
  private info: LiveStreamInfo;
  private quality: 'best' | '1080p' | '720p';
  private liveFilePath: string;
  // Resolves once the underlying process actually exits. We never
  // reject — the metadata's `status` field is the canonical signal
  // for success vs failure, so callers can `await stop()` without
  // worrying about catching.
  private exitPromise: Promise<void>;
  private exitResolve: () => void = () => {};
  // Set to true when stop() was called intentionally. Distinguishes
  // graceful shutdown from a crash on the recording side.
  private stopRequested = false;
  // 2026-05-04 — auto-restart bookkeeping. `restartCount` increments
  // on each respawn (recovery from yt-dlp early exit while stream is
  // still live). The session is finalised when restartCount hits the
  // MAX_RESTARTS cap or probeIsStillLive returns false.
  private restartCount = 0;
  private restarting = false;
  // Tracks when the current segment's spawn started, for diagnostic
  // logs ("yt-dlp ran for 3h12m before exiting").
  private currentSegmentStartedAt: number = Date.now();

  // Cookies args pre-built by the orchestrator via urlDownload.
  // getCookiesArgs (so the priority order — platform-specific file >
  // generic file > browser-cookies > none — matches the rest of the
  // app's yt-dlp invocations). Empty array when no cookies apply.
  private cookiesArgs: string[];

  constructor(opts: {
    info: LiveStreamInfo;
    meta: RecordingMetadata;
    quality: 'best' | '1080p' | '720p';
    cookiesArgs: string[];
    deps: SessionDeps;
  }) {
    this.meta = opts.meta;
    this.deps = opts.deps;
    this.info = opts.info;
    this.quality = opts.quality;
    this.cookiesArgs = opts.cookiesArgs;
    this.kind = getStreamlinkPath() ? 'streamlink' : 'yt-dlp';
    // Live filename suffix differs by kind: streamlink writes mkv
    // verbatim from the HLS stream (no remux), yt-dlp writes whatever
    // it picked (most often mp4 for Twitch live, m3u8-pieces-merged
    // for YouTube). 2026-05-04: dropped the `.live` infix from the
    // filename — Windows Media Player (and quite a few other apps)
    // misread the `.live.mp4` ending as if `.live` were the real
    // extension and refuses to play with error 0x80070323. The
    // metadata JSON's files.live vs files.vod distinction is what
    // distinguishes live capture from VOD re-fetch now.
    this.liveFilePath = this.buildLiveFilePath(this.restartCount);
    // Final filename for metadata. yt-dlp's actual output extension
    // is filled in via the `after_move:filepath` print, so we update
    // meta.files.live there. For streamlink we know the path now.
    if (this.kind === 'streamlink') {
      this.meta.files.live = path.basename(this.liveFilePath);
    }

    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    this.proc = this.spawn();
    this.wireProcessEvents();
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  // Filename pattern: original = "<recordingId>.<ext>", restarts =
  // "<recordingId>.NNN.<ext>" with NNN zero-padded. yt-dlp's %(ext)s
  // placeholder resolves at run time to the source's actual
  // extension. 2026-05-04: dropped the `.live` infix — see comment
  // in the constructor for the Windows-media-player rationale.
  private buildLiveFilePath(segmentIndex: number): string {
    const recordingId = this.meta.recordingId;
    const segSuffix = segmentIndex === 0 ? '' : `.${segmentIndex.toString().padStart(3, '0')}`;
    if (this.kind === 'streamlink') {
      return path.join(this.meta.folder, `${recordingId}${segSuffix}.mkv`);
    }
    return path.join(this.meta.folder, `${recordingId}${segSuffix}.%(ext)s`);
  }

  private spawn(): ChildProcess {
    if (this.kind === 'streamlink') return this.spawnStreamlink();
    return this.spawnYtDlp();
  }

  private spawnStreamlink(): ChildProcess {
    const exe = getStreamlinkPath()!;
    const stream = this.quality === 'best' ? 'best' : this.quality;
    const args: string[] = [
      '--output',
      this.liveFilePath,
    ];
    if (this.info.platform === 'twitch') {
      args.push('--twitch-disable-ads');
    }
    args.push(this.info.url, stream);
    console.log('[stream-recorder] streamlink spawn:', exe, args.join(' '));
    return spawn(exe, args, { windowsHide: true });
  }

  private spawnYtDlp(): ChildProcess {
    const exe = getYtDlpPath();
    // 2026-05-04 — Format selector tuned for editor compatibility.
    // The HTML5 <video> element in the renderer plays H.264/AAC/MP4
    // and VP9/Opus/WebM natively; H.265 / AV1 will silently fail.
    //   Twitch  — HLS source is universally H.264/AAC, so prefer
    //             avc1+m4a explicitly. The fallback is `best` so
    //             a future Twitch format roll-out doesn't break us.
    //   YouTube — Live often runs VP9 at 1080p60+; forcing H.264
    //             would drop us to 720p / 30 fps. Keep the relaxed
    //             selector and rely on the post-record remux step
    //             (streamRecorder/remux.ts) to repackage to MP4 if
    //             yt-dlp lands on a non-MP4 container.
    const heightFilter = this.quality === 'best' ? '' : `[height<=${this.quality.replace('p', '')}]`;
    const format = this.info.platform === 'twitch'
      ? `bestvideo${heightFilter}[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo${heightFilter}[ext=mp4]+bestaudio[ext=m4a]/best${heightFilter}/best`
      : `bestvideo${heightFilter}+bestaudio/best${heightFilter}/best`;
    // 2026-05-04 emergency fix — `--live-from-start` is documented as
    // **YouTube only**. Passing it to a Twitch URL causes yt-dlp to
    // spin forever waiting for past-fragment data that Twitch's HLS
    // never publishes — observed in 5/3 22:08 (柊ツルギ) + 5/4 09:08
    // (加藤純一) recordings, both 0 bytes after multi-hour runs.
    // Conditional on platform now: YouTube gets the rewind-to-start
    // semantic, Twitch records from current head.
    const liveFromStartArgs = this.info.platform === 'youtube' ? ['--live-from-start'] : [];
    const args: string[] = [
      this.info.url,
      '--js-runtimes', 'node',
      '-f', format,
      '-o', this.liveFilePath,
      // 2026-05-04 — Force the merged container to MP4. yt-dlp's
      // default would pick whichever container the source uses
      // (.mkv for VP9, .ts for some HLS); the renderer's
      // <video> element only natively plays MP4 / WebM. The post-
      // record remux step is the safety net when the source is
      // VP9 / AV1 (`-c copy` to MP4 fails for those — we'd need
      // a re-encode, which we don't do live).
      '--merge-output-format', 'mp4',
      ...liveFromStartArgs,
      '--no-part',
      '--concurrent-fragments', '4',
      '--retries', 'infinite',
      '--fragment-retries', 'infinite',
      // Print after-move so we capture the actual filename yt-dlp
      // settles on (extension can vary by source).
      '--print', 'after_move:filepath',
      '--no-warnings',
      '--no-playlist',
      // 2026-05-04 — pre-built cookies args from the orchestrator
      // (urlDownload.getCookiesArgs). Spreads `--cookies <path>` or
      // `--cookies-from-browser <browser>` based on AppConfig priority,
      // empty array when none configured.
      ...this.cookiesArgs,
    ];
    // Diagnostic log so future regressions are immediately visible
    // in the terminal — `--live-from-start` shows up here only for
    // YouTube; cookies path appears as e.g. `--cookies <abs-path>`.
    const cookiesSummary = this.cookiesArgs.length > 0
      ? this.cookiesArgs.slice(0, 2).join(' ')
      : '<none>';
    console.log(
      `[stream-recorder] platform=${this.info.platform}, ` +
        `liveFromStart=${liveFromStartArgs.length > 0}, cookies=${cookiesSummary}, ` +
        `segment=${this.restartCount}`,
    );
    console.log('[stream-recorder] yt-dlp live spawn:', exe, args.join(' '));
    return spawn(exe, args, { windowsHide: true });
  }

  private wireProcessEvents(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.currentSegmentStartedAt = Date.now();

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      // yt-dlp `after_move:filepath` arrives as a bare line. We can
      // safely look for absolute-path-shaped lines because every other
      // yt-dlp stdout line begins with `[`.
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('[')) continue;
        if (line.includes(path.sep) || line.startsWith('/')) {
          const fname = path.basename(line);
          if (fname && fname !== this.meta.files.live) {
            this.meta.files.live = fname;
            // Keep liveSegments in sync with the actual filenames
            // yt-dlp resolved. Replace the last entry (current
            // segment) since this fname is the just-resolved final
            // name for it.
            if (this.meta.liveSegments && this.meta.liveSegments.length > 0) {
              this.meta.liveSegments[this.meta.liveSegments.length - 1] = fname;
            }
            this.deps.onMetadataChange(this.meta);
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      // Recording subprocesses are noisy. We dump truncated to
      // console only — full stderr would balloon log size during a
      // multi-hour stream.
      const text = data.toString().slice(0, 400);
      if (text.trim()) console.warn(`[stream-recorder] ${this.kind} stderr:`, text);
    });

    proc.on('exit', (code, signal) => {
      const elapsedMs = Date.now() - this.currentSegmentStartedAt;
      const elapsedH = (elapsedMs / 3_600_000).toFixed(2);
      console.log(
        `[stream-recorder] ${this.kind} exit: pid=${proc.pid}, code=${code}, signal=${signal}, ` +
          `stopRequested=${this.stopRequested}, elapsed=${elapsedH}h, segment=${this.restartCount}`,
      );
      // User-requested stop / app shutdown / process tree kill →
      // resolve immediately.
      if (this.stopRequested) {
        this.exitResolve();
        return;
      }
      // Otherwise: ask the orchestrator if the upstream stream is
      // still live. If yes AND we haven't hit the restart cap, rotate
      // the file + respawn. If no, finalise the session.
      void this.maybeRestartOrFinalise(code).catch((err) => {
        console.warn('[stream-recorder] maybeRestartOrFinalise threw:', err);
        this.finaliseAsFailed(`${this.kind} exited code=${code} (restart probe failed)`);
        this.exitResolve();
      });
    });

    proc.on('error', (err) => {
      console.warn(`[stream-recorder] ${this.kind} spawn error:`, err);
      this.finaliseAsFailed(err.message);
      this.exitResolve();
    });
  }

  private finaliseAsFailed(reason: string): void {
    this.meta.status = 'failed';
    this.meta.errorMessage =
      (this.meta.errorMessage ? this.meta.errorMessage + ' / ' : '') + reason;
    this.deps.onMetadataChange(this.meta);
  }

  // 2026-05-04 — Auto-restart decision tree. yt-dlp may exit while
  // the upstream stream is still live for many reasons (HLS playlist
  // 5xx, fragment timeout, network blip, Twitch ad-roll edge cases).
  // We probe live status, rotate the file, and respawn within seconds
  // — this is the difference between a 11h archive and a 30min one.
  private async maybeRestartOrFinalise(code: number | null): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      console.log(
        `[stream-recorder] checking if stream is still live (restartCount=${this.restartCount}/${MAX_RESTARTS})`,
      );
      const stillLive = await this.deps.probeIsStillLive();
      console.log(`[stream-recorder] probe result: stillLive=${stillLive}`);
      if (!stillLive) {
        // Stream genuinely ended — let the regular exit handling fire.
        // code === 0 is the happy path; anything else = the upstream
        // closed the connection mid-fragment which we treat as
        // success (we have what we got).
        if (code !== 0) {
          this.meta.errorMessage =
            (this.meta.errorMessage ? this.meta.errorMessage + ' / ' : '') +
            `${this.kind} exited code=${code} (stream offline, finalising)`;
          this.deps.onMetadataChange(this.meta);
        }
        this.exitResolve();
        return;
      }
      if (this.restartCount >= MAX_RESTARTS) {
        console.warn(
          `[stream-recorder] restart cap reached (${MAX_RESTARTS}), finalising as failed`,
        );
        this.finaliseAsFailed(
          `${this.kind} restarted ${MAX_RESTARTS} times — giving up`,
        );
        this.exitResolve();
        return;
      }
      // Cooldown so we don't hammer a transient-failure source.
      console.log(`[stream-recorder] cooldown ${RESTART_COOLDOWN_MS}ms before respawn`);
      await new Promise<void>((r) => setTimeout(r, RESTART_COOLDOWN_MS));
      if (this.stopRequested) {
        // User clicked stop during cooldown — abort respawn.
        this.exitResolve();
        return;
      }
      this.restartCount += 1;
      this.respawn();
    } finally {
      this.restarting = false;
    }
  }

  private respawn(): void {
    // Rotate the file: build a new path with the restart-count suffix,
    // append the old (= just-finished) filename to liveSegments, then
    // spawn fresh. The new spawn writes to the new path.
    if (!this.meta.liveSegments) {
      // First restart — backfill with the original segment so the
      // array has every file, not just the post-rotation ones.
      this.meta.liveSegments = this.meta.files.live ? [this.meta.files.live] : [];
    }
    this.liveFilePath = this.buildLiveFilePath(this.restartCount);
    // Pre-register the new segment in liveSegments. yt-dlp's
    // after_move:filepath will replace this with the actual resolved
    // filename once it picks an extension.
    const placeholder =
      this.kind === 'streamlink'
        ? path.basename(this.liveFilePath)
        : path.basename(this.liveFilePath).replace('.%(ext)s', '.mp4');
    this.meta.liveSegments.push(placeholder);
    this.meta.files.live = placeholder;
    this.meta.restartCount = this.restartCount;
    this.deps.onMetadataChange(this.meta);
    console.log(
      `[stream-recorder] respawning ${this.kind} (restart ${this.restartCount}/${MAX_RESTARTS}) → ${this.liveFilePath}`,
    );
    this.proc = this.spawn();
    this.wireProcessEvents();
  }

  // Graceful stop. yt-dlp / streamlink both flush their output buffer
  // on SIGTERM (Windows: kill via tree-kill semantics) so the user
  // gets the partial recording even if we cut early.
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.proc || this.proc.exitCode != null) return this.exitPromise;
    try {
      // 2026-05-04 — Process tree kill. yt-dlp delegates HLS fragment
      // fetching to a child ffmpeg; SIGTERM-ing yt-dlp leaves ffmpeg
      // as an orphan that keeps writing to disk indefinitely (12-strong
      // zombie pile observed on 5/4). taskkill /F /T walks the tree.
      const pid = this.proc.pid;
      if (process.platform === 'win32' && typeof pid === 'number') {
        killProcessTreeWindows(pid);
      } else {
        this.proc.kill();
      }
    } catch (err) {
      console.warn('[stream-recorder] kill failed:', err);
    }
    return this.exitPromise;
  }

  // Synchronous kill for the `before-quit` shutdown path. Doesn't
  // wait for the subprocess to fully exit — Electron is about to
  // tear the whole process tree down anyway, and any leftover yt-dlp
  // would be reaped by Windows when the parent dies. Marks
  // stopRequested so the (possibly-running) exit handler won't
  // mis-classify the kill as a crash.
  killSync(): void {
    this.stopRequested = true;
    if (!this.proc || this.proc.exitCode != null) return;
    try {
      const pid = this.proc.pid;
      if (process.platform === 'win32' && typeof pid === 'number') {
        killProcessTreeWindows(pid);
      } else {
        this.proc.kill();
      }
    } catch (err) {
      console.warn('[stream-recorder] killSync failed:', err);
    }
  }

  // Wait for the subprocess to exit on its own (used by the
  // streamMonitor:ended path — the live process should already be
  // tearing itself down because the upstream stream stopped).
  async waitForExit(): Promise<void> {
    return this.exitPromise;
  }
}

export async function writeAndNotify(
  meta: RecordingMetadata,
  notify: (m: RecordingMetadata) => void,
): Promise<void> {
  await writeMetadata(meta);
  notify(meta);
}

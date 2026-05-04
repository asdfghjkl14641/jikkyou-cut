// 段階 X3+X4 — auto-record orchestrator.
//
// Subscribes to streamMonitor's in-process started/ended events. For
// each `started` it spins up a RecordingSession; for each `ended` it
// stops the session (gracefully — yt-dlp / streamlink usually self-
// terminate when the stream closes, this is a belt-and-braces stop)
// and kicks off a VOD re-fetch.
//
// Side-effects flow through `onMetadataChange` which the wiring in
// main/index.ts wires to:
//   1. writeMetadata() — persist the JSON
//   2. webContents.send('streamRecorder:progress', meta) — update UI
//
// Lifecycle of a single recording's metadata:
//   recording → live-ended → vod-fetching → completed
//                 ↓                ↓
//                failed          failed (rare)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { loadConfig } from '../config';
import { loadTwitchSecret } from '../secureStorage';
import {
  getCookiesArgs,
  classifyUrlPlatform,
} from '../urlDownload';
import { getLiveStreams } from '../twitchHelix';
import { fetchVideoLiveDetails } from '../dataCollection/youtubeApi';
import {
  defaultRecordingDir,
  ensureFolder,
  freeBytes,
  listAllMetadata,
  makeRecordingId,
  migrateLegacyExtensions,
  recordingFolder,
  recoverInterruptedRecordings,
  refreshFileSizes,
  writeMetadata,
  writeMetadataSync,
} from './storage';
import { downloadVod, resolveVodUrl } from './vodFetch';
import { RecordingSession } from './recordSession';
import { verifyAndRemuxIfNeeded } from './remux';
import * as powerSave from '../powerSave';
import type { LiveStreamInfo, RecordingMetadata } from '../../common/types';

function powerSaveReason(creatorKey: string, recordingId: string): string {
  return `recording:${recordingId || creatorKey}`;
}

// Disk space thresholds. The 50 GB warning is informational; the
// 10 GB cliff is the abort threshold.
const FREE_BYTES_WARN_THRESHOLD = 50n * 1024n * 1024n * 1024n;
const FREE_BYTES_FAIL_THRESHOLD = 10n * 1024n * 1024n * 1024n;

// Cap concurrent live recordings. Spec says ~5 is the realistic
// upper bound for residential bandwidth; past that yt-dlp throughput
// craters and recordings get fragment-skip'd. Skip 6th+ entirely.
const MAX_CONCURRENT_RECORDINGS = 5;

// File size periodic refresh (so the UI shows growing live captures).
const FILESIZE_REFRESH_MS = 15_000;

class StreamRecorder {
  private active: Map<string, RecordingSession> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private filesizeTimer: NodeJS.Timeout | null = null;

  attachWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  // Boot wiring. Caller sets up subscriptions to streamMonitor and
  // calls this to seed the recovery sweep + start the periodic
  // filesize refresh.
  async boot(): Promise<void> {
    const cfg = await loadConfig();
    const baseDir = cfg.recordingDir ?? defaultRecordingDir();
    // 2026-05-04 — Pre-2026-05-04 captures used `.live.mp4` /
    // `.live.NNN.mp4` / `.vod.mp4`. Migrate them to the new
    // `<id>.mp4` / `<id>.NNN.mp4` / `<id>_vod.mp4` shape so Windows
    // Media Player can play the on-disk archive (the old form
    // returned error 0x80070323). Idempotent — already-migrated
    // folders are no-ops.
    try {
      const migrated = await migrateLegacyExtensions(baseDir);
      if (migrated > 0) {
        console.log(
          `[stream-recorder] boot migration: renamed ${migrated} legacy file(s) to new extension scheme`,
        );
      }
    } catch (err) {
      console.warn('[stream-recorder] boot migration failed:', err);
    }
    try {
      const recovered = await recoverInterruptedRecordings(baseDir);
      if (recovered > 0) {
        console.log(
          `[stream-recorder] boot recovery: marked ${recovered} stale recording(s) as failed`,
        );
      }
    } catch (err) {
      console.warn('[stream-recorder] boot recovery failed:', err);
    }
    if (this.filesizeTimer == null) {
      this.filesizeTimer = setInterval(() => void this.broadcastFileSizeRefresh(), FILESIZE_REFRESH_MS);
    }
    console.log(
      `[stream-recorder:debug] subscribe registered (recordingEnabled=${cfg.recordingEnabled}, ` +
        `disclaimer=${cfg.recordingDisclaimerAccepted}, recordingDir=${baseDir})`,
    );
  }

  // Triggered by streamMonitor:started in-process subscriber.
  async onStreamStarted(info: LiveStreamInfo): Promise<void> {
    const key = `${info.platform}:${info.creatorKey}`;
    console.log(`[stream-recorder:debug] started event received: ${key}`);

    const cfg = await loadConfig();
    console.log(
      `[stream-recorder:debug] config check: enabled=${cfg.recordingEnabled}, ` +
        `disclaimer=${cfg.recordingDisclaimerAccepted}`,
    );
    if (!cfg.recordingEnabled) {
      console.log(`[stream-recorder:debug] startRecording skipped: recordingEnabled=false (${key})`);
      return;
    }
    // Defense-in-depth: the SettingsDialog is the only path that flips
    // recordingEnabled on, and it forces the disclaimer first. But
    // surfacing the gate here too means a hand-edited config.json
    // can't bypass the warning.
    if (!cfg.recordingDisclaimerAccepted) {
      console.log(
        `[stream-recorder:debug] startRecording skipped: disclaimer not accepted (${key})`,
      );
      return;
    }

    if (this.active.has(key)) {
      console.log(`[stream-recorder:debug] startRecording skipped: already recording (${key})`);
      return;
    }
    if (this.active.size >= MAX_CONCURRENT_RECORDINGS) {
      console.warn(
        `[stream-recorder:debug] startRecording skipped: concurrent cap ${MAX_CONCURRENT_RECORDINGS} hit (${key})`,
      );
      return;
    }

    const baseDir = cfg.recordingDir ?? defaultRecordingDir();
    await ensureFolder(baseDir);

    // Disk space gate. Aborting at 10 GB is conservative — typical
    // 4-hour stream is 8-12 GB. Better to refuse + warn than half-
    // record and run out mid-stream.
    const free = await freeBytes(baseDir);
    if (free != null && BigInt(free) < FREE_BYTES_FAIL_THRESHOLD) {
      console.warn(
        `[stream-recorder:debug] startRecording skipped: disk too low (${(free / 1024 / 1024 / 1024).toFixed(1)} GB) (${key})`,
      );
      return;
    }
    if (free != null && BigInt(free) < FREE_BYTES_WARN_THRESHOLD) {
      console.warn(
        `[stream-recorder] disk space warning: ${(free / 1024 / 1024 / 1024).toFixed(1)} GB free`,
      );
    }
    console.log(`[stream-recorder:debug] startRecording called for ${key}`);

    const folder = recordingFolder(baseDir, info);
    await ensureFolder(folder);

    const recordingId = makeRecordingId({
      platform: info.platform,
      creatorKey: info.creatorKey,
      startedAt: info.startedAt,
    });
    const meta: RecordingMetadata = {
      recordingId,
      platform: info.platform,
      creatorKey: info.creatorKey,
      displayName: info.displayName,
      title: info.title,
      startedAt: info.startedAt,
      endedAt: null,
      sourceUrl: info.url,
      files: { live: null, vod: null },
      fileSizeBytes: { live: null, vod: null },
      status: 'recording',
      folder,
    };

    // 2026-05-04 fix — pre-build cookies args using the same priority
    // order as urlDownload (`platform-specific > generic > browser`).
    // This was previously not threaded into the live-recording yt-dlp
    // invocation, meaning age-restricted / sub-only Twitch streams
    // would 401. Same getCookiesArgs the VOD re-fetch path uses.
    const cookiesArgs = getCookiesArgs({
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
      platform: info.platform,
    });

    // 2026-05-04 — probeIsStillLive lets RecordingSession decide
    // whether yt-dlp's early exit means "stream done, finalise" or
    // "transient blip, respawn". Per platform:
    //   Twitch  — helix/streams?user_id=<creatorKey> single-shot.
    //             Returns the user's row when live, empty otherwise.
    //   YouTube — videos.list?id=<videoId>&part=liveStreamingDetails.
    //             actualEndTime ≠ null = stream ended (the user can also
    //             go private which our check-status will treat as ended).
    const probeIsStillLive = async (): Promise<boolean> => {
      try {
        if (info.platform === 'twitch') {
          const cfgNow = await loadConfig();
          const sec = await loadTwitchSecret();
          if (!cfgNow.twitchClientId || !sec) {
            console.warn('[stream-recorder] probeIsStillLive: twitch creds missing, returning true (defensive)');
            return true;
          }
          const map = await getLiveStreams(cfgNow.twitchClientId, sec, [info.creatorKey]);
          return map.has(info.creatorKey);
        }
        // YouTube
        if (!info.videoId) return false;
        const details = await fetchVideoLiveDetails([info.videoId]);
        const hit = details[0];
        if (!hit) return false;
        return hit.actualEndTime == null;
      } catch (err) {
        console.warn('[stream-recorder] probeIsStillLive threw:', err);
        // Return true so we don't accidentally finalise a real live
        // stream because of a transient API hiccup. The MAX_RESTARTS
        // cap is the backstop against infinite respawn.
        return true;
      }
    };

    const session = new RecordingSession({
      info,
      meta,
      quality: cfg.recordingQuality,
      cookiesArgs,
      deps: {
        onMetadataChange: (m) => void this.persistAndNotify(m),
        probeIsStillLive,
      },
    });
    this.active.set(key, session);
    // Engage OS power-save blocker if the user opted in. Per-recording
    // tag keeps the blocker alive across multiple concurrent sessions
    // (each tag is independent).
    if (cfg.preventSleepDuringRecording) {
      powerSave.acquire(powerSaveReason(info.creatorKey, recordingId));
    }
    await this.persistAndNotify(meta);
    console.log(`[stream-recorder] start: ${key} (recordingId=${recordingId})`);
  }

  // Triggered by streamMonitor:ended in-process subscriber.
  async onStreamEnded(args: { creatorKey: string }): Promise<void> {
    // streamMonitor:ended only carries creatorKey (it doesn't know the
    // platform), so we have to find the active session by creatorKey
    // alone. Both Twitch and YouTube use the platform-stable id
    // already — collisions across platforms are technically possible
    // but vanishingly unlikely in practice (different formats).
    const entry = Array.from(this.active.entries()).find(([k]) => k.endsWith(`:${args.creatorKey}`));
    if (!entry) {
      console.log(`[stream-recorder] ended event for unknown creator ${args.creatorKey}; skipping`);
      return;
    }
    const [key, session] = entry;
    console.log(`[stream-recorder] stop: ${key}`);

    // Tell the session to gracefully stop. yt-dlp / streamlink may
    // have already exited on their own (the stream itself closed),
    // in which case stop() resolves immediately.
    await session.stop();
    this.active.delete(key);
    // Release the OS power-save tag for this recording. If other
    // recordings are still running, the blocker stays engaged because
    // their tags are still acquired.
    powerSave.release(powerSaveReason(session.meta.creatorKey, session.meta.recordingId));

    // 2026-05-04 — Post-record remux pass. yt-dlp + --merge-output-format
    // mp4 covers the common case but VP9 / AV1 / .ts wrappers can slip
    // through, and the renderer's <video> element refuses non-MP4 /
    // non-WebM silently. We ffprobe each captured segment and stream-
    // copy remux to .mp4 when codecs allow. This is a no-op for files
    // that already match (Twitch HLS will skip this every time).
    await this.remuxSegments(session.meta);

    // live-ended → fall into vod-fetching unless disabled.
    const meta = refreshFileSizes(session.meta);
    if (meta.status !== 'failed') {
      meta.status = 'live-ended';
      meta.endedAt = new Date().toISOString();
    }
    await this.persistAndNotify(meta);

    const cfg = await loadConfig();
    if (!cfg.recordingVodFallback || meta.status === 'failed') {
      // No VOD path requested (or live capture failed and we'd be
      // re-fetching a partial mess); finish here.
      const final: RecordingMetadata = {
        ...meta,
        status: meta.status === 'failed' ? 'failed' : 'completed',
      };
      await this.persistAndNotify(final);
      return;
    }

    // Kick off VOD re-fetch in the background — this can take many
    // minutes (Twitch publishes ~5min after end, YouTube can take
    // longer to finalize). The UI shows status='vod-fetching'
    // throughout.
    void this.runVodFetch({ ...meta, status: 'vod-fetching' });
  }

  // 2026-05-04 — Walk every live segment file (single-segment recordings
  // = just `files.live`; restart-rotated = `liveSegments[]`) and remux
  // through ffmpeg `-c copy` to MP4 when codecs allow but container
  // doesn't match. Mutates meta.files.live + meta.liveSegments in
  // place to point at the new filenames.
  private async remuxSegments(meta: RecordingMetadata): Promise<void> {
    const segmentNames = meta.liveSegments && meta.liveSegments.length > 0
      ? [...meta.liveSegments]
      : meta.files.live ? [meta.files.live] : [];
    if (segmentNames.length === 0) return;

    const incompatible: Array<{ filename: string; videoCodec: string; audioCodec: string }> = [];
    let anyChanged = false;
    for (let i = 0; i < segmentNames.length; i += 1) {
      const fname = segmentNames[i]!;
      const absPath = path.join(meta.folder, fname);
      const result = await verifyAndRemuxIfNeeded(absPath);
      if (result.kind === 'noop') {
        // Hot path; logged at debug volume only.
        continue;
      }
      if (result.kind === 'remuxed') {
        const newName = path.basename(result.newPath);
        segmentNames[i] = newName;
        anyChanged = true;
        console.log(`[stream-recorder] remux ok: ${fname} → ${newName}`);
        continue;
      }
      if (result.kind === 'incompatible') {
        incompatible.push({ filename: fname, videoCodec: result.videoCodec, audioCodec: result.audioCodec });
        console.warn(
          `[stream-recorder] remux incompatible: ${fname} (${result.videoCodec}/${result.audioCodec}); leaving as-is`,
        );
        continue;
      }
      console.warn(`[stream-recorder] remux failed: ${fname} — ${result.error}`);
    }

    if (anyChanged) {
      // Update meta to reflect post-remux filenames. Single-segment
      // recordings see files.live updated; multi-segment also gets
      // liveSegments synced.
      if (meta.liveSegments && meta.liveSegments.length > 0) {
        meta.liveSegments = segmentNames;
        meta.files.live = segmentNames[segmentNames.length - 1] ?? meta.files.live;
      } else if (segmentNames[0]) {
        meta.files.live = segmentNames[0];
      }
    }
    if (incompatible.length > 0) {
      // Surface a soft warning on the metadata so the recording row
      // can show "編集画面で再生できないかもしれません" without
      // marking the whole capture as failed (the file still plays in
      // VLC etc., it's specifically the renderer's <video> that's
      // limited).
      const warn = `非互換コーデック: ${incompatible
        .map((x) => `${x.videoCodec}/${x.audioCodec}`)
        .join(', ')} (HTML5 video で再生不可)`;
      meta.errorMessage = (meta.errorMessage ? meta.errorMessage + ' / ' : '') + warn;
    }
  }

  private async runVodFetch(meta: RecordingMetadata): Promise<void> {
    await this.persistAndNotify(meta);
    let resolved;
    try {
      resolved = await resolveVodUrl(meta);
    } catch (err) {
      console.warn('[stream-recorder] vod resolve threw:', err);
      resolved = { kind: 'unavailable' as const, reason: String(err) };
    }
    if (resolved.kind === 'unavailable') {
      console.log(`[stream-recorder] vod unavailable for ${meta.recordingId}: ${resolved.reason}`);
      const next: RecordingMetadata = {
        ...meta,
        status: 'completed',
        errorMessage:
          (meta.errorMessage ? meta.errorMessage + ' / ' : '') +
          `VOD unavailable: ${resolved.reason}`,
      };
      await this.persistAndNotify(next);
      return;
    }

    const cfg = await loadConfig();
    const cookiesArgs = getCookiesArgs({
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
      platform: classifyUrlPlatform(resolved.url),
    });
    // touch loadTwitchSecret to keep the import live for future use.
    void loadTwitchSecret;

    const filename = await downloadVod({
      url: resolved.url,
      meta,
      quality: cfg.recordingQuality,
      cookiesArgs,
    });
    if (!filename) {
      const next: RecordingMetadata = {
        ...meta,
        status: 'failed',
        errorMessage:
          (meta.errorMessage ? meta.errorMessage + ' / ' : '') +
          `VOD yt-dlp failed`,
      };
      await this.persistAndNotify(next);
      return;
    }
    const next: RecordingMetadata = refreshFileSizes({
      ...meta,
      files: { ...meta.files, vod: filename },
      status: 'completed',
    });
    await this.persistAndNotify(next);
    console.log(`[stream-recorder] vod completed: ${meta.recordingId}`);
  }

  // List all metadata blobs for the renderer's recordings UI.
  async list(): Promise<RecordingMetadata[]> {
    const cfg = await loadConfig();
    const baseDir = cfg.recordingDir ?? defaultRecordingDir();
    return listAllMetadata(baseDir);
  }

  // Manual stop — invoked from the UI when the user clicks "停止".
  // Same path as the streamMonitor:ended branch, but we have to
  // synthesise the shutdown.
  async stopByCreatorKey(creatorKey: string): Promise<void> {
    return this.onStreamEnded({ creatorKey });
  }

  // Delete a recording (metadata + on-disk files). Renderer calls
  // this from the "削除" button after user confirmation.
  async deleteRecording(recordingId: string): Promise<void> {
    const all = await this.list();
    const target = all.find((m) => m.recordingId === recordingId);
    if (!target) return;
    const liveFile = target.files.live ? path.join(target.folder, target.files.live) : null;
    const vodFile = target.files.vod ? path.join(target.folder, target.files.vod) : null;
    const metaFile = path.join(target.folder, `${target.recordingId}.json`);
    for (const p of [liveFile, vodFile, metaFile]) {
      if (!p) continue;
      try {
        await fs.rm(p, { force: true });
      } catch (err) {
        console.warn('[stream-recorder] delete failed for', p, err);
      }
    }
  }

  async getRecordingDir(): Promise<string> {
    const cfg = await loadConfig();
    return cfg.recordingDir ?? defaultRecordingDir();
  }

  // Number of currently-active recordings. Diagnostic only — used
  // by the shutdown handler in main/index.ts to decide whether the
  // before-quit hook needs to do any work.
  activeCount(): number {
    return this.active.size;
  }

  // Synchronous shutdown for the `before-quit` hook. Blocks the
  // event loop just long enough to:
  //   1. Send SIGTERM to every active subprocess (Windows: kills the
  //      yt-dlp / streamlink child process tree).
  //   2. Persist a final metadata snapshot per recording with
  //      `status='failed'` + `errorMessage='app shutdown — recording
  //      interrupted'`. We use writeFileSync so the file lands on
  //      disk before the parent process tears down — the async
  //      writeMetadata path can lose the write if Electron exits
  //      mid-flush.
  //   3. Release any held powerSave tags.
  //   4. Clear the active map.
  //
  // Doesn't wait for subprocess exit events to fire. The OS reaps
  // the children when the parent dies anyway; the metadata write is
  // the load-bearing bit (so the next boot's recovery sweep can see
  // the recordings as cleanly-failed instead of stuck-recording).
  shutdownSync(): void {
    if (this.active.size === 0) return;
    console.log(`[stream-recorder] shutdownSync: cleaning up ${this.active.size} active session(s)`);
    const errMsg = 'app shutdown — recording interrupted';
    for (const [key, session] of this.active.entries()) {
      try {
        // Sync metadata write FIRST. If killSync fires the process's
        // exit handler in-flight, that handler will overwrite this
        // value with `${kind} exited code=N` — but our message is the
        // closer truth (we're shutting down voluntarily).
        const finalMeta = refreshFileSizes({
          ...session.meta,
          status: 'failed' as const,
          endedAt: session.meta.endedAt ?? new Date().toISOString(),
          errorMessage:
            (session.meta.errorMessage ? session.meta.errorMessage + ' / ' : '') + errMsg,
        });
        writeMetadataSync(finalMeta);
        console.log(`[stream-recorder] shutdownSync: meta written for ${key}`);
      } catch (err) {
        console.warn(`[stream-recorder] shutdownSync: meta write failed for ${key}:`, err);
      }
      try {
        session.killSync();
        console.log(`[stream-recorder] shutdownSync: killSync sent for ${key}`);
      } catch (err) {
        console.warn(`[stream-recorder] shutdownSync: killSync failed for ${key}:`, err);
      }
      try {
        powerSave.release(powerSaveReason(session.meta.creatorKey, session.meta.recordingId));
      } catch {
        // powerSave.release is already idempotent + try/catch internally.
      }
    }
    this.active.clear();
    if (this.filesizeTimer != null) {
      clearInterval(this.filesizeTimer);
      this.filesizeTimer = null;
    }
    console.log('[stream-recorder] shutdownSync: done');
  }

  // Periodic filesize refresh broadcast. Cheap (stat per active
  // recording) — only the renderer's UI cares, and only while the
  // recordings page is open. We don't try to be smarter about this
  // because the cost is so low.
  private async broadcastFileSizeRefresh(): Promise<void> {
    if (this.active.size === 0) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    for (const session of this.active.values()) {
      const refreshed = refreshFileSizes(session.meta);
      this.mainWindow.webContents.send('streamRecorder:progress', refreshed);
    }
  }

  // Internal — write JSON + emit IPC. Refreshes file sizes one more
  // time so the saved snapshot is current.
  private async persistAndNotify(meta: RecordingMetadata): Promise<void> {
    const refreshed = refreshFileSizes(meta);
    try {
      await writeMetadata(refreshed);
    } catch (err) {
      console.warn('[stream-recorder] writeMetadata failed:', err);
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('streamRecorder:progress', refreshed);
    }
  }
}

export const streamRecorder = new StreamRecorder();

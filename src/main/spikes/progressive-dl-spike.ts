/**
 * SPIKE — progressive DL feasibility experiments.
 *
 * Status: experimental, NOT wired into production.
 * Read alongside docs/PROGRESSIVE_DL_SPIKE_REPORT.md.
 *
 * To run: invoke `runSpike1A_DownloadSections()` etc from a temporary main
 * process entry (e.g. menu item or `process.env.JIKKYOU_SPIKE === '1'`
 * gate at app start). NEVER import from production paths.
 *
 * Each function appends to `userData/spike-<n>.log` for later review.
 */

import { app } from 'electron';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ytdlpPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe')
    : path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');

const spikeDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'spike');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const log = (file: string, msg: string): void => {
  writeFileSync(path.join(spikeDir(), file), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
};

/**
 * Spike 1A: --download-sections "*X-Y" against a long video.
 * Verifies that two separate yt-dlp processes can each grab a different
 * range, then ffmpeg concat (-c copy) joins them losslessly.
 *
 * Empirical result on 19s test video (Me at the zoo):
 *   - part0-10.mp4: 416 KB, duration 10.07s (no force-keyframes)
 *   - part10-19.mp4: 359 KB, duration 9.00s
 *   - joined: 775 KB, duration 19.02s — ffmpeg `-c copy` warns "non-monotonic
 *     DTS" but produces a playable file
 *   - With --force-keyframes-at-cuts: exact duration 10.000s (re-encoding)
 *
 * Wall-clock: ~4s per range on this short video. Time mostly is YouTube
 * format extraction overhead, not DL itself.
 */
export async function runSpike1A_DownloadSections(url: string): Promise<void> {
  log('1A.log', `=== spike 1A start, url=${url} ===`);
  const dir = path.join(spikeDir(), '1A');
  mkdirSync(dir, { recursive: true });

  const runRange = (range: string, name: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(ytdlpPath(), [
        url,
        '-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--download-sections', range,
        '-o', path.join(dir, `${name}.%(ext)s`),
        '--merge-output-format', 'mp4',
        '--force-keyframes-at-cuts', // exact-duration cuts but re-encodes
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '--print', 'after_move:filepath',
      ]);
      let out = '';
      proc.stdout?.on('data', (d) => (out += d.toString()));
      proc.stderr?.on('data', (d) => log('1A.log', `[${name} stderr] ${d.toString().trim()}`));
      proc.on('exit', (code) => {
        log('1A.log', `[${name}] exit=${code}, stdout=${out.trim()}`);
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited ${code}`));
      });
    });

  try {
    const t0 = Date.now();
    await runRange('*0-30', 'part0-30');
    log('1A.log', `part 0-30 took ${Date.now() - t0}ms`);

    const t1 = Date.now();
    await runRange('*30-60', 'part30-60');
    log('1A.log', `part 30-60 took ${Date.now() - t1}ms`);

    log('1A.log', '✅ Both ranges downloaded. Concat with: ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4');
  } catch (err) {
    log('1A.log', `❌ ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Spike 1B: HLS protocol availability for YouTube VOD.
 *
 * Empirical result: YouTube VOD format list (`-F`) shows ALL entries with
 * PROTO=https (mp4_dash / webm_dash). HLS m3u8 is not offered for archived
 * videos. `--hls-prefer-native` has no effect because no HLS formats exist
 * to prefer. Twitch VOD does serve HLS but is out of scope.
 *
 * Conclusion: HLS-segment-feed approach is NOT viable for YouTube; fall
 * back to DASH range-based DL (Spike 1A) or direct stdout pipe.
 */
export async function runSpike1B_HlsAvailability(url: string): Promise<void> {
  log('1B.log', `=== spike 1B start, url=${url} ===`);
  const proc = spawn(ytdlpPath(), [
    '-F', '--no-playlist', '--no-warnings', url,
  ]);
  let out = '';
  proc.stdout?.on('data', (d) => (out += d.toString()));
  proc.on('exit', () => {
    log('1B.log', out);
    const hlsLines = out.split('\n').filter((l) => /hls|m3u8/i.test(l));
    log('1B.log', `HLS-flagged formats: ${hlsLines.length}`);
    log('1B.log', hlsLines.length === 0 ? '❌ No HLS formats — DASH only' : '✅ HLS formats exist');
  });
}

/**
 * Spike 2: <video> buffered range during progressive DL.
 *
 * Three approaches (no spawn needed — design analysis):
 *
 * A. Static HTTP Range against growing file:
 *    - mediaProtocol.ts uses `fs.stat(filePath).size` once per request.
 *    - Browser caches Content-Length from first response. Subsequent Range
 *      requests for bytes past that cached size return 416.
 *    - Verdict: ❌ Hits the wall the moment the file grows.
 *
 * B. MediaSource + IPC stream of fragmented MP4:
 *    - Renderer creates `MediaSource`, opens `SourceBuffer`, appends
 *      fragments as they arrive over IPC from main.
 *    - Main pipes yt-dlp output through ffmpeg with
 *      `-movflags frag_keyframe+empty_moov+default_base_moof` to produce
 *      fragmented MP4. Each fragment is ~1-2s of self-contained video.
 *    - Renderer's `SourceBuffer.appendBuffer(chunk)` extends the playable
 *      range; `<video>.buffered.end(0)` grows live.
 *    - Seeking past buffered end: triggers a `seeking` event, we kill the
 *      current ffmpeg pipe, restart with `-ss <target>` for the new
 *      starting point, swap into a new `SourceBuffer`.
 *    - Verdict: ✅ Cleanest UX, but significant engineering: codec init
 *      bytes, source buffer management, error recovery. Worth it for the
 *      "YouTube-like" experience the user wants.
 *
 * C. Custom mediaProtocol with growing-file awareness:
 *    - Override Content-Length to a large value (e.g. estimated from
 *      `--print duration`).
 *    - For Range requests past current file size, hold the response open
 *      until bytes arrive (long-poll style).
 *    - Verdict: ⚠️ Possible but fragile. Browsers have timeouts; holding
 *      a response open for minutes risks aborts. Also forces a sequential
 *      DL model — can't easily inject "shift追従" range requests.
 *
 * Recommended: B (MediaSource + IPC fragmented MP4 feed).
 */
export function runSpike2_BufferedRange(): void {
  log('2.log', '=== spike 2: see source code comments and PROGRESSIVE_DL_SPIKE_REPORT.md ===');
}

/**
 * Spike 3: Gladia incremental transcription.
 *
 * Empirical (from docs.gladia.io/api-reference/v2/):
 *   - /v2/pre-recorded: requires complete audio_url, no chunk semantics
 *   - /v2/live: WebSocket-based, accepts streaming PCM (8/16/24/32-bit) at
 *     8000-48000 Hz, supports partial + final transcripts incrementally
 *
 * Two strategies:
 *
 * A. Use /v2/live during progressive DL:
 *    - Tap into the audio stream as it arrives (ffmpeg -f s16le -ar 16000)
 *    - Stream raw PCM frames over WebSocket
 *    - Receive partial cues incrementally → push into editorStore as they
 *      land
 *    - Pros: True real-time, low latency
 *    - Cons: WebSocket lifecycle in main, reconnect logic, billing model
 *      may differ from pre-recorded
 *
 * B. Chunk-and-batch /v2/pre-recorded:
 *    - Every N minutes, run ffmpeg over the partial mp4 (`-to <currentEnd>`)
 *      to extract a chunk
 *    - Submit each chunk to /v2/pre-recorded
 *    - Offset returned cue timestamps by chunk start time
 *    - Pros: Reuses existing gladia.ts logic
 *    - Cons: Latency per chunk (extract + upload + poll cycle), need to
 *      offset cue timestamps to original timeline
 *
 * Recommended: B for MVP (reuse code), A for v2 if user wants instant
 * partials during a 4-hour archive playback.
 */
export function runSpike3_GladiaIncremental(): void {
  log('3.log', '=== spike 3: see source code comments and PROGRESSIVE_DL_SPIKE_REPORT.md ===');
}

/**
 * Spike 4: process management for multiple concurrent yt-dlp processes.
 *
 * Required capabilities:
 *   - Track all spawned yt-dlp / ffmpeg processes by ID
 *   - Cancel by ID, cancel all, cancel by URL
 *   - Detect when a "shift追従" target overlaps an existing range → reuse
 *     the in-flight DL instead of starting a duplicate
 *   - Surface errors per-process to renderer (one process failing
 *     shouldn't abort the whole session)
 *
 * Design sketch (text):
 *
 *   class ProgressiveDLManager {
 *     // Single primary "sequential" DL covering [0, end]
 *     primary: ChildProcess | null
 *     // Secondary "seek-priority" DL covering [seekTarget, end]; killed
 *     // when target is reached or user seeks again
 *     secondary: ChildProcess | null
 *     // Audio extraction pump (ffmpeg, restarts every N seconds)
 *     audioPump: ChildProcess | null
 *     // Gladia chunk submitter — orchestrates B-strategy chunks
 *     gladia: ChunkSubmitter
 *
 *     start(url): assigns primary
 *     onSeek(targetSec): kills secondary if any, spawns new secondary
 *     onSeekResolved(): kills secondary (primary catches up)
 *     cancel(): kills all
 *   }
 *
 * Cancel semantics: process.kill() on Windows = SIGTERM. yt-dlp leaves
 * .part files behind on kill — sweep them in a finally block.
 *
 * File ownership: secondary writes to a different output path than
 * primary so they don't collide. Concat at the end.
 */
export function runSpike4_ProcessMgmt(): void {
  log('4.log', '=== spike 4: see source code comments and PROGRESSIVE_DL_SPIKE_REPORT.md ===');
}

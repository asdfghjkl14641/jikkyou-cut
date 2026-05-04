// 段階 X2 — Stream-monitor orchestrator.
//
// What it does:
//   - Every POLL_INTERVAL_MS, fetch live status for every enabled
//     monitored creator (Twitch + YouTube branches in parallel).
//   - Diff against the previous tick to compute newly-live + newly-
//     ended sets, then emit IPC events.
//   - Maintain an in-memory map of "currently live" streams, queryable
//     via IPC.
//
// What it does NOT do:
//   - Recording (段階 X3).
//   - Persistence — restart re-polls and rebuilds state from scratch.
//   - Per-creator polling cadence — every creator polls on the same
//     master interval. Future X-stage may differentiate (Twitch on
//     1 min, YouTube on 5 min) if quota becomes an issue.

import type { BrowserWindow } from 'electron';
import { loadConfig } from '../config';
import { loadTwitchSecret } from '../secureStorage';
import { monitoredCreatorKey, type MonitoredCreator } from '../../common/config';
import { pollTwitchUsers } from './twitchPoll';
import { pollYouTubeChannels } from './youtubePoll';

const POLL_INTERVAL_MS = 60_000;

// 2026-05-04 — Consecutive missing threshold. Twitch's helix/streams
// occasionally drops a still-live user from the response (transient
// API blip, ad-roll edge case, network hiccup) — observed on real
// configurations during multi-hour archives. Without a buffer the
// monitor would emit a spurious "ended" event, the recorder would
// stop yt-dlp, and the user would discover later that their archive
// got truncated for a 1-poll glitch. Three consecutive missing polls
// (= 3 minutes off-air at 1-min cadence) is the floor for "the
// stream actually ended" before we trust the absence.
const ENDED_MISS_THRESHOLD = 3;

// Public shape sent over IPC. Same on both platforms — the discriminator
// is `platform`. `videoId` is YouTube-only (it's the live video's
// public ID; Twitch has stream IDs but they're internal-only and not
// useful for the user). `streamId` is Twitch-only (helix's stream id
// — needed in 段階 X3 to construct a recording URL more cleanly).
export type LiveStreamInfo = {
  platform: 'twitch' | 'youtube';
  creatorKey: string;        // monitoredCreatorKey(creator)
  displayName: string;       // copied from creator at detection time
  title: string;
  startedAt: string;         // ISO 8601
  detectedAt: number;        // UNIX ms when we first saw it live this run
  videoId?: string;          // YouTube
  streamId?: string;         // Twitch (helix stream.id)
  thumbnailUrl?: string;
  // Convenience URL the renderer can navigate to / show.
  url: string;
};

export type StreamMonitorStatus = {
  enabled: boolean;
  isRunning: boolean;        // whether a poll is in flight RIGHT NOW
  lastPollAt: number | null; // UNIX ms
  nextPollAt: number | null; // UNIX ms (predicted)
  liveStreams: LiveStreamInfo[];
};

class StreamMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private inflight = false;
  private liveStreams = new Map<string, LiveStreamInfo>();
  // 2026-05-04 — per-creator consecutive-miss counter. Increments on
  // each poll where a previously-live creator is missing; resets to 0
  // (entry deleted) when they reappear OR when ENDED_MISS_THRESHOLD
  // fires the ended event.
  private missingCounts = new Map<string, number>();
  private lastPollAt: number | null = null;
  private mainWindow: BrowserWindow | null = null;
  // 段階 X3.5 — in-process subscribers (tray, etc) that want the same
  // status pushes as the renderer without going through IPC. Each
  // subscriber receives every status update fired through `send`.
  private statusListeners = new Set<(status: StreamMonitorStatus) => void>();
  // 段階 X3 — in-process subscribers for stream-start / stream-end
  // events. The recorder uses these to spawn yt-dlp / streamlink as
  // soon as a stream comes online and to gracefully stop when it ends.
  private startedListeners = new Set<(info: LiveStreamInfo) => void>();
  private endedListeners = new Set<(args: { creatorKey: string }) => void>();

  // Caller injects the window on app boot so events can be sent
  // without touching the main module's mainWindow ref directly. Set
  // once; the window is recreated only on user-initiated quit & relaunch.
  attachWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  isEnabled(): boolean {
    return this.intervalId != null;
  }

  start(): void {
    if (this.intervalId != null) return;
    console.log('[stream-monitor] start (interval=' + POLL_INTERVAL_MS + 'ms)');
    // Fire once immediately so the user gets feedback within seconds
    // of toggling ON, then on the regular cadence.
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId == null) return;
    console.log('[stream-monitor] stop');
    clearInterval(this.intervalId);
    this.intervalId = null;
    // Keep the in-memory live set so the user re-toggling ON within
    // a poll window doesn't show a stale empty state. Cleared only
    // on app exit.
  }

  getStatus(): StreamMonitorStatus {
    return {
      enabled: this.isEnabled(),
      isRunning: this.inflight,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.lastPollAt != null ? this.lastPollAt + POLL_INTERVAL_MS : null,
      liveStreams: Array.from(this.liveStreams.values()),
    };
  }

  // Force one poll immediately. Used by the renderer's "manual refresh"
  // button + by start() to seed initial state.
  async pollNow(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.inflight) {
      // Concurrent ticks would race the diff against itself. Skip
      // silently — the next interval will catch up.
      return;
    }
    this.inflight = true;
    const startedAt = Date.now();
    try {
      const cfg = await loadConfig();
      const enabled = cfg.monitoredCreators.filter((c) => c.enabled);
      const twitchCreators = enabled.filter(
        (c): c is Extract<MonitoredCreator, { platform: 'twitch' }> => c.platform === 'twitch',
      );
      const youtubeCreators = enabled.filter(
        (c): c is Extract<MonitoredCreator, { platform: 'youtube' }> => c.platform === 'youtube',
      );
      console.log(
        `[stream-monitor] poll start: ${twitchCreators.length} twitch, ${youtubeCreators.length} youtube`,
      );

      // Twitch needs credentials — silently skip the whole branch when
      // they're missing rather than noisily error every minute. Logged
      // once per poll so the user notices in the terminal.
      const sec = await loadTwitchSecret();
      const twitchAvailable = !!cfg.twitchClientId && !!sec;
      if (twitchCreators.length > 0 && !twitchAvailable) {
        console.warn('[stream-monitor] twitch creators registered but credentials not set — skipping twitch branch');
      }

      const [twitchMap, youtubeMap] = await Promise.all([
        twitchAvailable
          ? pollTwitchUsers(
              cfg.twitchClientId!,
              sec!,
              twitchCreators.map((c) => c.twitchUserId),
            )
          : Promise.resolve(new Map()),
        pollYouTubeChannels(youtubeCreators.map((c) => c.youtubeChannelId)),
      ]);

      // Build the new "currently live" set keyed the same way as the
      // previous one (`platform:id`) so diffing is a Map subtract.
      const next = new Map<string, LiveStreamInfo>();
      for (const c of twitchCreators) {
        const t = twitchMap.get(c.twitchUserId);
        if (!t) continue;
        const key = `twitch:${c.twitchUserId}`;
        // Carry detectedAt forward across polls so the UI can show
        // "X 分前から配信中" without resetting on each tick.
        const prior = this.liveStreams.get(key);
        next.set(key, {
          platform: 'twitch',
          creatorKey: c.twitchUserId,
          displayName: c.displayName,
          title: t.title ?? '',
          startedAt: t.startedAt ?? new Date().toISOString(),
          detectedAt: prior?.detectedAt ?? Date.now(),
          thumbnailUrl: t.thumbnailUrl,
          url: `https://www.twitch.tv/${c.twitchLogin}`,
        });
      }
      for (const c of youtubeCreators) {
        const y = youtubeMap.get(c.youtubeChannelId);
        if (!y) continue;
        const key = `youtube:${c.youtubeChannelId}`;
        const prior = this.liveStreams.get(key);
        next.set(key, {
          platform: 'youtube',
          creatorKey: c.youtubeChannelId,
          displayName: c.displayName,
          title: y.title,
          startedAt: y.actualStartTime ?? new Date().toISOString(),
          detectedAt: prior?.detectedAt ?? Date.now(),
          videoId: y.id,
          thumbnailUrl: y.thumbnailUrl ?? undefined,
          url: `https://www.youtube.com/watch?v=${y.id}`,
        });
      }

      // Diff. Started = new in `next`. Missing = was in liveStreams,
      // not in `next`. Missing accumulates a per-creator counter; we
      // only fire ended when it crosses ENDED_MISS_THRESHOLD so a 1-poll
      // API glitch doesn't kill an in-progress recording.
      const startedKeys: string[] = [];
      const endedKeys: string[] = [];
      for (const k of next.keys()) {
        if (!this.liveStreams.has(k)) startedKeys.push(k);
        // Reset the miss counter the moment a creator reappears —
        // they were live during this poll, so the previous miss(es)
        // were transient.
        if (this.missingCounts.delete(k)) {
          console.log(`[stream-monitor] ${k}: live again (miss counter reset)`);
        }
      }
      // Build the effective live set: anything in `next` PLUS anything
      // that was live before and is currently in the miss-grace window.
      // Without this, the public liveStreams shrinks immediately on
      // the first miss, racing the UI / recorder against the threshold.
      const effective = new Map(next);
      for (const [k, prior] of this.liveStreams.entries()) {
        if (next.has(k)) continue;
        // Already in the grace window: increment, decide.
        const miss = (this.missingCounts.get(k) ?? 0) + 1;
        if (miss < ENDED_MISS_THRESHOLD) {
          this.missingCounts.set(k, miss);
          // Carry the prior info forward so consumers don't see a
          // gap. We don't update its title / fields — the upstream
          // didn't return one, so the last-known is best-known.
          effective.set(k, prior);
          console.log(
            `[stream-monitor] ${k}: missing ${miss}/${ENDED_MISS_THRESHOLD}, holding`,
          );
        } else {
          this.missingCounts.delete(k);
          endedKeys.push(k);
          console.log(`[stream-monitor] ${k}: missing ${miss}/${ENDED_MISS_THRESHOLD} → ended`);
        }
      }

      this.liveStreams = effective;
      this.lastPollAt = Date.now();

      console.log(
        `[stream-monitor] state changes: +${startedKeys.length} started, ${endedKeys.length} ended; ` +
          `now ${this.liveStreams.size} live (${this.missingCounts.size} in miss-grace); ` +
          `took ${Date.now() - startedAt}ms`,
      );

      // Notify renderer. Status update fires regardless so UI labels
      // (last-poll timestamp, the live-set itself) stay current.
      this.send('streamMonitor:status', this.getStatus());
      for (const k of startedKeys) {
        const info = next.get(k);
        if (info) this.send('streamMonitor:started', info);
      }
      for (const k of endedKeys) {
        this.send('streamMonitor:ended', { creatorKey: k });
      }
    } catch (err) {
      console.warn(
        '[stream-monitor] poll error:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.inflight = false;
    }
  }

  // In-process subscribe — tray uses this so we don't reflect status
  // updates through Electron IPC just to come back into main.
  subscribeStatus(listener: (status: StreamMonitorStatus) => void): () => void {
    this.statusListeners.add(listener);
    // Push current state immediately so the new subscriber doesn't
    // sit blank until the next poll.
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribeStreamStarted(listener: (info: LiveStreamInfo) => void): () => void {
    this.startedListeners.add(listener);
    return () => {
      this.startedListeners.delete(listener);
    };
  }

  subscribeStreamEnded(listener: (args: { creatorKey: string }) => void): () => void {
    this.endedListeners.add(listener);
    return () => {
      this.endedListeners.delete(listener);
    };
  }

  private send(channel: string, payload: unknown): void {
    if (channel === 'streamMonitor:status') {
      for (const listener of this.statusListeners) {
        try {
          listener(payload as StreamMonitorStatus);
        } catch (err) {
          console.warn('[stream-monitor] in-process status listener threw:', err);
        }
      }
    }
    if (channel === 'streamMonitor:started') {
      for (const listener of this.startedListeners) {
        try {
          listener(payload as LiveStreamInfo);
        } catch (err) {
          console.warn('[stream-monitor] in-process started listener threw:', err);
        }
      }
    }
    if (channel === 'streamMonitor:ended') {
      for (const listener of this.endedListeners) {
        try {
          listener(payload as { creatorKey: string });
        } catch (err) {
          console.warn('[stream-monitor] in-process ended listener threw:', err);
        }
      }
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(channel, payload);
  }
}

export const streamMonitor = new StreamMonitor();

import {
  CollectionStats,
  getStats,
  upsertCreator,
  upsertVideoFull,
  videoExists,
} from './database';
import { hasYoutubeApiKeys } from '../secureStorage';
import { fetchVideoDetails, parseIsoDuration, refreshKeys, searchVideos } from './youtubeApi';
import { extractVideoData } from './ytDlpExtractor';
import { BROAD_QUERIES, SEARCH_DEFAULTS, buildPerCreatorQueries } from './searchQueries';
import { loadCreatorList } from './creatorList';
import { resolveCreatorChannelIds } from './seedCreators';
import { logError, logInfo, logWarn } from './logger';

// Background data-collection orchestrator. Single instance per main
// process. Auto-starts ~5 s after `start()` is called (giving the rest
// of app-ready time to settle), then runs a collect-batch every hour.
//
// Manual `triggerNow()` is exposed via IPC for the Settings UI to fire
// off-cycle batches — useful for "I just added a creator, run now"
// flows.

type ManagerState = 'idle' | 'running' | 'paused';

// Cycle interval — bumped 1h → 2h on 2026-05-03 alongside the seed
// expansion to 75 creators. With per-creator multi-angle queries
// (75 × 3 = 225 search.list = 22.5K units / cycle plus broad +
// channelId resolve), a 1-hour cadence would burn through the
// 50-key 500K daily budget after ~12 cycles. 2 hours = 12 cycles/day
// for ~285K, leaving comfortable headroom for one-off resolution
// passes and 403/quota-exceeded retries.
const COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1000;   // 2 hours between cycles
const STARTUP_DELAY_MS = 5_000;                       // delay after start()
const MAX_VIDEOS_PER_BATCH = 200;                     // cap a single cycle
const NETWORK_RETRY_COOLDOWN_MS = 5 * 60 * 1000;      // 5 min between hard fails
const PER_VIDEO_DELAY_MS = 200;                       // gentle on yt-dlp

class DataCollectionManager {
  private state: ManagerState = 'idle';
  private currentBatch: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Reset at the top of every batch so a previous cancel doesn't bleed
  // into the next run. Toggled true by pause() and cancelCurrentBatch();
  // the batch loop checks it between API calls and bails early.
  private cancelRequested = false;
  // Wall-clock timestamp (ms) when scheduleNext's timer is supposed to
  // fire. Used by the UI to render "次まで N 分" without a separate
  // tick channel. null when no timer is armed (idle / paused / batch
  // currently active).
  private nextBatchAt: number | null = null;

  /** Begin auto-collection. Returns immediately; first cycle fires after
   * STARTUP_DELAY_MS. No-op if no API keys are configured. */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    const hasKeys = await hasYoutubeApiKeys();
    if (!hasKeys) {
      logInfo('no YouTube API keys configured — skipping auto-start');
      return;
    }
    this.state = 'running';
    await refreshKeys();
    this.scheduleNext(STARTUP_DELAY_MS);
  }

  pause(): void {
    if (this.state === 'paused') return;
    this.state = 'paused';
    this.cancelRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextBatchAt = null;
  }

  async resume(): Promise<void> {
    if (this.state === 'running') return;
    this.cancelRequested = false;
    await this.start();
  }

  /** Fire one batch off-cycle. Doesn't reset the regular interval. */
  async triggerNow(): Promise<void> {
    if (this.currentBatch) {
      // Already running — caller can poll getStats() until completion.
      return this.currentBatch;
    }
    return this.runOneBatch();
  }

  /** Stop the in-flight batch without changing the persistent
   * enabled/paused state. The regular schedule (if armed) keeps
   * ticking, so the next cycle will start at its scheduled time as
   * usual. No-op if no batch is currently active. */
  cancelCurrentBatch(): void {
    if (!this.currentBatch) return;
    this.cancelRequested = true;
    logInfo('cancel signal sent — current batch will exit on next checkpoint');
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  getStatsSnapshot(): CollectionStats & {
    isRunning: boolean;
    isPaused: boolean;
    isBatchActive: boolean;
    nextBatchAtSec: number | null;
  } {
    // 3-way state for the UI (running / paused / idle). isRunning and
    // isPaused are mutually exclusive — both false ⇒ idle (no API
    // keys configured, or never started). isBatchActive is orthogonal:
    // true while a batch is mid-flight (whether scheduled or
    // triggerNow-driven). nextBatchAtSec counts down to the next
    // scheduled batch.
    const nextSec =
      this.nextBatchAt != null
        ? Math.max(0, Math.round((this.nextBatchAt - Date.now()) / 1000))
        : null;
    return {
      ...getStats(),
      isRunning: this.state === 'running',
      isPaused: this.state === 'paused',
      isBatchActive: this.currentBatch !== null,
      nextBatchAtSec: nextSec,
    };
  }

  // ---- Internals ----------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.state !== 'running') return;
    this.nextBatchAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.nextBatchAt = null;
      void this.runOneBatch().finally(() => {
        if (this.state === 'running') this.scheduleNext(COLLECTION_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async runOneBatch(): Promise<void> {
    if (this.currentBatch) return this.currentBatch;
    // Fresh start — clear any cancel flag left over from a previous
    // pause / cancelCurrentBatch invocation. The batch will re-set the
    // flag while running if pause / cancel fires mid-batch.
    this.cancelRequested = false;
    const batch = this._collectBatch().catch((err) => {
      logError(`batch error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.currentBatch = batch as Promise<void>;
    try {
      await batch;
    } finally {
      if (this.cancelRequested) {
        logInfo('batch ended — cancelled by user / pause');
      }
      this.currentBatch = null;
    }
  }

  private async _collectBatch(): Promise<void> {
    const startedAt = Date.now();
    logInfo('batch start');

    // Step 0: backfill missing channelIds for seeded creators. No-op
    // when everything is already resolved (the helper skips creators
    // whose channelId is non-null), so steady-state cost is zero.
    try {
      const resolved = await resolveCreatorChannelIds();
      if (resolved > 0) logInfo(`channelId resolution: ${resolved} new`);
    } catch (err) {
      logWarn(`channelId resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 1: search to build a candidate ID pool.
    const candidateIds = new Set<string>();
    const candidateMeta = new Map<string, { creatorName: string | null }>();

    // Per-creator queries first — these are the targeted slice the
    // user explicitly cares about, so they get priority budget.
    // Three angles per creator (切り抜き / 神回 / 名場面) — see
    // searchQueries.buildPerCreatorQueries for rationale.
    const creators = await loadCreatorList();
    for (const c of creators) {
      if (this.cancelRequested) return;
      let creatorTotalHits = 0;
      const queries = buildPerCreatorQueries(c.name);
      for (const q of queries) {
        if (this.cancelRequested) return;
        const items = await searchVideos(q, {
          maxResults: SEARCH_DEFAULTS.maxResultsPerQuery,
          order: SEARCH_DEFAULTS.order,
          regionCode: SEARCH_DEFAULTS.regionCode,
          relevanceLanguage: SEARCH_DEFAULTS.relevanceLanguage,
        });
        logInfo(`search per-creator "${q}" → ${items.length} items`);
        creatorTotalHits += items.length;
        for (const it of items) {
          if (!candidateIds.has(it.videoId)) {
            candidateIds.add(it.videoId);
            candidateMeta.set(it.videoId, { creatorName: c.name });
          }
        }
      }
      // Across all angles for this creator, no hits at all is a
      // strong signal of a typo / outdated handle. Loud-warn so the
      // user can spot it in the API management → 収集ログ tab and
      // fix creators.json. We don't auto-correct — the right
      // replacement is a human judgement call (especially for fluid
      // groups like neoporte).
      if (creatorTotalHits === 0) {
        logWarn(
          `creator "${c.name}" は全 ${queries.length} クエリで 0 件 — ` +
            `表記揺れ / 脱退 / 改名の可能性。creators.json を見直してください` +
            (c.group ? ` (group=${c.group})` : ''),
        );
      }
    }

    // Then broad queries for the long-tail discovery pool.
    for (const q of BROAD_QUERIES) {
      if (this.cancelRequested) return;
      const items = await searchVideos(q, {
        maxResults: SEARCH_DEFAULTS.maxResultsPerQuery,
        order: SEARCH_DEFAULTS.order,
        regionCode: SEARCH_DEFAULTS.regionCode,
        relevanceLanguage: SEARCH_DEFAULTS.relevanceLanguage,
      });
      logInfo(`search broad "${q}" → ${items.length} items`);
      for (const it of items) {
        if (!candidateIds.has(it.videoId)) {
          candidateIds.add(it.videoId);
          candidateMeta.set(it.videoId, { creatorName: null });
        }
      }
    }

    // Step 2: drop already-collected. The "is it worth re-collecting"
    // question is a separate weekly job; in the hot path we just skip.
    const newIds: string[] = [];
    for (const id of candidateIds) {
      if (!videoExists(id)) newIds.push(id);
      if (newIds.length >= MAX_VIDEOS_PER_BATCH) break;
    }
    logInfo(`candidates=${candidateIds.size}, new=${newIds.length}`);

    // Step 3: enrich via videos.list to fill in stats.
    const details = await fetchVideoDetails(newIds);
    const detailById = new Map(details.map((d) => [d.id, d]));

    // Step 4 + 5: yt-dlp per video for heatmap + chapters + thumb,
    // then DB upsert.
    let saved = 0;
    let failures = 0;
    for (const id of newIds) {
      if (this.cancelRequested) return;
      const detail = detailById.get(id);
      if (!detail) {
        // Video disappeared between search.list and videos.list
        // (deleted, region-blocked). Skip silently.
        continue;
      }
      const url = `https://www.youtube.com/watch?v=${id}`;
      const extracted = await extractVideoData({ url, withThumbnail: true });
      if (!extracted) {
        failures += 1;
        await sleep(PER_VIDEO_DELAY_MS);
        continue;
      }

      // Resolve creator: prefer the candidate-meta hint (came from per-
      // creator search); else fall back to channel_name from the API.
      const creatorHint = candidateMeta.get(id)?.creatorName;
      const creatorName = creatorHint ?? detail.channelTitle ?? extracted.meta.channel ?? null;
      const isTarget = creatorHint != null;
      const creatorId = creatorName
        ? upsertCreator(creatorName, detail.channelId || extracted.meta.channel_id || null, isTarget)
        : null;

      const durationSec =
        extracted.meta.duration ?? parseIsoDuration(detail.duration);

      const publishedAt =
        detail.publishedAt ||
        formatYtDlpUploadDate(extracted.meta.upload_date) ||
        null;

      if (extracted.peaks.length === 0 && (!extracted.meta.heatmap || extracted.meta.heatmap.length === 0)) {
        logInfo(`no heatmap available for ${id} (saving meta only)`);
      }

      try {
        upsertVideoFull({
          video: {
            id,
            creator_id: creatorId,
            title: detail.title || extracted.meta.title,
            channel_id: detail.channelId || extracted.meta.channel_id || null,
            channel_name: detail.channelTitle || extracted.meta.channel || null,
            view_count: detail.viewCount,
            like_count: detail.likeCount,
            comment_count: detail.commentCount,
            duration_sec: durationSec ?? null,
            published_at: publishedAt,
            thumbnail_path: extracted.thumbnailPath,
            url,
            description: detail.description || extracted.meta.description || null,
            raw_metadata: JSON.stringify({ api: detail, ytdlp: extracted.meta }),
          },
          peaks: extracted.peaks.map((p) => ({
            video_id: id,
            rank: p.rank,
            start_sec: p.startSec,
            end_sec: p.endSec,
            peak_value: p.peakValue,
            chapter_title: p.chapterTitle,
          })),
          chapters: extracted.chapters.map((c) => ({
            video_id: id,
            title: c.title,
            start_sec: c.start_time,
            end_sec: c.end_time,
          })),
        });
        saved += 1;
      } catch (err) {
        logError(`DB upsert failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        failures += 1;
      }

      await sleep(PER_VIDEO_DELAY_MS);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    logInfo(`batch done in ${elapsedSec}s — saved=${saved}, failures=${failures}`);

    // If we hit a hard wall (nothing saved + many failures), back off
    // longer before the next cycle.
    if (saved === 0 && failures >= 5) {
      logWarn('zero saves with failures — long cooldown');
      await sleep(NETWORK_RETRY_COOLDOWN_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// yt-dlp's upload_date is YYYYMMDD; convert to ISO 8601 date so the
// `videos.published_at` column stays in a single canonical format.
function formatYtDlpUploadDate(d: string | undefined): string | null {
  if (!d || !/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// Singleton — main process only.
export const dataCollectionManager = new DataCollectionManager();

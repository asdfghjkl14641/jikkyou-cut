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
import { BROAD_QUERIES, SEARCH_DEFAULTS, buildPerCreatorQuery } from './searchQueries';
import { loadCreatorList } from './creatorList';

// Background data-collection orchestrator. Single instance per main
// process. Auto-starts ~5 s after `start()` is called (giving the rest
// of app-ready time to settle), then runs a collect-batch every hour.
//
// Manual `triggerNow()` is exposed via IPC for the Settings UI to fire
// off-cycle batches — useful for "I just added a creator, run now"
// flows.

type ManagerState = 'idle' | 'running' | 'paused';

const COLLECTION_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour between cycles
const STARTUP_DELAY_MS = 5_000;                       // delay after start()
const MAX_VIDEOS_PER_BATCH = 200;                     // cap a single cycle
const NETWORK_RETRY_COOLDOWN_MS = 5 * 60 * 1000;      // 5 min between hard fails
const PER_VIDEO_DELAY_MS = 200;                       // gentle on yt-dlp

class DataCollectionManager {
  private state: ManagerState = 'idle';
  private currentBatch: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelRequested = false;

  /** Begin auto-collection. Returns immediately; first cycle fires after
   * STARTUP_DELAY_MS. No-op if no API keys are configured. */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    const hasKeys = await hasYoutubeApiKeys();
    if (!hasKeys) {
      console.log('[data-collection] no YouTube API keys configured — skipping auto-start');
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

  isRunning(): boolean {
    return this.state === 'running';
  }

  getStatsSnapshot(): CollectionStats & { isRunning: boolean } {
    return { ...getStats(), isRunning: this.state === 'running' };
  }

  // ---- Internals ----------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.state !== 'running') return;
    this.timer = setTimeout(() => {
      void this.runOneBatch().finally(() => {
        if (this.state === 'running') this.scheduleNext(COLLECTION_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async runOneBatch(): Promise<void> {
    if (this.currentBatch) return this.currentBatch;
    const batch = this._collectBatch().catch((err) => {
      console.warn('[data-collection] batch error:', err);
    });
    this.currentBatch = batch as Promise<void>;
    try {
      await batch;
    } finally {
      this.currentBatch = null;
    }
  }

  private async _collectBatch(): Promise<void> {
    const startedAt = Date.now();
    console.log('[data-collection] batch start');

    // Step 1: search to build a candidate ID pool.
    const candidateIds = new Set<string>();
    const candidateMeta = new Map<string, { creatorName: string | null }>();

    // Per-creator queries first — these are the targeted slice the
    // user explicitly cares about, so they get priority budget.
    const creators = await loadCreatorList();
    for (const c of creators) {
      if (this.cancelRequested) return;
      const items = await searchVideos(buildPerCreatorQuery(c.name), {
        maxResults: SEARCH_DEFAULTS.maxResultsPerQuery,
        order: SEARCH_DEFAULTS.order,
        regionCode: SEARCH_DEFAULTS.regionCode,
        relevanceLanguage: SEARCH_DEFAULTS.relevanceLanguage,
      });
      for (const it of items) {
        if (!candidateIds.has(it.videoId)) {
          candidateIds.add(it.videoId);
          candidateMeta.set(it.videoId, { creatorName: c.name });
        }
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
    console.log(
      `[data-collection] candidates=${candidateIds.size}, new=${newIds.length}`,
    );

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
        console.warn(`[data-collection] DB upsert failed for ${id}:`, err);
        failures += 1;
      }

      await sleep(PER_VIDEO_DELAY_MS);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[data-collection] batch done in ${elapsedSec}s — saved=${saved}, failures=${failures}`,
    );

    // If we hit a hard wall (nothing saved + many failures), back off
    // longer before the next cycle.
    if (saved === 0 && failures >= 5) {
      console.warn('[data-collection] zero saves with failures — long cooldown');
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

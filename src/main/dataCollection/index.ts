import {
  CollectionStats,
  bumpUploaderVideoCount,
  getCreatorIdByName,
  getStats,
  upsertUploader,
  upsertVideoFull,
  videoExists,
} from './database';
import { countYoutubeApiKeys, hasYoutubeApiKeys } from '../secureStorage';
import { getTotalQuotaUsedToday } from './database';
import { fetchVideoDetails, parseIsoDuration, refreshKeys, searchVideos } from './youtubeApi';
import { extractVideoData } from './ytDlpExtractor';
import { BROAD_QUERIES, SEARCH_DEFAULTS, buildPerCreatorQueries } from './searchQueries';
import { loadCreatorList } from './creatorList';
import { resolveCreatorChannelIds } from './seedCreators';
import { logError, logInfo, logWarn } from './logger';
import { shuffleArray } from './utils';

// Background data-collection orchestrator. Single instance per main
// process. Auto-starts ~5 s after `start()` is called (giving the rest
// of app-ready time to settle), then runs a collect-batch every hour.
//
// Manual `triggerNow()` is exposed via IPC for the Settings UI to fire
// off-cycle batches — useful for "I just added a creator, run now"
// flows.

type ManagerState = 'idle' | 'running' | 'paused';

// Cycle pacing — switched from a 2h fixed interval to dynamic on
// 2026-05-03. Rationale: the 50-key budget gives 500K units/day; the
// 2h cadence burned only ~32K (7%) leaving 92% wasted. Sleep is now
// driven by the previous batch's "new rate" (newCount / candidateCount).
// High new-rate ⇒ YouTube has fresh material ⇒ fast cadence; low
// new-rate ⇒ wait longer to let the upload pool refill. Quota
// exhaustion is acceptable (operator adds new keys when it happens).
// Initial pacing 3/10/20/30 (2026-05-03) had < 5% tier firing the
// 30-min sleep too often — operator reported "待ちすぎ". Tightened
// to 1/3/5/10 same day. Worst case 480 batch/day × ~700 units = 336K
// / 500K daily budget = 67%, still comfortable.
const SLEEP_TIERS = [
  { minRate: 0.20, sleepMs: 1 * 60_000 },
  { minRate: 0.10, sleepMs: 3 * 60_000 },
  { minRate: 0.05, sleepMs: 5 * 60_000 },
  { minRate: 0.00, sleepMs: 10 * 60_000 },
] as const;
// Fallback delay used when a batch was cancelled, errored, or returned
// zero candidates — pinned to the lowest tier so the abnormal path
// doesn't sit on a stale longer interval.
const FALLBACK_SLEEP_MS = 10 * 60_000;
const STARTUP_DELAY_MS = 5_000;                       // delay after start()
const MAX_VIDEOS_PER_BATCH = 200;                     // cap a single cycle
// Per-batch ceiling per creator. Prevents a single creator from
// monopolising the global cap when their queries return rich pools
// — pre-fix bug had 99.4% of 340 videos concentrated on the top
// 3 creators because the fixed-order loop exhausted MAX_VIDEOS_PER_BATCH
// before reaching the long tail. Combined with shuffleArray on the
// creator order, this gives every creator a fair shot per batch.
const PER_CREATOR_QUOTA_PER_BATCH = 3;
const NETWORK_RETRY_COOLDOWN_MS = 5 * 60 * 1000;      // 5 min between hard fails
const PER_VIDEO_DELAY_MS = 200;                       // gentle on yt-dlp
const QUOTA_WARN_THRESHOLD = 0.80;                    // log warning past 80% daily

type BatchResult = {
  // True when the batch exited early via cancelRequested. Partial
  // counters reflect work done up to that point.
  cancelled: boolean;
  // candidateIds.size — every distinct videoId surfaced by per-creator
  // + broad search. Used as the denominator for new-rate.
  candidateCount: number;
  // newIds.length — candidates that survived `videoExists` and made
  // it into the enrichment loop. The numerator for new-rate.
  newCount: number;
  // Successful upserts. Lower-bound on real DB growth this batch.
  savedCount: number;
  // yt-dlp / DB upsert failures during enrichment.
  failures: number;
};

function pickNextDelay(result: BatchResult): number {
  // Cancelled or empty pools: no signal to pace from, fall back to
  // the longest tier so we don't churn the quota.
  if (result.cancelled) return FALLBACK_SLEEP_MS;
  if (result.candidateCount === 0) return FALLBACK_SLEEP_MS;

  const newRate = result.newCount / result.candidateCount;
  for (const tier of SLEEP_TIERS) {
    if (newRate >= tier.minRate) return tier.sleepMs;
  }
  return SLEEP_TIERS[SLEEP_TIERS.length - 1]!.sleepMs;
}

class DataCollectionManager {
  private state: ManagerState = 'idle';
  // Held as Promise<unknown> so callers (triggerNow / cancelCurrentBatch
  // / pause) can `await` it without inheriting BatchResult — they only
  // care about completion, not the result shape.
  private currentBatch: Promise<unknown> | null = null;
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
      await this.currentBatch;
      return;
    }
    await this.runOneBatch();
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
      this.runOneBatch()
        .then((result) => {
          if (this.state !== 'running') return;
          const nextDelay = pickNextDelay(result);
          this.scheduleNext(nextDelay);
        })
        .catch((err) => {
          // runOneBatch already swallows _collectBatch errors, so this
          // .catch is defensive: any unexpected throw still lets the
          // schedule keep ticking on a long delay.
          logError(`runOneBatch unexpectedly threw: ${err instanceof Error ? err.message : String(err)}`);
          if (this.state === 'running') this.scheduleNext(FALLBACK_SLEEP_MS);
        });
    }, delayMs);
  }

  private async runOneBatch(): Promise<BatchResult> {
    if (this.currentBatch) {
      // Re-entrancy guard: another caller already started a batch.
      // Wait for it to finish and re-use its result if it was a
      // BatchResult; otherwise return a "no work done" sentinel.
      const r = await this.currentBatch;
      return isBatchResult(r) ? r : emptyResult(false);
    }
    // Fresh start — clear any cancel flag left over from a previous
    // pause / cancelCurrentBatch invocation. The batch will re-set the
    // flag while running if pause / cancel fires mid-batch.
    this.cancelRequested = false;
    const promise = this._collectBatch().catch((err): BatchResult => {
      logError(`batch error: ${err instanceof Error ? err.message : String(err)}`);
      return emptyResult(false);
    });
    this.currentBatch = promise;
    try {
      const result = await promise;
      if (this.cancelRequested) {
        logInfo('batch ended — cancelled by user / pause');
      }
      // Quota check on completion. Logged regardless of cancel state
      // because partial batches still consume API units.
      await this.maybeWarnOnQuota();
      // Operator-facing summary line. The new-rate + sleep are the
      // signal we use to debug pacing decisions later.
      const nextDelay = pickNextDelay(result);
      const newRate = result.candidateCount > 0 ? result.newCount / result.candidateCount : 0;
      logInfo(
        `batch summary — new rate ${(newRate * 100).toFixed(1)}% ` +
          `(${result.newCount}/${result.candidateCount}), ` +
          `saved=${result.savedCount}, failures=${result.failures}, ` +
          `sleeping ${Math.round(nextDelay / 60_000)}min`,
      );
      return result;
    } finally {
      this.currentBatch = null;
    }
  }

  /** Log a warning when daily quota usage crosses QUOTA_WARN_THRESHOLD.
   * No UI notification — operator can spot it in the log viewer.
   * Caps total at keyCount × 10000 (= the daily limit per key). */
  private async maybeWarnOnQuota(): Promise<void> {
    try {
      const keyCount = await countYoutubeApiKeys();
      if (keyCount === 0) return;
      const used = getTotalQuotaUsedToday();
      const limit = keyCount * 10000;
      const ratio = used / limit;
      if (ratio >= QUOTA_WARN_THRESHOLD) {
        logInfo(
          `⚠ quota at ${(ratio * 100).toFixed(0)}% (${used}/${limit}) — ` +
            `consider adding new API keys`,
        );
      }
    } catch {
      // Best-effort; key-count read failure shouldn't break the loop.
    }
  }

  private async _collectBatch(): Promise<BatchResult> {
    const startedAt = Date.now();
    logInfo('batch start');

    // Counters threaded through the function so early-return paths
    // (cancelRequested checkpoints) can build a partial BatchResult
    // reflecting the work already done. `buildResult` closes over
    // candidateIds / newIds / saved / failures declared below.
    const candidateIds = new Set<string>();
    const candidateMeta = new Map<string, { creatorName: string | null }>();
    const newIds: string[] = [];
    let saved = 0;
    let failures = 0;
    const buildResult = (cancelled: boolean): BatchResult => ({
      cancelled,
      candidateCount: candidateIds.size,
      newCount: newIds.length,
      savedCount: saved,
      failures,
    });

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
    // (candidateIds / candidateMeta declared above so buildResult can
    // observe their sizes from any early-return path.)

    // Per-creator queries first — these are the targeted slice the
    // user explicitly cares about, so they get priority budget.
    // Three angles per creator (切り抜き / 神回 / 名場面) — see
    // searchQueries.buildPerCreatorQueries for rationale.
    //
    // Order is shuffled per batch and each creator is capped at
    // PER_CREATOR_QUOTA_PER_BATCH. Pre-fix the fixed order + no quota
    // meant the first ~3 creators consumed the entire MAX_VIDEOS_PER_BATCH
    // budget, leaving 95% of the seed list at zero. Round-robin via
    // quota guarantees fair distribution across batches.
    const creators = await loadCreatorList();
    const shuffledCreators = shuffleArray(creators);
    const sampleNames = shuffledCreators
      .slice(0, 5)
      .map((c) => c.name)
      .join(', ');
    logInfo(`per-creator order (shuffled): ${sampleNames}, ...`);

    const perCreatorCount = new Map<string, number>();
    for (const c of shuffledCreators) perCreatorCount.set(c.name, 0);

    outer: for (const c of shuffledCreators) {
      if (this.cancelRequested) return buildResult(true);
      if (candidateIds.size >= MAX_VIDEOS_PER_BATCH) break;

      const queries = buildPerCreatorQueries(c.name);
      // Track API hits separately from slot fills: dedup against the
      // running candidate pool can legitimately drop a creator's slots
      // to 0 even when the API returned items, so only "all queries
      // ran AND zero items came back" is a typo signal.
      let queriesRun = 0;
      let totalApiHits = 0;

      for (const q of queries) {
        if (this.cancelRequested) return buildResult(true);
        if ((perCreatorCount.get(c.name) ?? 0) >= PER_CREATOR_QUOTA_PER_BATCH) break;
        if (candidateIds.size >= MAX_VIDEOS_PER_BATCH) break outer;

        const items = await searchVideos(q, {
          maxResults: SEARCH_DEFAULTS.maxResultsPerQuery,
          order: SEARCH_DEFAULTS.order,
          regionCode: SEARCH_DEFAULTS.regionCode,
          relevanceLanguage: SEARCH_DEFAULTS.relevanceLanguage,
        });
        queriesRun += 1;
        totalApiHits += items.length;
        logInfo(`search per-creator "${q}" → ${items.length} items`);

        for (const it of items) {
          if ((perCreatorCount.get(c.name) ?? 0) >= PER_CREATOR_QUOTA_PER_BATCH) break;
          if (candidateIds.size >= MAX_VIDEOS_PER_BATCH) break outer;

          if (!candidateIds.has(it.videoId)) {
            candidateIds.add(it.videoId);
            candidateMeta.set(it.videoId, { creatorName: c.name });
            perCreatorCount.set(c.name, (perCreatorCount.get(c.name) ?? 0) + 1);
          }
        }
      }

      // Across all angles for this creator, no hits at all is a
      // strong signal of a typo / outdated handle. Loud-warn so the
      // user can spot it in the API management → 収集ログ tab and
      // fix creators.json. We don't auto-correct — the right
      // replacement is a human judgement call (especially for fluid
      // groups like neoporte). Skip the warning when we exited early
      // (quota / global cap) — that's not a typo signal.
      if (queriesRun === queries.length && totalApiHits === 0) {
        logWarn(
          `creator "${c.name}" は全 ${queries.length} クエリで 0 件 — ` +
            `表記揺れ / 脱退 / 改名の可能性。creators.json を見直してください` +
            (c.group ? ` (group=${c.group})` : ''),
        );
      }
    }

    // Distribution summary — the whole point of the round-robin
    // rewrite. If "withZero" stays high across batches, bump
    // PER_CREATOR_QUOTA_PER_BATCH or revisit the queries.
    const counts = Array.from(perCreatorCount.values());
    const withVideos = counts.filter((n) => n >= 1).length;
    const withZero = counts.filter((n) => n === 0).length;
    const maxPerCreator = counts.length > 0 ? Math.max(...counts) : 0;
    logInfo(
      `per-creator distribution: with≥1=${withVideos}, with=0=${withZero}, ` +
        `max=${maxPerCreator}/${PER_CREATOR_QUOTA_PER_BATCH}`,
    );

    // Then broad queries for the long-tail discovery pool.
    for (const q of BROAD_QUERIES) {
      if (this.cancelRequested) return buildResult(true);
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
    // (newIds is hoisted to the top of the function so buildResult can
    // observe partial progress on cancel.)
    for (const id of candidateIds) {
      if (!videoExists(id)) newIds.push(id);
      if (newIds.length >= MAX_VIDEOS_PER_BATCH) break;
    }
    logInfo(`candidates=${candidateIds.size}, new=${newIds.length}`);

    // Step 3: enrich via videos.list to fill in stats.
    const details = await fetchVideoDetails(newIds);
    const detailById = new Map(details.map((d) => [d.id, d]));

    // Step 4 + 5: yt-dlp per video for heatmap + chapters + thumb,
    // then DB upsert. (saved / failures hoisted to top.)
    for (const id of newIds) {
      if (this.cancelRequested) return buildResult(true);
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

      // Resolve creator (= seed streamer being targeted) — only set
      // when this video came from a per-creator search. Broad-search
      // hits leave creator_id NULL because we don't know which seed
      // streamer the clip is "about".
      const creatorHint = candidateMeta.get(id)?.creatorName;
      const creatorId = creatorHint ? getCreatorIdByName(creatorHint) : null;

      // Resolve uploader (= the channel that posted this clip) — set
      // for every video we save, regardless of search origin. This
      // replaces the old auto-add-to-creators path that polluted the
      // creators table with clip uploaders.
      const uploaderName = detail.channelTitle || extracted.meta.channel || null;
      const uploaderChannelId = detail.channelId || extracted.meta.channel_id || null;
      const uploaderId = uploaderName
        ? upsertUploader(uploaderChannelId, uploaderName)
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
            uploader_id: uploaderId,
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
        if (uploaderId != null) bumpUploaderVideoCount(uploaderId);
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
    // longer before the next cycle. The dynamic-cycle delay tier picks
    // up from here, but this extra in-band sleep prevents tight retry
    // when the network / yt-dlp itself is broken.
    if (saved === 0 && failures >= 5) {
      logWarn('zero saves with failures — long cooldown');
      await sleep(NETWORK_RETRY_COOLDOWN_MS);
    }

    return buildResult(false);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyResult(cancelled: boolean): BatchResult {
  return { cancelled, candidateCount: 0, newCount: 0, savedCount: 0, failures: 0 };
}

function isBatchResult(v: unknown): v is BatchResult {
  return (
    v != null &&
    typeof v === 'object' &&
    'cancelled' in v &&
    'candidateCount' in v &&
    'newCount' in v &&
    'savedCount' in v &&
    'failures' in v
  );
}

// yt-dlp's upload_date is YYYYMMDD; convert to ISO 8601 date so the
// `videos.published_at` column stays in a single canonical format.
function formatYtDlpUploadDate(d: string | undefined): string | null {
  if (!d || !/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// Singleton — main process only.
export const dataCollectionManager = new DataCollectionManager();

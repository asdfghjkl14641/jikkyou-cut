import type { RawBucket, ScoreSample } from '../../../common/types';
import type { ReactionCategory } from '../../../common/commentAnalysis/keywords';

// Weights for the 5-component composite. Values come from the project
// design doc (rolling-window section). The "without viewers" set
// reabsorbs retention's share into density and keyword so the no-data
// case still produces a usable composite.
const WEIGHTS_WITH_VIEWERS = {
  density: 0.35,
  keyword: 0.20,
  continuity: 0.20,
  peak: 0.10,
  retention: 0.15,
} as const;

const WEIGHTS_WITHOUT_VIEWERS = {
  density: 0.45,
  keyword: 0.25,
  continuity: 0.20,
  peak: 0.10,
  retention: 0.00,
} as const;

const CATEGORIES: readonly ReactionCategory[] = [
  'laugh',
  'surprise',
  'emotion',
  'praise',
  'other',
] as const;

const ZERO_CATEGORY_HITS = (): Record<ReactionCategory, number> => ({
  laugh: 0,
  surprise: 0,
  emotion: 0,
  praise: 0,
  other: 0,
});

// Median of an array of non-negative numbers. Mutates a copy, not the
// caller's array. Used as the threshold for the continuity component:
// "fraction of buckets in W where commentCount >= median".
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Compute one ScoreSample per bucket-start position. The window slides
 * bucket-by-bucket: sample i covers buckets[i..i+W).
 *
 * Cost is O(buckets * bucketsPerWindow). For a 1-hour video at 5-second
 * buckets and W=2min that's 720 * 24 = 17280 ops — sub-millisecond. We
 * deliberately don't bother with a deque-based incremental algorithm: the
 * naive form is already fast enough for the slider to feel instant, and
 * the code stays readable.
 */
export function computeRollingScores(
  buckets: RawBucket[],
  windowSec: number,
  bucketSizeSec: number,
  hasViewerStats: boolean,
): ScoreSample[] {
  if (buckets.length === 0 || windowSec <= 0 || bucketSizeSec <= 0) return [];
  const bucketsPerWindow = Math.max(1, Math.round(windowSec / bucketSizeSec));
  if (bucketsPerWindow > buckets.length) return [];

  const w = hasViewerStats ? WEIGHTS_WITH_VIEWERS : WEIGHTS_WITHOUT_VIEWERS;

  // Global metrics needed for the per-window components.
  let maxCommentBucket = 0;
  for (const b of buckets) {
    if (b.commentCount > maxCommentBucket) maxCommentBucket = b.commentCount;
  }
  const med = median(buckets.map((b) => b.commentCount));

  // Pass 1: compute window-local raw aggregates. We hold the un-normalised
  // density/keyword averages here so we can normalise by the global
  // window-average max in pass 2.
  type Raw = {
    timeSec: number;
    avgComment: number;
    avgKeyword: number;
    continuity: number;
    peak: number;
    retention: number;
    categoryHits: Record<ReactionCategory, number>;
    messageCount: number;
  };

  const raws: Raw[] = [];
  let maxAvgComment = 0;
  let maxAvgKeyword = 0;

  const lastStart = buckets.length - bucketsPerWindow;
  for (let i = 0; i <= lastStart; i += 1) {
    let sumComment = 0;
    let sumKeyword = 0;
    let peakComment = 0;
    let aboveMedian = 0;
    let viewerMin = Number.POSITIVE_INFINITY;
    let viewerMax = Number.NEGATIVE_INFINITY;
    let viewerSampleCount = 0;
    const cat = ZERO_CATEGORY_HITS();

    for (let j = 0; j < bucketsPerWindow; j += 1) {
      const b = buckets[i + j]!;
      sumComment += b.commentCount;
      sumKeyword += b.keywordHits;
      if (b.commentCount > peakComment) peakComment = b.commentCount;
      // continuity uses ">=" so a video where every bucket equals the
      // median still scores 1.0. Guard against med=0 to avoid the
      // degenerate "everything counts" case for low-comment videos.
      if (med > 0 && b.commentCount >= med) aboveMedian += 1;
      if (b.viewerCount != null) {
        if (b.viewerCount < viewerMin) viewerMin = b.viewerCount;
        if (b.viewerCount > viewerMax) viewerMax = b.viewerCount;
        viewerSampleCount += 1;
      }
      for (const c of CATEGORIES) {
        cat[c] += b.categoryHits[c];
      }
    }

    const W = bucketsPerWindow;
    const avgComment = sumComment / W;
    const avgKeyword = sumKeyword / W;
    if (avgComment > maxAvgComment) maxAvgComment = avgComment;
    if (avgKeyword > maxAvgKeyword) maxAvgKeyword = avgKeyword;

    const continuity = med > 0 ? aboveMedian / W : 0;
    const peak = maxCommentBucket > 0 ? peakComment / maxCommentBucket : 0;
    // 0.5 fallback when the window contains no viewer samples — neither
    // penalises nor rewards. Picking 0 would crater the composite for
    // any window that happens to fall in a sample-sparse stretch.
    let retention = 0.5;
    if (viewerSampleCount >= 1 && viewerMax > 0) {
      retention = viewerMin / viewerMax;
    }

    raws.push({
      timeSec: buckets[i]!.timeSec,
      avgComment,
      avgKeyword,
      continuity,
      peak,
      retention,
      categoryHits: cat,
      messageCount: sumComment,
    });
  }

  // Pass 2: normalise density/keyword by the global window-average max
  // and assemble final ScoreSamples.
  const samples: ScoreSample[] = raws.map((r) => {
    const density = maxAvgComment > 0 ? r.avgComment / maxAvgComment : 0;
    const keyword = maxAvgKeyword > 0 ? r.avgKeyword / maxAvgKeyword : 0;
    const total =
      density * w.density +
      keyword * w.keyword +
      r.continuity * w.continuity +
      r.peak * w.peak +
      r.retention * w.retention;

    let dominantCategory: ReactionCategory | null = null;
    let maxHit = 0;
    for (const c of CATEGORIES) {
      if (r.categoryHits[c] > maxHit) {
        maxHit = r.categoryHits[c];
        dominantCategory = c;
      }
    }
    if (maxHit === 0) dominantCategory = null;

    return {
      timeSec: r.timeSec,
      windowSec,
      density,
      keyword,
      continuity: r.continuity,
      peak: r.peak,
      retention: r.retention,
      total: Math.min(1, total),
      dominantCategory,
      categoryHits: r.categoryHits,
      messageCount: r.messageCount,
    };
  });

  return samples;
}

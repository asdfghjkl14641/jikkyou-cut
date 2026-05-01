import type {
  ChatMessage,
  CommentAnalysis,
  ScoreSample,
  ViewerStats,
} from '../../common/types';
import { countKeywordHits } from '../../common/commentAnalysis/keywords';

const BUCKET_SIZE_SEC = 5;

// Weight tables. The scoring switches between them based on whether
// playboard returned anything — without viewer data we re-distribute the
// missing weight across the remaining two signals (density gets the
// lion's share since it correlates strongest with "盛り上がり" by hand-
// inspected examples).
const WEIGHTS = {
  withViewerStats: { density: 0.5, viewer: 0.3, keyword: 0.2 },
  withoutViewerStats: { density: 0.7, viewer: 0.0, keyword: 0.3 },
} as const;

type RawBucket = {
  timeSec: number;
  commentCount: number;
  keywordHitCount: number;
  viewerCount: number;
};

function buildBuckets(args: {
  messages: ChatMessage[];
  viewers: ViewerStats;
  durationSec: number;
}): RawBucket[] {
  const { messages, viewers, durationSec } = args;
  if (durationSec <= 0) return [];

  const bucketCount = Math.max(1, Math.floor(durationSec / BUCKET_SIZE_SEC));
  const buckets: RawBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push({
      timeSec: i * BUCKET_SIZE_SEC,
      commentCount: 0,
      keywordHitCount: 0,
      viewerCount: 0,
    });
  }

  // Comments + keyword hits.
  for (const msg of messages) {
    if (msg.timeSec < 0 || msg.timeSec >= durationSec) continue;
    const idx = Math.min(bucketCount - 1, Math.floor(msg.timeSec / BUCKET_SIZE_SEC));
    const b = buckets[idx];
    if (!b) continue;
    b.commentCount += 1;
    b.keywordHitCount += countKeywordHits(msg.text);
  }

  // Viewer count: nearest sample in the source-of-truth `samples[]` for
  // each bucket's centre time. samples may be sparse (a few hundred
  // points over a 4-hour stream) — interpolate by nearest neighbour.
  if (viewers.source === 'playboard' && viewers.samples.length > 0) {
    const sorted = [...viewers.samples].sort((a, b) => a.timeSec - b.timeSec);
    let cursor = 0;
    for (const b of buckets) {
      const centre = b.timeSec + BUCKET_SIZE_SEC / 2;
      // Advance cursor while the next sample is still <= centre.
      while (
        cursor < sorted.length - 1 &&
        sorted[cursor + 1]!.timeSec <= centre
      ) {
        cursor += 1;
      }
      // Pick whichever of cursor / cursor+1 is closer.
      const here = sorted[cursor]!;
      const next = sorted[cursor + 1];
      if (next && Math.abs(next.timeSec - centre) < Math.abs(here.timeSec - centre)) {
        b.viewerCount = next.count;
      } else {
        b.viewerCount = here.count;
      }
    }
  }

  return buckets;
}

function normalise(values: number[]): number[] {
  if (values.length === 0) return [];
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => Math.min(1, v / max));
}

/**
 * Combines chat messages + viewer stats into per-bucket score samples.
 * The output shape matches what `CommentAnalysisGraph.tsx` expects
 * (`CommentAnalysis`).
 *
 * Normalisation:
 *  - commentDensity = bucket.commentCount / max(commentCount)
 *  - keywordHits     = bucket.keywordHits  / max(keywordHits)
 *  - viewerGrowth    = max(0, bucket.viewerCount - prev.viewerCount) / maxGrowth
 *
 * Total score is the weighted sum; weight table changes when viewer
 * stats are unavailable so the bar still spans the full 0..1 range.
 */
export function calculateScores(args: {
  messages: ChatMessage[];
  viewers: ViewerStats;
  durationSec: number;
}): CommentAnalysis {
  const buckets = buildBuckets(args);
  const hasViewer =
    args.viewers.source === 'playboard' && args.viewers.samples.length > 0;
  const w = hasViewer ? WEIGHTS.withViewerStats : WEIGHTS.withoutViewerStats;

  const commentDensity = normalise(buckets.map((b) => b.commentCount));
  const keywordHitsNorm = normalise(buckets.map((b) => b.keywordHitCount));

  // Viewer growth = positive delta from previous bucket (so a steady-
  // state high-viewer count doesn't produce a high "growth" signal).
  const growthRaw: number[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const prev = i > 0 ? buckets[i - 1]!.viewerCount : buckets[i]!.viewerCount;
    growthRaw.push(Math.max(0, buckets[i]!.viewerCount - prev));
  }
  const viewerGrowth = hasViewer ? normalise(growthRaw) : growthRaw.map(() => 0);

  const samples: ScoreSample[] = buckets.map((b, i) => {
    const cd = commentDensity[i] ?? 0;
    const vg = viewerGrowth[i] ?? 0;
    const kh = keywordHitsNorm[i] ?? 0;
    const total = cd * w.density + vg * w.viewer + kh * w.keyword;
    return {
      timeSec: b.timeSec,
      commentDensity: cd,
      viewerGrowth: vg,
      keywordHits: kh,
      total: Math.min(1, total),
    };
  });

  return {
    videoDurationSec: args.durationSec,
    bucketSizeSec: BUCKET_SIZE_SEC,
    samples,
    hasViewerStats: hasViewer,
    chatMessageCount: args.messages.length,
    generatedAt: new Date().toISOString(),
  };
}

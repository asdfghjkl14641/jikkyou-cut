import type {
  ChatMessage,
  CommentAnalysis,
  RawBucket,
  ViewerStats,
} from '../../common/types';
import {
  countKeywordHitsByCategory,
  type ReactionCategory,
} from '../../common/commentAnalysis/keywords';

export const BUCKET_SIZE_SEC = 5;

const ZERO_CATEGORY_HITS = (): Record<ReactionCategory, number> => ({
  laugh: 0,
  surprise: 0,
  emotion: 0,
  praise: 0,
  death: 0,
  victory: 0,
  scream: 0,
  flag: 0,
  other: 0,
});

// Stage 1: per-bucket raw aggregation. Independent of W — this runs once
// per analysis (in main, before IPC). The renderer slides a window over
// these to produce ScoreSample[] for whatever W the user picks.
export function bucketize(args: {
  messages: ChatMessage[];
  viewers: ViewerStats;
  durationSec: number;
}): RawBucket[] {
  const { messages, viewers, durationSec } = args;
  if (durationSec <= 0) return [];

  const hasViewer = viewers.source === 'playboard' && viewers.samples.length > 0;
  const bucketCount = Math.max(1, Math.floor(durationSec / BUCKET_SIZE_SEC));

  const buckets: RawBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push({
      timeSec: i * BUCKET_SIZE_SEC,
      commentCount: 0,
      keywordHits: 0,
      categoryHits: ZERO_CATEGORY_HITS(),
      messages: [],
      // null when no playboard data; filled in by the interpolation
      // pass below otherwise. Distinguishes "we don't know" from
      // "zero viewers" — the former defaults retention to 0.5, the
      // latter would (incorrectly) crash retention to 0.
      viewerCount: null,
    });
  }

  // Comments + keyword hits + categorisation, single pass.
  for (const msg of messages) {
    if (msg.timeSec < 0 || msg.timeSec >= durationSec) continue;
    const idx = Math.min(bucketCount - 1, Math.floor(msg.timeSec / BUCKET_SIZE_SEC));
    const b = buckets[idx];
    if (!b) continue;

    b.commentCount += 1;
    b.messages.push(msg);

    const hits = countKeywordHitsByCategory(msg.text);
    let total = 0;
    for (const cat of Object.keys(hits) as ReactionCategory[]) {
      const v = hits[cat];
      b.categoryHits[cat] += v;
      total += v;
    }
    b.keywordHits += total;
  }

  // Viewer interpolation — only when playboard succeeded. Sparse samples
  // (a few hundred over a 4 hour stream) get nearest-neighbour mapped to
  // each bucket's centre. The advancing cursor keeps this O(buckets +
  // samples) rather than O(buckets * samples).
  if (hasViewer) {
    const sorted = [...viewers.samples].sort((a, b) => a.timeSec - b.timeSec);
    let cursor = 0;
    for (const b of buckets) {
      const centre = b.timeSec + BUCKET_SIZE_SEC / 2;
      while (
        cursor < sorted.length - 1 &&
        sorted[cursor + 1]!.timeSec <= centre
      ) {
        cursor += 1;
      }
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

// Top-level entry called by the orchestrator. Returns Stage 1 results +
// metadata; rolling-window scoring runs in the renderer.
export function analyze(args: {
  messages: ChatMessage[];
  viewers: ViewerStats;
  durationSec: number;
}): CommentAnalysis {
  const buckets = bucketize(args);
  const hasViewerStats =
    args.viewers.source === 'playboard' && args.viewers.samples.length > 0;
  return {
    videoDurationSec: args.durationSec,
    bucketSizeSec: BUCKET_SIZE_SEC,
    buckets,
    hasViewerStats,
    chatMessageCount: args.messages.length,
    generatedAt: new Date().toISOString(),
  };
}

import type {
  ChatMessage,
  RawBucket,
} from '../../common/types';
import type { ReactionCategory } from '../../common/commentAnalysis/keywords';

// Candidate peak found by Stage 1. Same shape concerns as the renderer's
// `ScoreSample` plus the pre-aggregated `messages` for that window —
// Stage 2 (AI refine) needs the chat content to pick the most
// "story-shaped" subset.
export type PeakCandidate = {
  startSec: number;
  endSec: number;
  totalScore: number;
  density: number;
  keyword: number;
  continuity: number;
  peak: number;
  retention: number;
  dominantCategory: ReactionCategory | null;
  messages: ChatMessage[];
};

// Same weight pairs as `src/renderer/src/lib/rollingScore.ts`. Kept
// duplicated rather than extracted to common/ — the renderer's version
// produces a UI-shaped ScoreSample[] and the math here is a private
// "score this window" function tailored for peak detection. If the
// weights ever drift, remember to update both files.
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
  'death',
  'victory',
  'scream',
  'flag',
  'other',
] as const;

// Filter knobs. Mirrors the spec's "候補フィルタ" section.
const MIN_TOTAL_SCORE = 0.30;
const EDGE_BUFFER_SEC = 30;
// Stage 2 receives at most this many candidates. Bigger pool = more
// context for the AI to pick from, but linearly more prompt tokens.
const TOP_N = 10;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

type WindowStats = {
  startSec: number;
  totalScore: number;
  density: number;
  keyword: number;
  continuity: number;
  peakFrac: number;
  retention: number;
  dominantCategory: ReactionCategory | null;
  messageCount: number;
  messages: ChatMessage[];
};

// Computes the rolling-window scores AND keeps the per-window message
// list so we don't have to re-walk buckets to build PeakCandidate.
// The math matches the renderer's computeRollingScores — see commentary
// at the top of the file.
function computeWindowStats(
  buckets: RawBucket[],
  bucketsPerWindow: number,
  hasViewerStats: boolean,
): WindowStats[] {
  if (buckets.length === 0 || bucketsPerWindow > buckets.length) return [];

  const w = hasViewerStats ? WEIGHTS_WITH_VIEWERS : WEIGHTS_WITHOUT_VIEWERS;

  let maxCommentBucket = 0;
  for (const b of buckets) {
    if (b.commentCount > maxCommentBucket) maxCommentBucket = b.commentCount;
  }
  const med = median(buckets.map((b) => b.commentCount));

  type Raw = {
    startSec: number;
    avgComment: number;
    avgKeyword: number;
    continuity: number;
    peakFrac: number;
    retention: number;
    catHits: Record<ReactionCategory, number>;
    messageCount: number;
    messages: ChatMessage[];
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
    const cat: Record<ReactionCategory, number> = {
      laugh: 0, surprise: 0, emotion: 0, praise: 0,
      death: 0, victory: 0, scream: 0, flag: 0, other: 0,
    };
    const winMessages: ChatMessage[] = [];

    for (let j = 0; j < bucketsPerWindow; j += 1) {
      const b = buckets[i + j]!;
      sumComment += b.commentCount;
      sumKeyword += b.keywordHits;
      if (b.commentCount > peakComment) peakComment = b.commentCount;
      if (med > 0 && b.commentCount >= med) aboveMedian += 1;
      if (b.viewerCount != null) {
        if (b.viewerCount < viewerMin) viewerMin = b.viewerCount;
        if (b.viewerCount > viewerMax) viewerMax = b.viewerCount;
        viewerSampleCount += 1;
      }
      for (const c of CATEGORIES) cat[c] += b.categoryHits[c];
      for (const m of b.messages) winMessages.push(m);
    }

    const W = bucketsPerWindow;
    const avgComment = sumComment / W;
    const avgKeyword = sumKeyword / W;
    if (avgComment > maxAvgComment) maxAvgComment = avgComment;
    if (avgKeyword > maxAvgKeyword) maxAvgKeyword = avgKeyword;

    const continuity = med > 0 ? aboveMedian / W : 0;
    const peakFrac = maxCommentBucket > 0 ? peakComment / maxCommentBucket : 0;
    const retention = viewerSampleCount >= 1 && viewerMax > 0 ? viewerMin / viewerMax : 0.5;

    raws.push({
      startSec: buckets[i]!.timeSec,
      avgComment, avgKeyword, continuity, peakFrac, retention,
      catHits: cat,
      messageCount: sumComment,
      messages: winMessages,
    });
  }

  return raws.map((r) => {
    const density = maxAvgComment > 0 ? r.avgComment / maxAvgComment : 0;
    const keyword = maxAvgKeyword > 0 ? r.avgKeyword / maxAvgKeyword : 0;
    const total =
      density * w.density +
      keyword * w.keyword +
      r.continuity * w.continuity +
      r.peakFrac * w.peak +
      r.retention * w.retention;

    let dominantCategory: ReactionCategory | null = null;
    let maxHit = 0;
    for (const c of CATEGORIES) {
      if (r.catHits[c] > maxHit) {
        maxHit = r.catHits[c];
        dominantCategory = c;
      }
    }
    if (maxHit === 0) dominantCategory = null;

    return {
      startSec: r.startSec,
      totalScore: Math.min(1, total),
      density,
      keyword,
      continuity: r.continuity,
      peakFrac: r.peakFrac,
      retention: r.retention,
      dominantCategory,
      messageCount: r.messageCount,
      messages: r.messages,
    };
  });
}

// Stage 1: find peak candidates worth handing to the AI.
//
//   1. compute rolling scores at every window-start
//   2. find local maxima within ±W/2
//   3. filter: score >= 0.30, avoid ±30s edge buffer
//   4. sort by score desc, greedy non-overlap (≥ W spacing)
//   5. return up to TOP_N
export function detectPeakCandidates(
  buckets: RawBucket[],
  windowSec: number,
  hasViewerStats: boolean,
  videoDurationSec: number,
  bucketSizeSec: number,
): PeakCandidate[] {
  if (buckets.length === 0 || windowSec <= 0 || bucketSizeSec <= 0) return [];
  const bucketsPerWindow = Math.max(1, Math.round(windowSec / bucketSizeSec));
  const stats = computeWindowStats(buckets, bucketsPerWindow, hasViewerStats);
  if (stats.length === 0) return [];

  const halfWindowBuckets = Math.max(1, Math.floor(bucketsPerWindow / 2));

  // Local maxima within ±halfWindowBuckets. Strict-greater on the left,
  // greater-or-equal on the right is the standard tie-breaking rule that
  // picks the leftmost of a flat-top run — keeps the result deterministic
  // when scores tie.
  const localMaxima: WindowStats[] = [];
  for (let i = 0; i < stats.length; i += 1) {
    const here = stats[i]!.totalScore;
    let isMax = true;
    for (let d = 1; d <= halfWindowBuckets; d += 1) {
      if (i - d >= 0 && stats[i - d]!.totalScore > here) { isMax = false; break; }
      if (i + d < stats.length && stats[i + d]!.totalScore >= here && stats[i + d]!.totalScore > stats[i]!.totalScore) {
        // (only fail when a strictly higher neighbour exists on the right)
        isMax = false; break;
      }
    }
    if (isMax) localMaxima.push(stats[i]!);
  }

  // Filter: score floor + edge buffer.
  const filtered = localMaxima.filter((s) => {
    if (s.totalScore < MIN_TOTAL_SCORE) return false;
    const endSec = s.startSec + windowSec;
    if (s.startSec < EDGE_BUFFER_SEC) return false;
    if (endSec > videoDurationSec - EDGE_BUFFER_SEC) return false;
    return true;
  });

  // Sort by score desc, then greedy non-overlap with already-picked.
  // "Overlap" here means the new candidate's window starts within W of
  // an already-taken one.
  filtered.sort((a, b) => b.totalScore - a.totalScore);
  const picked: WindowStats[] = [];
  for (const s of filtered) {
    if (picked.length >= TOP_N) break;
    const overlaps = picked.some((p) => Math.abs(p.startSec - s.startSec) < windowSec);
    if (overlaps) continue;
    picked.push(s);
  }

  // Re-sort picked by time so downstream stages get them in chronological
  // order — the AI prompt reads better that way and the user's resulting
  // segments are listed in time order in the UI.
  picked.sort((a, b) => a.startSec - b.startSec);

  return picked.map((s) => ({
    startSec: s.startSec,
    endSec: s.startSec + windowSec,
    totalScore: s.totalScore,
    density: s.density,
    keyword: s.keyword,
    continuity: s.continuity,
    peak: s.peakFrac,
    retention: s.retention,
    dominantCategory: s.dominantCategory,
    messages: s.messages,
  }));
}

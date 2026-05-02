import type { CommentAnalysis, RawBucket } from '../../../common/types';
import type { ReactionCategory } from '../../../common/commentAnalysis/keywords';

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

// Synthesises a `CommentAnalysis` with three gaussian comment-density
// peaks. Used as the fallback shape while the real analysis is loading
// or when the source is a local file (no chat replay available). The
// graph component still computes rolling scores from these buckets so
// the W slider remains interactive in mock mode.
export const generateMockAnalysis = (
  durationSec: number,
  bucketSizeSec = 5,
): CommentAnalysis => {
  if (durationSec <= 0) {
    return {
      videoDurationSec: 0,
      bucketSizeSec,
      buckets: [],
      hasViewerStats: false,
      chatMessageCount: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const bucketCount = Math.floor(durationSec / bucketSizeSec);
  const buckets: RawBucket[] = [];

  const peak = (x: number, pos: number, width: number, height: number) =>
    height * Math.exp(-Math.pow(x - pos, 2) / (2 * Math.pow(width, 2)));

  // Peaks scaled so the same shape is recognisable for any durationSec.
  // Three peaks at roughly 1/6, 5/12, 7/9 of the timeline.
  const scale = durationSec / 3600;

  for (let i = 0; i < bucketCount; i += 1) {
    const t = i * bucketSizeSec;
    const intensity =
      peak(t, 600 * scale, 100 * scale, 0.8) +
      peak(t, 1500 * scale, 150 * scale, 0.9) +
      peak(t, 2800 * scale, 120 * scale, 0.7);

    // commentCount per bucket — peak intensity is 0..1 in the original
    // mock, here scaled to a count so the rolling-window stage has
    // something to average. The +noise keeps the curve from looking
    // synthetic.
    const noisy = Math.max(0, intensity + (Math.random() - 0.5) * 0.1);
    const commentCount = Math.round(noisy * 50);
    const keywordHits = Math.round(commentCount * 0.3);

    const cat = ZERO_CATEGORY_HITS();
    cat.laugh = Math.round(keywordHits * 0.6);
    cat.praise = keywordHits - cat.laugh;

    buckets.push({
      timeSec: t,
      commentCount,
      keywordHits,
      categoryHits: cat,
      messages: [],
      viewerCount: null,
    });
  }

  return {
    videoDurationSec: durationSec,
    bucketSizeSec,
    buckets,
    hasViewerStats: false,
    chatMessageCount: 0,
    generatedAt: new Date().toISOString(),
  };
};

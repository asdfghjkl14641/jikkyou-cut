import type { CommentAnalysis, ScoreSample } from './CommentAnalysisGraph';

export const generateMockAnalysis = (durationSec: number = 3600, bucketSizeSec: number = 5): CommentAnalysis => {
  const sampleCount = Math.floor(durationSec / bucketSizeSec);
  const samples: ScoreSample[] = [];

  // 合成の重み
  const weights = {
    commentDensity: 0.5,
    viewerGrowth: 0.3,
    keywordHits: 0.2,
  };

  // 山を作るためのユーティリティ
  const createPeak = (x: number, pos: number, width: number, height: number) => {
    return height * Math.exp(-Math.pow(x - pos, 2) / (2 * Math.pow(width, 2)));
  };

  for (let i = 0; i < sampleCount; i++) {
    const timeSec = i * bucketSizeSec;
    const x = timeSec;

    // 複数の山を要素ごとに配置
    // コメント密度の山
    let commentDensity = 
      createPeak(x, 600, 100, 0.8) + 
      createPeak(x, 1500, 150, 0.9) + 
      createPeak(x, 2800, 120, 0.7);
    
    // 視聴者増加の山 (少しずらしたり重なったり)
    let viewerGrowth = 
      createPeak(x, 650, 80, 0.6) + 
      createPeak(x, 1550, 100, 0.8) + 
      createPeak(x, 2200, 200, 0.5);

    // キーワードヒットの山 (局所的に強い)
    let keywordHits = 
      createPeak(x, 580, 40, 0.9) + 
      createPeak(x, 1520, 50, 1.0) + 
      createPeak(x, 3100, 60, 0.8);

    // ノイズを少し混ぜる
    commentDensity = Math.min(1, Math.max(0, commentDensity + Math.random() * 0.05));
    viewerGrowth = Math.min(1, Math.max(0, viewerGrowth + Math.random() * 0.03));
    keywordHits = Math.min(1, Math.max(0, keywordHits + Math.random() * 0.02));

    const total = 
      commentDensity * weights.commentDensity + 
      viewerGrowth * weights.viewerGrowth + 
      keywordHits * weights.keywordHits;

    samples.push({
      timeSec,
      commentDensity,
      viewerGrowth,
      keywordHits,
      total: Math.min(1, total),
    });
  }

  return {
    videoDurationSec: durationSec,
    bucketSizeSec,
    samples,
  };
};

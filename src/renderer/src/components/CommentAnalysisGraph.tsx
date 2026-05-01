import React, { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import styles from './CommentAnalysisGraph.module.css';

export type ScoreSample = {
  timeSec: number;
  commentDensity: number;
  viewerGrowth: number;
  keywordHits: number;
  total: number;
};

export type CommentAnalysis = {
  videoDurationSec: number;
  bucketSizeSec: number;
  samples: ScoreSample[];
};

type Props = {
  analysis: CommentAnalysis;
  onSeek?: (sec: number) => void;
};

const formatHMS = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function CommentAnalysisGraph({ analysis, onSeek }: Props) {
  const currentSec = useEditorStore((s) => s.currentSec);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverSample, setHoverSample] = useState<{ sample: ScoreSample; x: number; y: number } | null>(null);

  const durationSec = analysis.videoDurationSec;

  const currentPercent = useMemo(() => {
    if (durationSec <= 0) return 0;
    return Math.min(100, Math.max(0, (currentSec / durationSec) * 100));
  }, [currentSec, durationSec]);

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const time = ratio * durationSec;

    // Find the closest sample
    const sampleIndex = Math.round(time / analysis.bucketSizeSec);
    const sample = analysis.samples[sampleIndex];

    if (sample) {
      setHoverSample({
        sample,
        x: (sample.timeSec / durationSec) * rect.width,
        y: e.clientY - rect.top,
      });
    } else {
      setHoverSample(null);
    }
  };

  const handleMouseLeave = () => {
    setHoverSample(null);
  };

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek?.(ratio * durationSec);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>盛り上がりスコア分析</h3>
        <div className={styles.legend}>
          <span className={styles.legendItem}><span className={styles.dot} style={{ background: 'var(--accent-primary)' }} /> コメント密度</span>
          <span className={styles.legendItem}><span className={styles.dot} style={{ background: '#818CF8' }} /> 視聴者増加</span>
          <span className={styles.legendItem}><span className={styles.dot} style={{ background: '#F472B6' }} /> キーワード</span>
        </div>
      </div>

      <div 
        ref={containerRef} 
        className={styles.graphArea}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <div className={styles.bars}>
          {analysis.samples.map((s, i) => {
            const height = s.total * 100;
            // スコアに応じて色を変化させる (低: muted -> 高: accent)
            // CSS変数の色をJSで補完するのは難しいので、CSSの背景色でグラデーションを作るか、
            // 段階的にクラスを分けるか。ここでは style で HSL を使うか、段階的な色指定を行う。
            // 既存の --accent-primary は青系。盛り上がりは暖色系が好ましいので、
            // 低スコアは muted、高スコアはオレンジ〜赤系を想定。
            const opacity = 0.3 + s.total * 0.7;
            const color = s.total > 0.8 ? '#F87171' : s.total > 0.5 ? '#FB923C' : 'var(--text-muted)';

            return (
              <div
                key={i}
                className={styles.bar}
                style={{ 
                  height: `${height}%`,
                  backgroundColor: color,
                  opacity,
                  left: `${(s.timeSec / durationSec) * 100}%`,
                  width: `${(analysis.bucketSizeSec / durationSec) * 100}%`
                }}
              />
            );
          })}
        </div>

        {/* 現在位置の線 */}
        <div
          className={styles.cursor}
          style={{ left: `${currentPercent}%` }}
        />

        {/* ツールチップ */}
        {hoverSample && (
          <div 
            className={styles.tooltip}
            style={{ 
              left: hoverSample.x,
              transform: `translateX(${hoverSample.x > (containerRef.current?.clientWidth || 0) - 150 ? '-100%' : '10px'})`
            }}
          >
            <div className={styles.tooltipTime}>{formatHMS(hoverSample.sample.timeSec)}</div>
            <div className={styles.tooltipTotal}>
              スコア: <span className={styles.totalValue}>{(hoverSample.sample.total * 100).toFixed(0)}</span>
            </div>
            <div className={styles.tooltipDetail}>
              <div>コメント密度: {(hoverSample.sample.commentDensity * 100).toFixed(0)}%</div>
              <div>視聴者増加: {(hoverSample.sample.viewerGrowth * 100).toFixed(0)}%</div>
              <div>キーワード: {(hoverSample.sample.keywordHits * 100).toFixed(0)}%</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

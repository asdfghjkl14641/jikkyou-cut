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
  selectionRange?: { startSec: number; endSec: number } | null;
  onSelectionChange?: (range: { startSec: number; endSec: number } | null) => void;
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

export default function CommentAnalysisGraph({ 
  analysis, 
  onSeek, 
  selectionRange, 
  onSelectionChange 
}: Props) {
  const currentSec = useEditorStore((s) => s.currentSec);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverSample, setHoverSample] = useState<{ sample: ScoreSample; x: number; y: number } | null>(null);
  const [dragStartSec, setDragStartSec] = useState<number | null>(null);
  const [dragCurrentSec, setDragCurrentSec] = useState<number | null>(null);

  const durationSec = analysis.videoDurationSec;

  const currentPercent = useMemo(() => {
    if (durationSec <= 0) return 0;
    return Math.min(100, Math.max(0, (currentSec / durationSec) * 100));
  }, [currentSec, durationSec]);

  const getTimeAtX = useCallback((x: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    return ratio * durationSec;
  }, [durationSec]);

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);
    setDragStartSec(time);
    setDragCurrentSec(time);
  };

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (dragStartSec !== null) {
      setDragCurrentSec(time);
    }

    // Find the closest sample for tooltip
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

  const handleMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (dragStartSec === null) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    // If movement is very small, treat as click/seek
    const diff = Math.abs(time - dragStartSec);
    // threshold: 5px
    const pxDiff = Math.abs(e.clientX - (rect.left + (dragStartSec / durationSec) * rect.width));

    if (pxDiff < 5) {
      onSeek?.(time);
      // Optional: clear selection on click? 
      // User said: "選択済み範囲をもう一度ドラッグしたら新規選択で上書き"
      // Click usually seeks in these heatmaps.
    } else {
      const start = Math.min(dragStartSec, time);
      const end = Math.max(dragStartSec, time);
      onSelectionChange?.({ startSec: start, endSec: end });
    }

    setDragStartSec(null);
    setDragCurrentSec(null);
  };

  const handleMouseLeave = () => {
    setHoverSample(null);
    if (dragStartSec !== null) {
      // Cancel drag or commit? Usually cancel if it leaves area without mouseup
      setDragStartSec(null);
      setDragCurrentSec(null);
    }
  };

  const dragRange = useMemo(() => {
    if (dragStartSec === null || dragCurrentSec === null) return null;
    return {
      start: Math.min(dragStartSec, dragCurrentSec),
      end: Math.max(dragStartSec, dragCurrentSec),
    };
  }, [dragStartSec, dragCurrentSec]);

  return (
    <div className={styles.container}>
      <div 
        ref={containerRef} 
        className={styles.graphArea}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        <div className={styles.bars}>
          {analysis.samples.map((s, i) => {
            const height = s.total * 100;
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

        {/* 選択範囲 (ドラッグ中) */}
        {dragRange && (
          <div 
            className={styles.selectionOverlay}
            style={{ 
              left: `${(dragRange.start / durationSec) * 100}%`,
              width: `${((dragRange.end - dragRange.start) / durationSec) * 100}%`
            }}
          />
        )}

        {/* 確定済み選択範囲 */}
        {selectionRange && !dragRange && (
          <div 
            className={styles.selectionOverlay}
            style={{ 
              left: `${(selectionRange.startSec / durationSec) * 100}%`,
              width: `${((selectionRange.endSec - selectionRange.startSec) / durationSec) * 100}%`
            }}
          />
        )}

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

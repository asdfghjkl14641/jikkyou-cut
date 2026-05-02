import React, { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { ScoreSample, CommentAnalysis } from '../../../common/types';
import { ReactionCategory } from '../../../common/commentAnalysis/keywords';
import styles from './CommentAnalysisGraph.module.css';

type Props = {
  analysis: CommentAnalysis;
  onSeek?: (sec: number) => void;
  selectionRange?: { startSec: number; endSec: number } | null;
  onSelectionChange?: (range: { startSec: number; endSec: number } | null) => void;
  onPeakClick?: (sample: ScoreSample) => void;
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

const CATEGORY_NAMES: Record<ReactionCategory, string> = {
  laugh: '笑い',
  surprise: '驚き',
  emotion: '感動',
  praise: '称賛',
  other: 'その他',
};

const CATEGORY_COLORS: Record<ReactionCategory, string> = {
  laugh: 'var(--reaction-laugh)',
  surprise: 'var(--reaction-surprise)',
  emotion: 'var(--reaction-emotion)',
  praise: 'var(--reaction-praise)',
  other: 'var(--reaction-other)',
};

export default function CommentAnalysisGraph({ 
  analysis, 
  onSeek, 
  selectionRange, 
  onSelectionChange,
  onPeakClick
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

  // SVG Waveform generation. 
  // We use a single smooth path for the entire graph.
  const points = useMemo(() => {
    const samples = analysis.samples;
    if (samples.length < 2) return [];
    
    return samples.map((s, i) => ({
      x: (i / (samples.length - 1)) * 100,
      y: (1 - s.total) * 100
    }));
  }, [analysis.samples]);

  // Catmull-Rom to Bezier conversion for smooth curves
  const curvePath = useMemo(() => {
    if (points.length < 3) return '';
    
    // Start at the first point
    let d = `M 0,${points[0]!.y}`;
    
    // Smooth the path using quadratic curves through midpoints
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      
      // Control point is the current point, destination is the midpoint to next
      d += ` Q ${p0.x},${p0.y} ${midX},${midY}`;
    }
    
    // Finish at the last point
    const last = points[points.length - 1]!;
    d += ` L 100,${last.y}`;
    
    return d;
  }, [points]);

  const fillPath = useMemo(() => {
    if (!curvePath) return '';
    return `${curvePath} L 100 100 L 0 100 Z`;
  }, [curvePath]);

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

    const pxDiff = Math.abs(e.clientX - (rect.left + (dragStartSec / durationSec) * rect.width));

    if (pxDiff < 5) {
      // Click detection. If total >= 0.5, it's a peak click.
      const sampleIndex = Math.round(time / analysis.bucketSizeSec);
      const sample = analysis.samples[sampleIndex];
      
      if (sample && sample.total >= 0.5) {
        onPeakClick?.(sample);
      } else {
        onSeek?.(time);
      }
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
    setDragStartSec(null);
    setDragCurrentSec(null);
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
        <svg className={styles.svgWaveform} viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="waveformFillGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 255, 255, 0.06)" />
              <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
            </linearGradient>
          </defs>
          
          <path d={fillPath} className={styles.waveformFill} />
          <path d={curvePath} className={styles.waveformPath} />
        </svg>

        {/* 選択範囲オーバーレイ */}
        {(dragRange || (selectionRange && !dragRange)) && (
          <div 
            className={styles.selectionOverlay}
            style={{ 
              left: `${((dragRange?.start ?? selectionRange?.startSec ?? 0) / durationSec) * 100}%`,
              width: `${(((dragRange?.end ?? selectionRange?.endSec ?? 0) - (dragRange?.start ?? selectionRange?.startSec ?? 0)) / durationSec) * 100}%`
            }}
          >
            <div className={styles.selectionBorder} style={{ left: 0 }} />
            <div className={styles.selectionBorder} style={{ right: 0 }} />
          </div>
        )}

        {/* ホバー縦線 (YouTube プレビュー風) */}
        {hoverSample && dragStartSec === null && (
          <div className={styles.hoverLine} style={{ left: hoverSample.x }} />
        )}

        {/* 再生位置インジケータ */}
        <div className={styles.cursor} style={{ left: `${currentPercent}%` }} />

        {/* Tooltip */}
        {hoverSample && (
          <div 
            className={styles.tooltip}
            style={{ 
              left: hoverSample.x,
              transform: `translateX(${hoverSample.x > (containerRef.current?.clientWidth || 0) - 180 ? '-100%' : '0'})`
            }}
          >
            <div className={styles.tooltipTime}>
              {formatHMS(hoverSample.sample.timeSec)} 〜 {formatHMS(hoverSample.sample.timeSec + analysis.bucketSizeSec)}
            </div>
            <div className={styles.tooltipTotal}>
              <span>スコア</span>
              <span>{(hoverSample.sample.total * 100).toFixed(0)}</span>
            </div>
            
            <div className={styles.tooltipDetail}>
              <div className={styles.categoryGrid}>
                {(Object.keys(hoverSample.sample.categoryHits) as ReactionCategory[]).map(cat => {
                  const val = hoverSample.sample.categoryHits[cat];
                  if (val <= 0) return null;
                  return (
                    <div key={cat} className={styles.categoryRow}>
                      <span className={styles.categoryDot} style={{ background: CATEGORY_COLORS[cat] }} />
                      <span className={styles.categoryLabel}>{CATEGORY_NAMES[cat]}</span>
                      <span className={styles.categoryValue}>{(val * 100).toFixed(0)}</span>
                    </div>
                  );
                })}
              </div>
              <div className={styles.msgStats}>
                コメント: {hoverSample.sample.messages.length}件
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



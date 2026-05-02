import React, { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { ScoreSample, CommentAnalysis } from '../../../common/types';
import { ReactionCategory } from '../../../common/commentAnalysis/keywords';
import { computeRollingScores } from '../lib/rollingScore';
import styles from './CommentAnalysisGraph.module.css';

type Props = {
  analysis: CommentAnalysis;
  // Rolling-window size in seconds (30..300). Coming from
  // editorStore.analysisWindowSec via the parent so the slider above the
  // graph can drive recomputation.
  windowSec: number;
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
  windowSec,
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

  // Stage 2: rolling-window scores. Recomputed on every windowSec
  // change but the inputs are stable references coming from main, so
  // memoisation is worth doing. Cost is sub-millisecond at 1-hour
  // videos, so this is comfortably below a frame even when the user
  // drags the slider.
  const samples = useMemo<ScoreSample[]>(() => {
    return computeRollingScores(
      analysis.buckets,
      windowSec,
      analysis.bucketSizeSec,
      analysis.hasViewerStats,
    );
  }, [analysis.buckets, analysis.bucketSizeSec, analysis.hasViewerStats, windowSec]);

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

  // Map a timeline second to a sample index. Samples slide bucket-by-
  // bucket so index = round(time / bucketSizeSec), clamped — at the very
  // tail where time > lastSample.timeSec we still want to land on the
  // last sample rather than off the end.
  const sampleAt = useCallback((timeSec: number): ScoreSample | null => {
    if (samples.length === 0) return null;
    const raw = Math.round(timeSec / analysis.bucketSizeSec);
    const clamped = Math.max(0, Math.min(samples.length - 1, raw));
    return samples[clamped] ?? null;
  }, [samples, analysis.bucketSizeSec]);

  // SVG Waveform generation.
  // We use a single smooth path for the entire graph.
  const points = useMemo(() => {
    if (samples.length < 2) return [];
    // The waveform spans the full timeline width even though samples
    // only reach `(buckets.length - bucketsPerWindow) * bucketSize`.
    // Map each sample's centre (start + W/2) to an x position so the
    // wave aligns with the time axis the user sees in the player.
    return samples.map((s) => {
      const centre = s.timeSec + windowSec / 2;
      const x = durationSec > 0 ? Math.min(100, Math.max(0, (centre / durationSec) * 100)) : 0;
      return { x, y: (1 - s.total) * 100 };
    });
  }, [samples, windowSec, durationSec]);

  // Catmull-Rom to Bezier conversion for smooth curves
  const curvePath = useMemo(() => {
    if (points.length < 3) return '';

    // Start at the first point's x (samples don't start at x=0 because
    // of the half-window offset, so anchor the path to wherever the
    // first sample actually sits).
    const first = points[0]!;
    let d = `M ${first.x},${first.y}`;

    // Smooth the path using quadratic curves through midpoints
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;

      // Control point is the current point, destination is the midpoint to next
      d += ` Q ${p0.x},${p0.y} ${midX},${midY}`;
    }

    // Finish at the last point
    const last = points[points.length - 1]!;
    d += ` L ${last.x},${last.y}`;

    return d;
  }, [points]);

  const fillPath = useMemo(() => {
    if (!curvePath || points.length === 0) return '';
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return `${curvePath} L ${last.x} 100 L ${first.x} 100 Z`;
  }, [curvePath, points]);

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

    const sample = sampleAt(time);
    if (sample) {
      const sampleCentre = sample.timeSec + windowSec / 2;
      setHoverSample({
        sample,
        x: durationSec > 0 ? (sampleCentre / durationSec) * rect.width : 0,
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
      const sample = sampleAt(time);

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
              {formatHMS(hoverSample.sample.timeSec)} 〜 {formatHMS(hoverSample.sample.timeSec + hoverSample.sample.windowSec)}
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
                      <span className={styles.categoryValue}>{val}</span>
                    </div>
                  );
                })}
              </div>
              <div className={styles.msgStats}>
                コメント: {hoverSample.sample.messageCount}件
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}




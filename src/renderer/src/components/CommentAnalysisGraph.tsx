import React, { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import { ScoreSample, CommentAnalysis, ClipSegment } from '../../../common/types';
import { ReactionCategory } from '../../../common/commentAnalysis/keywords';
import { computeRollingScores } from '../lib/rollingScore';
import styles from './CommentAnalysisGraph.module.css';

type Props = {
  analysis: CommentAnalysis;
  windowSec: number;
  // Selected clip segments — drawn as overlay bars on the waveform and
  // hit-tested for drag/resize.
  segments: ClipSegment[];
  // Single source of truth for "go to this time". Called for click-to-
  // seek, live-seek (drag with left button), and segment selection
  // bookkeeping. The component itself doesn't touch <video>.
  onSeek?: (sec: number) => void;
  // Right-drag → segment auto-add. Returns the store outcome so the
  // graph can show a transient warning toast for limit/duplicate.
  onAddSegmentRequested?: (
    args: { startSec: number; endSec: number; dominantCategory: ReactionCategory | null },
  ) => { ok: true; id: string } | { ok: false; reason: 'limit' | 'duplicate' };
  onMutateSegment?: (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => void;
  onRemoveSegment?: (id: string) => void;
  onSelectSegment?: (id: string) => void;
  selectedSegmentId?: string | null;
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
  death: '死亡',
  victory: '勝利',
  scream: '叫び',
  flag: 'フラグ',
  other: 'その他',
};

const CATEGORY_COLORS: Record<ReactionCategory, string> = {
  laugh: 'var(--reaction-laugh)',
  surprise: 'var(--reaction-surprise)',
  emotion: 'var(--reaction-emotion)',
  praise: 'var(--reaction-praise)',
  death: 'var(--reaction-death)',
  victory: 'var(--reaction-victory)',
  scream: 'var(--reaction-scream)',
  flag: 'var(--reaction-flag)',
  other: 'var(--reaction-other)',
};

type FillSegment = {
  category: ReactionCategory | null;
  startIdx: number;
  endIdx: number;
};

function groupByCategory(samples: ScoreSample[]): FillSegment[] {
  if (samples.length === 0) return [];
  const out: FillSegment[] = [];
  let curCat = samples[0]!.dominantCategory;
  let curStart = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.dominantCategory !== curCat) {
      out.push({ category: curCat, startIdx: curStart, endIdx: i - 1 });
      curCat = samples[i]!.dominantCategory;
      curStart = i;
    }
  }
  out.push({ category: curCat, startIdx: curStart, endIdx: samples.length - 1 });
  return out;
}

// Three discrete drag intents, all decided at mousedown time based on
// `e.button`:
//   * 'left-pending' → click-vs-live-seek (left button; promotes to
//      'left-live' on movement, fires plain seek on mouseup-without-move)
//   * 'segment-pending' → may promote to segment-move/resize/* once the
//      user drags ≥ 5 px. Plain click on a segment bar still seeks (so
//      the bars never block playhead jumps).
//   * 'right-select' → right-button drag, builds a range that auto-adds
//      a clip segment on release (≥ MIN_SEGMENT_SEC width).
//
// 'left-pending' demotes its hit-test only when the press lands on a
// segment bar — that's how we keep "click on bar → seek" working.
type DragMode =
  | { kind: 'left-pending'; downSec: number; downClientX: number; downClientY: number; pendingHit: { id: string; mode: 'left' | 'right' | 'middle' } | null }
  | { kind: 'left-live'; }
  | { kind: 'segment-move'; id: string; offsetSec: number; originStartSec: number; originEndSec: number; spanSec: number }
  | { kind: 'segment-resize-left'; id: string; originStartSec: number; originEndSec: number }
  | { kind: 'segment-resize-right'; id: string; originStartSec: number; originEndSec: number }
  | { kind: 'right-select'; startSec: number; currentSec: number };

const MIN_SEGMENT_SEC = 5;
const DRAG_THRESHOLD_PX = 5;

export default function CommentAnalysisGraph({
  analysis,
  windowSec,
  segments,
  onSeek,
  onAddSegmentRequested,
  onMutateSegment,
  onRemoveSegment,
  onSelectSegment,
  selectedSegmentId,
}: Props) {
  const currentSec = useEditorStore((s) => s.currentSec);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverSample, setHoverSample] = useState<{ sample: ScoreSample; x: number } | null>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);
  // Transient warning shown over the waveform when right-drag-add fails
  // (limit / duplicate). Self-clears after a couple of seconds.
  const [warning, setWarning] = useState<string | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showWarning = useCallback((msg: string) => {
    setWarning(msg);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => setWarning(null), 2200);
  }, []);

  const durationSec = analysis.videoDurationSec;

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

  const sampleAt = useCallback((timeSec: number): ScoreSample | null => {
    if (samples.length === 0) return null;
    const raw = Math.round(timeSec / analysis.bucketSizeSec);
    const clamped = Math.max(0, Math.min(samples.length - 1, raw));
    return samples[clamped] ?? null;
  }, [samples, analysis.bucketSizeSec]);

  const sampleX = useCallback((idx: number): number => {
    const s = samples[idx];
    if (!s || durationSec <= 0) return 0;
    const centre = s.timeSec + windowSec / 2;
    return Math.min(100, Math.max(0, (centre / durationSec) * 100));
  }, [samples, windowSec, durationSec]);

  const sampleY = useCallback((idx: number): number => {
    const s = samples[idx];
    if (!s) return 100;
    return (1 - s.total) * 100;
  }, [samples]);

  const strokePath = useMemo(() => {
    if (samples.length < 3) return '';
    const x0 = sampleX(0);
    const y0 = sampleY(0);
    let d = `M ${x0},${y0}`;
    for (let i = 0; i < samples.length - 1; i += 1) {
      const x = sampleX(i);
      const y = sampleY(i);
      const xn = sampleX(i + 1);
      const yn = sampleY(i + 1);
      const midX = (x + xn) / 2;
      const midY = (y + yn) / 2;
      d += ` Q ${x},${y} ${midX},${midY}`;
    }
    const lastIdx = samples.length - 1;
    d += ` L ${sampleX(lastIdx)},${sampleY(lastIdx)}`;
    return d;
  }, [samples, sampleX, sampleY]);

  const fillSegments = useMemo(() => groupByCategory(samples), [samples]);

  const fillSegmentRender = useMemo(() => {
    return fillSegments.map((seg, idx) => {
      const points: { x: number; y: number }[] = [];
      for (let i = seg.startIdx; i <= seg.endIdx; i += 1) {
        points.push({ x: sampleX(i), y: sampleY(i) });
      }
      if (points.length === 0) return null;
      const first = points[0]!;
      const last = points[points.length - 1]!;
      let d = `M ${first.x},${first.y}`;
      for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i]!;
        const p1 = points[i + 1]!;
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        d += ` Q ${p0.x},${p0.y} ${midX},${midY}`;
      }
      d += ` L ${last.x},${last.y} L ${last.x},100 L ${first.x},100 Z`;
      return {
        key: `seg-${idx}`,
        d,
        category: seg.category,
        gradientId: `fill-grad-${idx}`,
        x1: first.x,
        x2: last.x,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [fillSegments, sampleX, sampleY]);

  const hitTestSegment = useCallback((timeSec: number): { id: string; mode: 'left' | 'right' | 'middle' } | null => {
    if (durationSec <= 0) return null;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const handleSec = (6 / rect.width) * durationSec;
    for (const s of segments) {
      if (timeSec < s.startSec - handleSec || timeSec > s.endSec + handleSec) continue;
      if (Math.abs(timeSec - s.startSec) < handleSec) return { id: s.id, mode: 'left' };
      if (Math.abs(timeSec - s.endSec) < handleSec) return { id: s.id, mode: 'right' };
      if (timeSec >= s.startSec && timeSec <= s.endSec) return { id: s.id, mode: 'middle' };
    }
    return null;
  }, [segments, durationSec]);

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    // Suppress the native menu so right-button drag can be repurposed
    // for range selection. Without this, the user gets a stray context
    // menu the moment they release the right button.
    e.preventDefault();
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (e.button === 2) {
      // Right button → range drag for segment selection.
      e.preventDefault();
      setDrag({ kind: 'right-select', startSec: time, currentSec: time });
      return;
    }
    if (e.button !== 0) return;

    // Left button → start in pending. Promote to live-seek (drag) or
    // segment-* drag (if hit) once the user moves; release without
    // movement seeks via mouseup.
    const hit = hitTestSegment(time);
    setDrag({
      kind: 'left-pending',
      downSec: time,
      downClientX: e.clientX,
      downClientY: e.clientY,
      pendingHit: hit,
    });
  };

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (drag?.kind === 'left-pending') {
      const dx = Math.abs(e.clientX - drag.downClientX);
      const dy = Math.abs(e.clientY - drag.downClientY);
      if (dx + dy < DRAG_THRESHOLD_PX) {
        const sample = sampleAt(time);
        if (sample) {
          const sampleCentre = sample.timeSec + windowSec / 2;
          setHoverSample({ sample, x: durationSec > 0 ? (sampleCentre / durationSec) * rect.width : 0 });
        } else {
          setHoverSample(null);
        }
        return;
      }
      // Promote.
      const hit = drag.pendingHit;
      if (hit) {
        const seg = segments.find((s) => s.id === hit.id);
        if (seg) {
          onSelectSegment?.(seg.id);
          if (hit.mode === 'left') {
            setDrag({ kind: 'segment-resize-left', id: seg.id, originStartSec: seg.startSec, originEndSec: seg.endSec });
          } else if (hit.mode === 'right') {
            setDrag({ kind: 'segment-resize-right', id: seg.id, originStartSec: seg.startSec, originEndSec: seg.endSec });
          } else {
            setDrag({
              kind: 'segment-move',
              id: seg.id,
              offsetSec: drag.downSec - seg.startSec,
              originStartSec: seg.startSec,
              originEndSec: seg.endSec,
              spanSec: seg.endSec - seg.startSec,
            });
          }
          return;
        }
      }
      // No segment hit → promote to live-seek.
      onSeek?.(time);
      setDrag({ kind: 'left-live' });
      return;
    }

    if (drag?.kind === 'left-live') {
      onSeek?.(time);
      return;
    }

    if (drag?.kind === 'right-select') {
      setDrag({ ...drag, currentSec: time });
    } else if (drag?.kind === 'segment-move') {
      const sortedOthers = segments
        .filter((s) => s.id !== drag.id)
        .map((s) => ({ start: s.startSec, end: s.endSec }))
        .sort((a, b) => a.start - b.start);
      let nextStart = time - drag.offsetSec;
      let nextEnd = nextStart + drag.spanSec;
      if (nextStart < 0) { nextStart = 0; nextEnd = drag.spanSec; }
      if (nextEnd > durationSec) { nextEnd = durationSec; nextStart = nextEnd - drag.spanSec; }
      for (const o of sortedOthers) {
        if (o.end <= drag.originStartSec && nextStart < o.end) { nextStart = o.end; nextEnd = nextStart + drag.spanSec; }
        if (o.start >= drag.originEndSec && nextEnd > o.start) { nextEnd = o.start; nextStart = nextEnd - drag.spanSec; }
      }
      onMutateSegment?.(drag.id, { startSec: nextStart, endSec: nextEnd });
    } else if (drag?.kind === 'segment-resize-left') {
      const others = segments.filter((s) => s.id !== drag.id);
      const leftBound = others
        .filter((s) => s.endSec <= drag.originStartSec)
        .reduce((acc, s) => Math.max(acc, s.endSec), 0);
      const newStart = Math.max(leftBound, Math.min(drag.originEndSec - MIN_SEGMENT_SEC, time));
      onMutateSegment?.(drag.id, { startSec: newStart });
    } else if (drag?.kind === 'segment-resize-right') {
      const others = segments.filter((s) => s.id !== drag.id);
      const rightBound = others
        .filter((s) => s.startSec >= drag.originEndSec)
        .reduce((acc, s) => Math.min(acc, s.startSec), durationSec);
      const newEnd = Math.min(rightBound, Math.max(drag.originStartSec + MIN_SEGMENT_SEC, time));
      onMutateSegment?.(drag.id, { endSec: newEnd });
    }

    // Hover updates while idle or right-selecting.
    if (!drag || drag.kind === 'right-select') {
      const sample = sampleAt(time);
      if (sample) {
        const sampleCentre = sample.timeSec + windowSec / 2;
        setHoverSample({ sample, x: durationSec > 0 ? (sampleCentre / durationSec) * rect.width : 0 });
      } else {
        setHoverSample(null);
      }
    } else {
      setHoverSample(null);
    }
  };

  const handleMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) { setDrag(null); return; }
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (drag.kind === 'left-pending') {
      // Plain click → seek. Always — even when the click landed on an
      // existing segment overlay bar.
      onSeek?.(drag.downSec);
      if (drag.pendingHit) onSelectSegment?.(drag.pendingHit.id);
    } else if (drag.kind === 'right-select') {
      const start = Math.min(drag.startSec, time);
      const end = Math.max(drag.startSec, time);
      if (end - start < MIN_SEGMENT_SEC) {
        // Too short — discard silently. Right-click without drag also
        // ends here and is effectively a no-op (matches spec: "右クリ
        // ック単発: 何もしない").
      } else {
        // Reject overlap with any existing segment so the new bar
        // doesn't immediately collapse against its neighbour.
        const overlap = segments.some((s) => s.startSec < end && s.endSec > start);
        if (overlap) {
          showWarning('既存区間と重複しています');
        } else {
          const centreSample = sampleAt((start + end) / 2);
          const result = onAddSegmentRequested?.({
            startSec: start,
            endSec: end,
            dominantCategory: centreSample?.dominantCategory ?? null,
          });
          if (result && !result.ok) {
            if (result.reason === 'limit') showWarning('区間は最大 20 個までです');
            else if (result.reason === 'duplicate') showWarning('同じ範囲の区間が既に存在します');
          }
        }
      }
    }
    setDrag(null);
  };

  const handleMouseLeave = () => {
    if (drag?.kind === 'left-pending' || drag?.kind === 'right-select' || drag?.kind === 'left-live') {
      setDrag(null);
    }
    setHoverSample(null);
  };

  const inflightRange = drag?.kind === 'right-select' ? {
    start: Math.min(drag.startSec, drag.currentSec),
    end: Math.max(drag.startSec, drag.currentSec),
  } : null;

  return (
    <div className={styles.container}>
      <div
        ref={containerRef}
        className={styles.graphArea}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <svg className={styles.svgWaveform} viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="waveformFillGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 255, 255, 0.06)" />
              <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
            </linearGradient>

            {fillSegmentRender.map((seg) => {
              if (seg.category === null) return null;
              return (
                <linearGradient
                  key={seg.gradientId}
                  id={seg.gradientId}
                  gradientUnits="userSpaceOnUse"
                  x1={seg.x1}
                  y1={0}
                  x2={seg.x2}
                  y2={0}
                >
                  <stop offset="0%" stopColor={CATEGORY_COLORS[seg.category]} stopOpacity="0" />
                  <stop offset="10%" stopColor={CATEGORY_COLORS[seg.category]} stopOpacity="0.12" />
                  <stop offset="90%" stopColor={CATEGORY_COLORS[seg.category]} stopOpacity="0.12" />
                  <stop offset="100%" stopColor={CATEGORY_COLORS[seg.category]} stopOpacity="0" />
                </linearGradient>
              );
            })}
          </defs>

          {strokePath && <path d={`${strokePath} L 100,100 L 0,100 Z`} className={styles.waveformFill} />}

          {fillSegmentRender.map((seg) =>
            seg.category === null ? null : (
              <path
                key={seg.key}
                d={seg.d}
                className={styles.waveformFillCategory}
                fill={`url(#${seg.gradientId})`}
              />
            )
          )}

          <path d={strokePath} className={styles.waveformPath} />
        </svg>

        {/* In-flight right-drag selection overlay */}
        {inflightRange && (
          <div
            className={styles.selectionOverlay}
            style={{
              left: `${(inflightRange.start / durationSec) * 100}%`,
              width: `${((inflightRange.end - inflightRange.start) / durationSec) * 100}%`,
            }}
          >
            <div className={styles.selectionBorder} style={{ left: 0 }} />
            <div className={styles.selectionBorder} style={{ right: 0 }} />
          </div>
        )}

        {/* Selected clip-segment overlay bars */}
        {segments.map((seg, i) => {
          const cat = seg.dominantCategory ?? 'other';
          return (
            <div
              key={seg.id}
              className={`${styles.segmentBar} ${selectedSegmentId === seg.id ? styles.dragging : ''}`}
              style={{
                left: `${(seg.startSec / durationSec) * 100}%`,
                width: `${((seg.endSec - seg.startSec) / durationSec) * 100}%`,
                background: `color-mix(in srgb, ${CATEGORY_COLORS[cat]} 40%, transparent)`,
              }}
              title={`${i + 1}. ${formatHMS(seg.startSec)} 〜 ${formatHMS(seg.endSec)}${seg.title ? ' — ' + seg.title : ''}`}
            >
              <div className={`${styles.segmentResizeHandle} ${styles.segmentResizeHandleLeft}`} />
              <span className={styles.segmentNumber}>{i + 1}</span>
              {selectedSegmentId === seg.id && onRemoveSegment && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onRemoveSegment(seg.id); }}
                  style={{
                    marginLeft: 'auto', background: 'rgba(0,0,0,0.6)', border: 'none',
                    borderRadius: 4, color: 'white', cursor: 'pointer', padding: '2px 4px',
                    display: 'inline-flex', alignItems: 'center',
                  }}
                  title="この区間を削除"
                >
                  <Trash2 size={11} />
                </button>
              )}
              <div className={`${styles.segmentResizeHandle} ${styles.segmentResizeHandleRight}`} />
            </div>
          );
        })}

        {hoverSample && (drag === null || drag.kind === 'left-pending' || drag.kind === 'right-select') && (
          <div className={styles.hoverLine} style={{ left: hoverSample.x }} />
        )}

        <div className={styles.cursor} style={{ left: `${currentPercent}%` }} />

        {hoverSample && (drag === null || drag.kind === 'left-pending') && (
          <div
            className={styles.tooltip}
            style={{
              left: hoverSample.x,
              transform: `translateX(${hoverSample.x > (containerRef.current?.clientWidth || 0) - 180 ? '-100%' : '0'})`,
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

        {warning && (
          <div className={styles.warningToast}>{warning}</div>
        )}
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import { ScoreSample, CommentAnalysis, ClipSegment } from '../../../common/types';
import { ReactionCategory } from '../../../common/commentAnalysis/keywords';
import { computeRollingScores } from '../lib/rollingScore';
import styles from './CommentAnalysisGraph.module.css';

type Props = {
  analysis: CommentAnalysis;
  windowSec: number;
  segments: ClipSegment[];
  onSeek?: (sec: number) => void;
  onAddSegmentRequested?: (
    args: { startSec: number; endSec: number; dominantCategory: ReactionCategory | null },
  ) => { ok: true; id: string } | { ok: false; reason: 'limit' | 'duplicate' };
  onMutateSegment?: (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => void;
  onSelectSegment?: (id: string) => void;
  selectedSegmentId?: string | null;
  // Right-click on a segment bar opens a context menu owned by the
  // parent. The graph just hands over the segment id and the click
  // viewport coordinates.
  onSegmentContextMenu?: (segmentId: string, viewportX: number, viewportY: number) => void;
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

// State machine — left button fires seek immediately on mousedown so
// there is no perceptible click-vs-drag latency. Right button stays
// pending until 3 px of movement so a stray right-click doesn't insert
// a tiny segment by accident.
//
// Left mousedown on a segment bar still seeks immediately, then waits
// in 'segment-pending' for movement before promoting to move/resize.
// If the user releases without moving, the segment just gets selected
// (and the seek already fired).
type DragMode =
  | { kind: 'left-live' }
  | { kind: 'segment-pending'; id: string; mode: 'left' | 'right' | 'middle'; downSec: number; downClientX: number; downClientY: number; originStartSec: number; originEndSec: number }
  | { kind: 'segment-move'; id: string; offsetSec: number; originStartSec: number; originEndSec: number; spanSec: number }
  | { kind: 'segment-resize-left'; id: string; originStartSec: number; originEndSec: number }
  | { kind: 'segment-resize-right'; id: string; originStartSec: number; originEndSec: number }
  | { kind: 'right-pending'; downSec: number; downClientX: number; downClientY: number; segmentId: string | null }
  | { kind: 'right-select'; startSec: number; currentSec: number };

const MIN_SEGMENT_SEC = 5;
const DRAG_THRESHOLD_PX = 3;
const HOVER_TOOLTIP_DELAY_MS = 150;
// Tooltip offset from the cursor — keeps the tooltip from sitting
// directly under the pointer where it would block the waveform.
const TOOLTIP_OFFSET_X = 12;
const TOOLTIP_OFFSET_Y = 12;

export default function CommentAnalysisGraph({
  analysis,
  windowSec,
  segments,
  onSeek,
  onAddSegmentRequested,
  onMutateSegment,
  onSelectSegment,
  selectedSegmentId,
  onSegmentContextMenu,
}: Props) {
  const currentSec = useEditorStore((s) => s.currentSec);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverPos, setHoverPos] = useState<{ sample: ScoreSample; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RAF batching for live seek so a fast mousemove doesn't fire 200
  // setState/seek calls per second — only the latest position survives
  // until the next paint.
  const seekRafRef = useRef<number | null>(null);
  const pendingSeekTimeRef = useRef<number | null>(null);

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

  // Low-density placeholder threshold. With < N messages spread across
  // a multi-hour VOD, the rolling-score normalisation produces a
  // mostly-flat baseline that's invisible on the graph (height ≈ 0
  // everywhere) — the user reads it as "graph not rendering". We show
  // an overlay instead so they know the data is genuinely sparse, not
  // a UI bug. 10 was picked empirically: a 4h stream with ≥10 chat
  // messages already produces enough peaks to make the waveform
  // readable.
  const LOW_DENSITY_THRESHOLD = 10;
  const messageCount = analysis.chatMessageCount ?? analysis.allMessages.length;
  const isLowDensity = messageCount < LOW_DENSITY_THRESHOLD;

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

  // Coalesces seek requests onto a single rAF tick so live-seek mousemove
  // doesn't thrash the <video> currentTime setter.
  const scheduleSeek = useCallback((time: number) => {
    pendingSeekTimeRef.current = time;
    if (seekRafRef.current != null) return;
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = null;
      const t = pendingSeekTimeRef.current;
      pendingSeekTimeRef.current = null;
      if (t != null) onSeek?.(t);
    });
  }, [onSeek]);

  useEffect(() => () => {
    if (seekRafRef.current != null) cancelAnimationFrame(seekRafRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

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
    // Block the native menu unconditionally — we'll surface our own
    // context menu for segment bars from the mouseup handler.
    e.preventDefault();
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (e.button === 2) {
      // Right button → either segment context menu (if on a bar) or
      // potentially a right-drag range. Both decisions happen on
      // mousemove/mouseup; record the press position now.
      e.preventDefault();
      const hit = hitTestSegment(time);
      setDrag({
        kind: 'right-pending',
        downSec: time,
        downClientX: e.clientX,
        downClientY: e.clientY,
        segmentId: hit?.id ?? null,
      });
      return;
    }
    if (e.button !== 0) return;

    // Left button → seek IMMEDIATELY at mousedown for click-feel
    // responsiveness (no movement-threshold gate).
    scheduleSeek(time);

    const hit = hitTestSegment(time);
    if (hit) {
      onSelectSegment?.(hit.id);
      const seg = segments.find((s) => s.id === hit.id);
      if (!seg) return;
      // Wait for movement before promoting to move/resize. If the user
      // releases without moving, the seek above already happened.
      setDrag({
        kind: 'segment-pending',
        id: hit.id,
        mode: hit.mode,
        downSec: time,
        downClientX: e.clientX,
        downClientY: e.clientY,
        originStartSec: seg.startSec,
        originEndSec: seg.endSec,
      });
    } else {
      // Empty waveform → enter live-seek immediately. mousemove keeps
      // updating the seek position until mouseup.
      setDrag({ kind: 'left-live' });
    }
  };

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (drag?.kind === 'left-live') {
      scheduleSeek(time);
      setHoverPos(null);
      return;
    }

    if (drag?.kind === 'segment-pending') {
      const dx = Math.abs(e.clientX - drag.downClientX);
      const dy = Math.abs(e.clientY - drag.downClientY);
      if (dx + dy < DRAG_THRESHOLD_PX) return;
      // Promote to actual segment drag.
      if (drag.mode === 'left') {
        setDrag({ kind: 'segment-resize-left', id: drag.id, originStartSec: drag.originStartSec, originEndSec: drag.originEndSec });
      } else if (drag.mode === 'right') {
        setDrag({ kind: 'segment-resize-right', id: drag.id, originStartSec: drag.originStartSec, originEndSec: drag.originEndSec });
      } else {
        setDrag({
          kind: 'segment-move',
          id: drag.id,
          offsetSec: drag.downSec - drag.originStartSec,
          originStartSec: drag.originStartSec,
          originEndSec: drag.originEndSec,
          spanSec: drag.originEndSec - drag.originStartSec,
        });
      }
      return;
    }

    if (drag?.kind === 'right-pending') {
      const dx = Math.abs(e.clientX - drag.downClientX);
      const dy = Math.abs(e.clientY - drag.downClientY);
      if (dx + dy < DRAG_THRESHOLD_PX) return;
      // Promote to range-select. Even if we started over a segment
      // bar, we let the drag proceed — overlap detection in mouseup
      // will reject it, so the user gets a toast rather than a silent
      // no-op.
      setDrag({ kind: 'right-select', startSec: drag.downSec, currentSec: time });
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

    // Hover tooltip — only update while idle (not dragging anything
    // active). Delay 150 ms before showing to avoid flicker as the
    // cursor sweeps across the waveform.
    //
    // The `x` we use for the visible hover-line is the **actual cursor
    // x**, not the matched sample's window-centre. Earlier we used
    // `(sampleCentre / durationSec) * rect.width` which made the line
    // visibly snap to bucket boundaries — feels like the line "lags"
    // the cursor. The data shown in the tooltip still comes from the
    // matched sample (it's the right granularity for "what's
    // happening here?"); only the line position follows the cursor.
    if (!drag || drag.kind === 'right-select') {
      const sample = sampleAt(time);
      if (sample) {
        const cursorX = x;
        const cursorY = e.clientY - rect.top;
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          setHoverPos({ sample, x: cursorX, y: cursorY });
        }, HOVER_TOOLTIP_DELAY_MS);
        return;
      }
    }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoverPos(null);
  };

  const handleMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) { setDrag(null); return; }
    const x = e.clientX - rect.left;
    const time = getTimeAtX(x);

    if (drag.kind === 'left-live') {
      // Final position snap. The rAF batch may still have an unfired
      // update queued — flush it synchronously so the playhead lands
      // exactly where the user released.
      onSeek?.(time);
    } else if (drag.kind === 'segment-pending') {
      // Released without moving past threshold. Seek already happened
      // at mousedown, segment was already selected — nothing else to
      // do.
    } else if (drag.kind === 'right-pending') {
      // Right click without drag. If on a segment bar → context menu;
      // otherwise no-op (per spec).
      if (drag.segmentId) {
        onSegmentContextMenu?.(drag.segmentId, e.clientX, e.clientY);
      }
    } else if (drag.kind === 'right-select') {
      const start = Math.min(drag.startSec, time);
      const end = Math.max(drag.startSec, time);
      if (end - start < MIN_SEGMENT_SEC) {
        // Too short — discard silently.
      } else {
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
    if (drag?.kind === 'left-live' || drag?.kind === 'right-pending' || drag?.kind === 'right-select' || drag?.kind === 'segment-pending') {
      setDrag(null);
    }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoverPos(null);
  };

  const inflightRange = drag?.kind === 'right-select' ? {
    start: Math.min(drag.startSec, drag.currentSec),
    end: Math.max(drag.startSec, drag.currentSec),
  } : null;

  // Tooltip is only visible while the user is hovering with no active
  // drag. left-live and segment-* drags hide it so it doesn't flicker
  // along with the playhead.
  const showTooltip = hoverPos != null && (drag === null || drag.kind === 'right-select');

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
        {/* Low-density overlay. Sits over the SVG waveform but below
            the segment overlays in z-order so the user can still drag
            to add segments manually. We don't bail out of rendering
            the SVG entirely because seek-on-click + segment bars are
            still useful when chat is sparse. */}
        {isLowDensity && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 4,
              pointerEvents: 'none',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
              textAlign: 'center',
              padding: '0 12px',
              zIndex: 1,
            }}
          >
            <div>コメント密度が不足しています({messageCount} 件)</div>
            <div style={{ fontSize: 'var(--font-size-xs)' }}>
              Twitch クッキー設定 or 動画 DL 完了後にローカル動画で編集してください
            </div>
          </div>
        )}
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
              <div className={`${styles.segmentResizeHandle} ${styles.segmentResizeHandleRight}`} />
            </div>
          );
        })}

        {showTooltip && hoverPos && (
          <div className={styles.hoverLine} style={{ left: hoverPos.x }} />
        )}

        <div className={styles.cursor} style={{ left: `${currentPercent}%` }} />

        {showTooltip && hoverPos && (() => {
          // Compact 1-line tooltip. Position it diagonally off the
          // cursor so it doesn't sit on top of the waveform itself.
          // Flip horizontally near the right edge.
          const containerW = containerRef.current?.clientWidth ?? 0;
          const cursorX = hoverPos.x + TOOLTIP_OFFSET_X;
          const flipLeft = cursorX > containerW - 220;
          return (
            <div
              className={styles.tooltipCompact}
              style={{
                left: flipLeft ? hoverPos.x - TOOLTIP_OFFSET_X : cursorX,
                top: hoverPos.y + TOOLTIP_OFFSET_Y,
                transform: flipLeft ? 'translateX(-100%)' : undefined,
              }}
            >
              <span className={styles.tooltipTimeInline}>{formatHMS(hoverPos.sample.timeSec)}</span>
              <span className={styles.tooltipDot}>·</span>
              <span>スコア {(hoverPos.sample.total * 100).toFixed(0)}</span>
              <span className={styles.tooltipDot}>·</span>
              <span>{hoverPos.sample.messageCount}コメ</span>
            </div>
          );
        })()}

        {warning && <div className={styles.warningToast}>{warning}</div>}
      </div>
    </div>
  );
}

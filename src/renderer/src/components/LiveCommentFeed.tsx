import React, { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { ChevronDown, MessageCircle } from 'lucide-react';
import type { ChatMessage } from '../../../common/types';
import { ReactionCategory, REACTION_KEYWORDS } from '../../../common/commentAnalysis/keywords';
import styles from './LiveCommentFeed.module.css';

type Props = {
  messages: ChatMessage[];        // expected sorted by timeSec ascending
  currentSec: number;
  onCommentClick?: (sec: number) => void;
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

// Compacted progressively: 60 → 40 → 32 px. Even at 40 the feed
// looked sparse on a typical 1080p clip-select layout (~9 rows
// visible). 32 px lands ~15 rows in the same viewport while still
// leaving the time column readable at 11 px. CSS padding / line-height
// follow suit; the constants here only control virtual-scroll math.
const ROW_HEIGHT = 32;
const BUFFER_ROWS = 10;
// "Current" highlight band, in seconds either side of currentSec.
const CURRENT_BAND_SEC = 5;
// Tolerance for distinguishing programmatic scrollTop from user wheel.
const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 4;

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

// Binary search: index of the first message at or after `sec`. Returns
// `messages.length` when every message is earlier than `sec`.
function findFirstAtOrAfter(messages: ChatMessage[], sec: number): number {
  let lo = 0, hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid]!.timeSec < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Pre-sort once at module load: longer patterns first so we don't
// double-tag (e.g. matching '草' inside '草草草' before 'wwww' takes
// precedence).
const SORTED_KEYWORDS = [...REACTION_KEYWORDS].sort(
  (a, b) => b.pattern.length - a.pattern.length,
);

// Wraps any reaction-keyword substring in a coloured <span>. Plain
// string fragments are returned as-is. Used per row, so the function
// must stay cheap; the SORTED_KEYWORDS array is iterated once per
// fragment.
function highlightKeywords(text: string): React.ReactNode[] {
  if (!text) return [text];
  let frags: React.ReactNode[] = [text];
  for (const { pattern, category } of SORTED_KEYWORDS) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'g');
    const next: React.ReactNode[] = [];
    for (const f of frags) {
      if (typeof f !== 'string') {
        next.push(f);
        continue;
      }
      const parts = f.split(re);
      parts.forEach((p, i) => {
        if (!p) return;
        if (i % 2 === 1) {
          next.push(
            <span
              key={`${pattern}-${next.length}-${i}`}
              className={styles.kw}
              style={{ borderColor: CATEGORY_COLORS[category] }}
            >
              {p}
            </span>
          );
        } else {
          next.push(p);
        }
      });
    }
    frags = next;
  }
  return frags;
}

export default function LiveCommentFeed({ messages, currentSec, onCommentClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [autoScroll, setAutoScroll] = useState(true);

  // Tracks the scrollTop we just programmatically wrote, so handleScroll
  // can distinguish "we did this" from "user moved the wheel".
  const lastProgrammaticScrollTopRef = useRef<number | null>(null);

  // Resize observer to keep `containerHeight` in sync — affects how
  // many rows we render and where the "centre" target lands.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerHeight(el.clientHeight || 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Index of the first comment whose time >= currentSec. We center the
  // viewport on this index when auto-scroll is on.
  const currentIndex = useMemo(
    () => findFirstAtOrAfter(messages, currentSec),
    [messages, currentSec],
  );

  // Auto-scroll on currentSec change. Use 'auto' (instant) — smooth
  // scrolling while the playhead ticks at 60 fps would queue a
  // never-finishing animation chain.
  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (!el || messages.length === 0) return;
    // Centre the current index in the viewport.
    const target = Math.max(
      0,
      currentIndex * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT / 2,
    );
    if (Math.abs(target - el.scrollTop) < 1) return;
    lastProgrammaticScrollTopRef.current = target;
    el.scrollTo({ top: target, behavior: 'auto' });
  }, [autoScroll, currentIndex, messages.length]);

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const top = (e.target as HTMLDivElement).scrollTop;
    setScrollTop(top);
    // Filter out the scroll event triggered by our own scrollTo call.
    const lastProg = lastProgrammaticScrollTopRef.current;
    if (lastProg != null && Math.abs(top - lastProg) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
      lastProgrammaticScrollTopRef.current = null;
      return;
    }
    // User-initiated scroll → pause auto-follow until they re-engage.
    if (autoScroll) setAutoScroll(false);
  }, [autoScroll]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
  const endIdx = Math.min(messages.length, startIdx + visibleCount);
  const totalHeight = messages.length * ROW_HEIGHT;
  const topSpacer = startIdx * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, totalHeight - endIdx * ROW_HEIGHT);

  const visible = messages.slice(startIdx, endIdx);

  const resumeAutoScroll = () => {
    setAutoScroll(true);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <MessageCircle size={14} className={styles.headerIcon} />
          <span className={styles.headerTitle}>コメント</span>
          <span className={styles.headerCount}>({messages.length}件)</span>
        </div>
        <label className={styles.autoScrollToggle} title="再生位置に自動追従">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          <span>自動スクロール</span>
        </label>
      </div>

      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          コメントが取得できていません(ローカル動画 / 取得失敗時)
        </div>
      ) : (
        <div
          ref={containerRef}
          className={styles.scrollArea}
          onScroll={handleScroll}
        >
          <div style={{ height: topSpacer }} />
          {visible.map((m, i) => {
            const idx = startIdx + i;
            const dt = m.timeSec - currentSec;
            const isCurrent = Math.abs(dt) <= CURRENT_BAND_SEC;
            const isPast = dt < -CURRENT_BAND_SEC;
            const isFuture = dt > CURRENT_BAND_SEC;
            return (
              <div
                key={idx}
                className={
                  `${styles.row} ` +
                  (isCurrent ? styles.rowCurrent : '') + ' ' +
                  (isPast ? styles.rowPast : '') + ' ' +
                  (isFuture ? styles.rowFuture : '')
                }
                style={{ height: ROW_HEIGHT }}
                onClick={() => onCommentClick?.(m.timeSec)}
                title={`${formatHMS(m.timeSec)} @${m.author}: ${m.text}`}
              >
                <span className={styles.rowTime}>{formatHMS(m.timeSec)}</span>
                <span className={styles.rowText}>{highlightKeywords(m.text)}</span>
              </div>
            );
          })}
          <div style={{ height: bottomSpacer }} />

          {/* Floating "jump to current" button when user has manually
              scrolled away from auto-follow. */}
          {!autoScroll && messages.length > 0 && (
            <button
              type="button"
              className={styles.jumpToCurrent}
              onClick={resumeAutoScroll}
              title="現在位置に戻る"
            >
              <ChevronDown size={14} />
              現在位置
            </button>
          )}
        </div>
      )}
    </div>
  );
}

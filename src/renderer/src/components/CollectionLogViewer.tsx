import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import styles from './CollectionLogViewer.module.css';

// Renders the data-collection log file with level filter + virtual
// scroll. Auto-refreshes every 5 s by default; manual refresh button
// also available. The "ファイルを開く" button hands off to the OS
// default editor via shell.openPath.

type LogEntry = {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

type Filter = 'all' | 'info' | 'warn' | 'error';

const ROW_HEIGHT = 26;
const BUFFER_ROWS = 12;
const REFRESH_INTERVAL_MS = 5000;

const formatTime = (iso: string): string => {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export default function CollectionLogViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(360);
  // Track whether the user is parked at the top — if yes, new entries
  // (which now appear at the top after the 2026-05-03 chronological
  // flip) auto-scroll into view; if they've scrolled down to read
  // older lines, we leave their position alone.
  const stickToTopRef = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.api.collectionLog.read(5000);
      setEntries(data);
    } catch (err) {
      console.warn('[collection-log] read failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + interval poll.
  useEffect(() => {
    void refresh();
    if (!autoRefresh) return;
    const t = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh, autoRefresh]);

  // Resize observer for the scroll container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerHeight(el.clientHeight || 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reversed for display: newest at index 0. The underlying file is
  // append-only (oldest first) per `appendFileSync` in logger.ts; the
  // flip is purely a UI concern — chat-app style "newest on top".
  const filtered = useMemo(() => {
    const base = filter === 'all' ? entries : entries.filter((e) => e.level === filter);
    // Shallow copy before reverse so we don't mutate the source array.
    return [...base].reverse();
  }, [entries, filter]);

  // Auto-scroll to top on new entries when stuck-to-top.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToTopRef.current) return;
    el.scrollTop = 0;
  }, [filtered.length]);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.target as HTMLDivElement;
    setScrollTop(el.scrollTop);
    // Threshold: within 20 px of the top = "stuck". This survives
    // a small wheel flick without thrashing the flag.
    stickToTopRef.current = el.scrollTop < 20;
  };

  // Virtual-scroll math (same pattern as LiveCommentFeed).
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
  const endIdx = Math.min(filtered.length, startIdx + visibleCount);
  const totalHeight = filtered.length * ROW_HEIGHT;
  const topSpacer = startIdx * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, totalHeight - endIdx * ROW_HEIGHT);
  const visible = filtered.slice(startIdx, endIdx);

  const counts = useMemo(() => {
    let info = 0, warn = 0, error = 0;
    for (const e of entries) {
      if (e.level === 'info') info += 1;
      else if (e.level === 'warn') warn += 1;
      else if (e.level === 'error') error += 1;
    }
    return { info, warn, error, all: entries.length };
  }, [entries]);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.filterGroup}>
          <FilterButton current={filter} value="all"   label={`全て (${counts.all})`} onClick={setFilter} />
          <FilterButton current={filter} value="info"  label={`INFO (${counts.info})`} onClick={setFilter} variant="info" />
          <FilterButton current={filter} value="warn"  label={`WARN (${counts.warn})`} onClick={setFilter} variant="warn" />
          <FilterButton current={filter} value="error" label={`ERROR (${counts.error})`} onClick={setFilter} variant="error" />
        </div>
        <div className={styles.toolbarSpacer} />
        <label className={styles.autoRefreshLabel} title="5 秒ごとに再読み込み">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          自動更新
        </label>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => void refresh()}
          disabled={loading}
          title="今すぐ再読み込み"
        >
          <RefreshCw size={12} className={loading ? styles.spin : undefined} />
          更新
        </button>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => void window.api.collectionLog.openInExplorer()}
          title="OS の既定エディタで開く"
        >
          <ExternalLink size={12} />
          ファイルを開く
        </button>
      </div>

      {entries.length === 0 ? (
        <div className={styles.emptyState}>
          {loading ? '読み込み中...' : 'ログファイルが見つかりません(まだ収集が走っていない可能性があります)。'}
        </div>
      ) : (
        <div ref={containerRef} className={styles.scrollArea} onScroll={handleScroll}>
          <div style={{ height: topSpacer }} />
          {visible.map((e, i) => {
            const idx = startIdx + i;
            return (
              <div
                key={`${e.timestamp}-${idx}`}
                className={`${styles.row} ${e.level === 'warn' ? styles.rowWarn : ''} ${e.level === 'error' ? styles.rowError : ''}`}
                style={{ height: ROW_HEIGHT }}
              >
                <span className={styles.rowTime}>{formatTime(e.timestamp)}</span>
                <span className={styles.rowLevel}>{e.level.toUpperCase()}</span>
                <span className={styles.rowMessage}>{e.message}</span>
              </div>
            );
          })}
          <div style={{ height: bottomSpacer }} />
        </div>
      )}
    </div>
  );
}

function FilterButton(props: {
  current: Filter;
  value: Filter;
  label: string;
  onClick: (v: Filter) => void;
  variant?: 'info' | 'warn' | 'error';
}) {
  const active = props.current === props.value;
  const variantClass = props.variant === 'warn' ? styles.filterWarn : props.variant === 'error' ? styles.filterError : '';
  return (
    <button
      type="button"
      className={`${styles.filterButton} ${active ? styles.filterButtonActive : ''} ${variantClass}`}
      onClick={() => props.onClick(props.value)}
    >
      {props.label}
    </button>
  );
}

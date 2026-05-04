import { useCallback, useEffect, useState } from 'react';
import { Film, FolderOpen, Download, Radio } from 'lucide-react';
import type { RecentVideo } from '../../../common/types';
import { useEditorStore } from '../store/editorStore';
import styles from './RecentVideosSection.module.css';

// 2026-05-04 — Home-screen feed of "videos within reach right now".
// Auto-recorded streams + URL-downloaded VODs in the last 24h appear
// here so the user doesn't have to crawl Explorer or the registered-
// channels view to pick up where they left off. Hidden entirely when
// the list is empty (= fresh install / no recent activity).

const MAX_AGE_HOURS = 24;
const REFRESH_INTERVAL_MS = 60_000;

export default function RecentVideosSection() {
  const setFile = useEditorStore((s) => s.setFile);
  const [videos, setVideos] = useState<RecentVideo[]>([]);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.recentVideos.list(MAX_AGE_HOURS);
      setVideos(list);
    } catch (err) {
      console.warn('[recent-videos] list IPC failed:', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
      setTick((n) => n + 1);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  void tick;

  if (videos.length === 0) return null;

  const handleOpen = (v: RecentVideo) => {
    if (v.recordingStatus === 'recording') {
      const ok = window.confirm(
        '録画継続中のファイルは再生できないことがあります。それでも開きますか?',
      );
      if (!ok) return;
    }
    void setFile(v.filePath);
  };

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <FolderOpen size={18} />
          新着動画
        </h2>
        <span className={styles.subtitle}>{MAX_AGE_HOURS} 時間以内 · {videos.length} 件</span>
      </div>
      <div className={styles.grid}>
        {videos.map((v) => (
          <VideoCard key={v.filePath} video={v} onOpen={handleOpen} />
        ))}
      </div>
    </section>
  );
}

function VideoCard({ video, onOpen }: { video: RecentVideo; onOpen: (v: RecentVideo) => void }) {
  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onOpen(video)}
      title={video.filePath}
    >
      <VideoThumbnail video={video} />
      <div className={styles.info}>
        <div className={styles.cardTitle}>{video.title || video.fileName.replace(/\.[^.]+$/, '')}</div>
        {video.channelDisplayName && (
          <div className={styles.channel}>{video.channelDisplayName}</div>
        )}
        <div className={styles.meta}>
          <span>{formatBytes(video.fileSizeBytes)}</span>
          <span>·</span>
          <span>{formatRelativeTime(video.createdAt)}</span>
        </div>
      </div>
    </button>
  );
}

// Match VideoPlayer's toMediaUrl format exactly: `media://localhost/<encoded-abspath>`.
// The earlier `media://${path}` form lost the drive letter (Chromium parsed
// `C:` as the host) and the protocol handler 404'd every thumbnail — which
// is why the H-H placeholder kept appearing despite ffmpeg generating jpgs
// successfully on disk.
function toMediaUrl(absPath: string): string {
  return `media://localhost/${encodeURIComponent(absPath)}`;
}

function VideoThumbnail({ video }: { video: RecentVideo }) {
  const thumbUrl = video.thumbnailPath
    ? toMediaUrl(video.thumbnailPath)
    : video.thumbnailUrl;

  return (
    <div
      className={styles.thumbnail}
      style={thumbUrl ? { backgroundImage: `url("${thumbUrl}")` } : {}}
    >
      {!thumbUrl && <div className={styles.thumbnailFallback}>📹</div>}
      <PlatformBadge video={video} />
      {video.recordingStatus === 'recording' && (
        <span className={`${styles.statusOverlay} ${styles.statusLive}`}>録画中</span>
      )}
    </div>
  );
}

function PlatformBadge({ video }: { video: RecentVideo }) {
  if (video.source === 'url-download') {
    return (
      <span className={`${styles.platformBadge} ${styles.badgeDownload}`}>
        <Download size={11} />
        DL
      </span>
    );
  }

  const label = video.platform === 'twitch' ? 'Twitch' :
                video.platform === 'youtube' ? 'YouTube' : '録画';

  return (
    <span className={`${styles.platformBadge} ${styles.badgeRecording}`}>
      <Radio size={11} />
      {label}
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min} 分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 時間前`;
  return `${Math.floor(hour / 24)} 日前`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

import { useMemo, useRef, type MouseEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import { deriveKeptRegions } from '../../../common/segments';
import styles from './Timeline.module.css';

type Props = {
  onSeek: (sec: number) => void;
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

export default function Timeline({ onSeek }: Props) {
  const cues = useEditorStore((s) => s.cues);
  const durationSec = useEditorStore((s) => s.durationSec);
  const currentSec = useEditorStore((s) => s.currentSec);

  const trackRef = useRef<HTMLDivElement>(null);

  const regions = useMemo(
    () => deriveKeptRegions(cues, durationSec),
    [cues, durationSec],
  );

  if (durationSec == null || durationSec <= 0) {
    return (
      <div className={styles.timeline}>
        <div className={styles.placeholder}>
          動画を読み込むとタイムラインが表示されます
        </div>
      </div>
    );
  }

  const currentPercent = Math.min(
    100,
    Math.max(0, (currentSec / durationSec) * 100),
  );

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    onSeek(ratio * durationSec);
  };

  return (
    <div className={styles.timeline}>
      <div className={styles.labels}>
        <span>{formatHMS(0)}</span>
        <span>{formatHMS(durationSec / 2)}</span>
        <span>{formatHMS(durationSec)}</span>
      </div>
      <div ref={trackRef} className={styles.track} onClick={handleClick}>
        {regions.map((r, i) => {
          const left = (r.startSec / durationSec) * 100;
          const width = ((r.endSec - r.startSec) / durationSec) * 100;
          return (
            <div
              key={`${r.startSec}-${i}`}
              className={styles.kept}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
        <div
          className={styles.cursor}
          style={{ left: `${currentPercent}%` }}
        />
      </div>
    </div>
  );
}

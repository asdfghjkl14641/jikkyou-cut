import { useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { deriveKeptRegions } from '../../../common/segments';
import ExportButton from './ExportButton';
import styles from './ExportPreview.module.css';

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

export default function ExportPreview() {
  const cues = useEditorStore((s) => s.cues);
  const durationSec = useEditorStore((s) => s.durationSec);
  const previewMode = useEditorStore((s) => s.previewMode);
  const setPreviewMode = useEditorStore((s) => s.setPreviewMode);

  const summary = useMemo(() => {
    if (durationSec == null || durationSec <= 0 || cues.length === 0) return null;
    const regions = deriveKeptRegions(cues);
    const keptSec = regions.reduce(
      (acc, r) => acc + (r.endSec - r.startSec),
      0,
    );
    const cutSec = Math.max(0, durationSec - keptSec);
    const cutPercent = (cutSec / durationSec) * 100;
    return { keptSec, cutSec, cutPercent };
  }, [cues, durationSec]);

  if (summary == null || durationSec == null) return null;

  return (
    <div className={styles.preview}>
      <label
        className={styles.previewToggle}
        title="削除済み区間を自動でスキップして再生します"
      >
        <input
          type="checkbox"
          checked={previewMode}
          onChange={(e) => setPreviewMode(e.target.checked)}
        />
        <span>プレビュー再生</span>
      </label>
      <div className={styles.summary}>
        <span>
          <span className={styles.original}>元: {formatHMS(durationSec)}</span>{' '}
          <span className={styles.arrow}>→</span>{' '}
          <span className={styles.exported}>
            書き出し: {formatHMS(summary.keptSec)}
          </span>
        </span>
        <span>
          <span className={styles.delta}>(-{formatHMS(summary.cutSec)},</span>{' '}
          <span className={styles.percent}>
            {summary.cutPercent.toFixed(0)}%カット)
          </span>
        </span>
      </div>
      <ExportButton />
    </div>
  );
}

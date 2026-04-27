import { useEditorStore } from '../store/editorStore';
import { useTranscription } from '../hooks/useTranscription';
import styles from './TranscribeButton.module.css';

type Props = {
  modelConfigured: boolean;
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

export default function TranscribeButton({ modelConfigured }: Props) {
  const status = useEditorStore((s) => s.transcriptionStatus);
  const progress = useEditorStore((s) => s.transcriptionProgress);
  const error = useEditorStore((s) => s.transcriptionError);
  const durationSec = useEditorStore((s) => s.durationSec);
  const { start, cancel } = useTranscription();

  const isRunning = status === 'running';
  const canStart = modelConfigured && durationSec != null && !isRunning;

  const percent = (() => {
    if (!progress) return 0;
    if (progress.durationMicros <= 0) return 0;
    return Math.min(
      100,
      (progress.outTimeMicros / progress.durationMicros) * 100,
    );
  })();

  const elapsed = progress
    ? formatHMS(progress.outTimeMicros / 1_000_000)
    : '0:00';
  const total = durationSec != null ? formatHMS(durationSec) : '--:--';

  return (
    <div className={styles.container}>
      {!isRunning && (
        <button
          type="button"
          className={styles.startButton}
          onClick={start}
          disabled={!canStart}
          title={
            !modelConfigured
              ? 'Whisperモデルを設定してください'
              : durationSec == null
                ? '動画の長さを取得中です'
                : undefined
          }
        >
          文字起こしを開始
        </button>
      )}

      {isRunning && (
        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className={styles.progressMeta}>
            <span>
              {percent.toFixed(0)}% ({elapsed} / {total}
              {progress?.speed != null ? `, ${progress.speed.toFixed(1)}x` : ''})
            </span>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={cancel}
            >
              中止
            </button>
          </div>
        </div>
      )}

      {status === 'cancelled' && (
        <div className={styles.statusNote}>文字起こしを中止しました。</div>
      )}

      {status === 'error' && error && (
        <div className={styles.errorBanner}>{error}</div>
      )}
    </div>
  );
}

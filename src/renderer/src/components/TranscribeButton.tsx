import { useEditorStore } from '../store/editorStore';
import { useTranscription } from '../hooks/useTranscription';
import type { TranscriptionPhase } from '../../../common/types';
import { Wand2, X, RotateCw } from 'lucide-react';
import styles from './TranscribeButton.module.css';

type Props = {
  apiKeyConfigured: boolean;
};

const PHASE_LABEL: Record<TranscriptionPhase, string> = {
  extracting: '抽出中',
  uploading: 'アップロード中',
  transcribing: '文字起こし中',
};

const formatHMS = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00';
  const sec = Math.floor(totalSec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function TranscribeButton({ apiKeyConfigured }: Props) {
  const status = useEditorStore((s) => s.transcriptionStatus);
  const progress = useEditorStore((s) => s.transcriptionProgress);
  const error = useEditorStore((s) => s.transcriptionError);
  const durationSec = useEditorStore((s) => s.durationSec);
  const collaborationMode = useEditorStore((s) => s.collaborationMode);
  const setCollaborationMode = useEditorStore((s) => s.setCollaborationMode);
  const { start, cancel } = useTranscription();

  const isRunning = status === 'running';
  const canStart = apiKeyConfigured && durationSec != null && !isRunning;

  const phaseLabel = progress ? PHASE_LABEL[progress.phase] : '';
  const percent = (() => {
    if (!progress || progress.ratio == null) return null;
    return Math.min(100, Math.max(0, progress.ratio * 100));
  })();
  const elapsedLabel =
    progress?.phase === 'transcribing' && progress.elapsedSec != null
      ? formatHMS(progress.elapsedSec)
      : null;

  return (
    <div className={styles.container}>
      <label
        className={styles.toggleWrapper}
        title={
          collaborationMode
            ? '複数人での実況・対談動画(話者を識別)'
            : '1人での実況(処理が軽量)'
        }
      >
        <span className={styles.toggleLabel}>マルチ</span>
        <span className={styles.toggleSwitch}>
          <input
            type="checkbox"
            checked={collaborationMode}
            onChange={(e) => setCollaborationMode(e.target.checked)}
            disabled={isRunning}
          />
          <span className={styles.slider}></span>
        </span>
      </label>

      {!isRunning && (
        <button
          type="button"
          className={styles.startButton}
          onClick={start}
          disabled={!canStart}
          title={
            !apiKeyConfigured
              ? 'Gemini APIキーを設定してください'
              : durationSec == null
                ? '動画の長さを取得中です'
                : '文字起こしを開始'
          }
        >
          <Wand2 strokeWidth={1.5} size={20} />
        </button>
      )}

      {isRunning && (
        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={`${styles.progressFill} ${percent == null ? styles.progressIndeterminate : ''}`}
              style={percent != null ? { width: `${percent}%` } : undefined}
            />
          </div>
          <div className={styles.progressMeta}>
            <span className={styles.progressText}>
              {phaseLabel}
              {percent != null && ` ${percent.toFixed(0)}%`}
              {elapsedLabel != null && ` (${elapsedLabel})`}
            </span>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={cancel}
              title="中止"
            >
              <X strokeWidth={1.5} size={14} />
            </button>
          </div>
        </div>
      )}

      {status === 'cancelled' && (
        <div className={styles.statusNote}>中止しました</div>
      )}

      {status === 'error' && error && (
        <div className={styles.errorBanner}>
          <div className={styles.errorMessage}>{error}</div>
          <button
            type="button"
            className={styles.retryButton}
            onClick={start}
            disabled={!canStart}
            title="再試行"
          >
            <RotateCw strokeWidth={1.5} size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

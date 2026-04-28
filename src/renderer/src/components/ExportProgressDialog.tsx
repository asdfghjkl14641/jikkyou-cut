import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useExport } from '../hooks/useExport';
import { CheckCircle, AlertCircle } from 'lucide-react';
import styles from './ExportProgressDialog.module.css';

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

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
};

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
};

export default function ExportProgressDialog() {
  const status = useEditorStore((s) => s.exportStatus);
  const progress = useEditorStore((s) => s.exportProgress);
  const result = useEditorStore((s) => s.exportResult);
  const error = useEditorStore((s) => s.exportError);
  const filePath = useEditorStore((s) => s.filePath);
  const reset = useEditorStore((s) => s.resetExportState);

  const { cancel, start } = useExport();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (status === 'idle') {
      ref.current?.close();
    } else {
      if (!ref.current?.open) ref.current?.showModal();
    }
  }, [status]);

  // Auto-close shortly after a cancel so the dialog doesn't linger.
  useEffect(() => {
    if (status === 'cancelled') {
      const t = setTimeout(reset, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [status, reset]);

  if (status === 'idle') return null;

  const projectedOutputName =
    filePath != null
      ? basename(filePath).replace(/\.[^.]+$/, '') + '.cut.mp4'
      : 'output.cut.mp4';

  const handleRetry = () => {
    reset();
    void start();
  };

  const handleReveal = async () => {
    if (result?.outputPath) {
      try {
        await window.api.revealInFolder(result.outputPath);
      } catch (err) {
        console.warn('[export] revealInFolder failed:', err);
      }
    }
  };

  const renderRunning = () => {
    const ratio = Math.min(1, Math.max(0, progress?.ratio ?? 0));
    return (
      <>
        <div className={styles.header}>
          <h2 className={styles.title}>動画を書き出し中</h2>
        </div>
        <div className={styles.body}>
          <div className={styles.fileName}>{projectedOutputName}</div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <div className={styles.progressMeta}>
            {(ratio * 100).toFixed(0)}% (経過{' '}
            {formatHMS(progress?.elapsedSec ?? 0)}
            {progress?.speed != null
              ? `, ${progress.speed.toFixed(1)}x速度`
              : ''}
            )
          </div>
        </div>
        <div className={styles.footer}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            onClick={cancel}
          >
            中止
          </button>
        </div>
      </>
    );
  };

  const renderSuccess = () => (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <CheckCircle strokeWidth={1.5} size={18} className={styles.iconOk} />
          書き出しが完了しました
        </h2>
      </div>
      <div className={styles.body}>
        <div className={styles.successInfo}>
          <div className={styles.successFileName}>
            {result ? basename(result.outputPath) : projectedOutputName}
          </div>
          {result && (
            <div className={styles.meta}>
              {formatHMS(result.durationSec)} ・{' '}
              {formatBytes(result.sizeBytes)}
            </div>
          )}
          {result && (
            <div className={styles.metaPath}>
              {result.outputPath}
            </div>
          )}
        </div>
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.button} onClick={handleReveal}>
          エクスプローラで開く
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={reset}
        >
          OK
        </button>
      </div>
    </>
  );

  const renderError = () => (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <AlertCircle size={18} className={styles.iconError} />
          書き出しエラー
        </h2>
      </div>
      <div className={styles.body}>
        <div className={styles.errorMessage}>
          {error ?? '不明なエラーが発生しました'}
        </div>
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.button} onClick={reset}>
          閉じる
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={handleRetry}
        >
          再試行
        </button>
      </div>
    </>
  );

  const renderCancelled = () => (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>書き出しを中止しました</h2>
      </div>
      <div className={styles.body}>
        <div className={styles.cancelledMessage}>
          中途ファイルは削除されました。
        </div>
      </div>
    </>
  );

  return (
    <dialog ref={ref} className={styles.dialog} onCancel={(e) => e.preventDefault()}>
      {status === 'running' && renderRunning()}
      {status === 'success' && renderSuccess()}
      {status === 'error' && renderError()}
      {status === 'cancelled' && renderCancelled()}
    </dialog>
  );
}

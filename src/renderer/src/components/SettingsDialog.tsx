import { useEffect, useRef, useState } from 'react';
import type { AppConfig } from '../../../common/config';
import styles from './SettingsDialog.module.css';

type Props = {
  open: boolean;
  initial: AppConfig;
  onClose: () => void;
  onSave: (partial: Partial<AppConfig>) => Promise<unknown>;
};

const MODEL_DOWNLOAD_URL = 'https://huggingface.co/ggerganov/whisper.cpp/tree/main';

export default function SettingsDialog({ open, initial, onClose, onSave }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [modelPath, setModelPath] = useState(initial.whisperModelPath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setModelPath(initial.whisperModelPath ?? '');
      setError(null);
      ref.current?.showModal();
    } else {
      ref.current?.close();
    }
  }, [open, initial.whisperModelPath]);

  const handleBrowse = async () => {
    const picked = await window.api.openModelFileDialog();
    if (picked) setModelPath(picked);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ whisperModelPath: modelPath.trim() || null });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>設定</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="閉じる"
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <label className={styles.label} htmlFor="model-path">
            Whisperモデルファイル
          </label>
          <div className={styles.pathRow}>
            <input
              id="model-path"
              type="text"
              className={styles.pathInput}
              value={modelPath}
              onChange={(e) => setModelPath(e.target.value)}
              placeholder="C:\path\to\ggml-large-v3-turbo-q5_0.bin"
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.browseButton}
              onClick={handleBrowse}
            >
              参照...
            </button>
          </div>
          <div className={styles.help}>
            推奨: <code>ggml-large-v3-turbo-q5_0.bin</code> (約 547 MB、日本語精度・速度ともに良好)
            <br />
            軽量お試し用に <code>ggml-base.bin</code> (約 142 MB) も使用可。日本語精度は劣ります。
            <br />
            ダウンロード:{' '}
            <a href={MODEL_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              {MODEL_DOWNLOAD_URL}
            </a>
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.cancelButton} onClick={onClose}>
          キャンセル
        </button>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </dialog>
  );
}

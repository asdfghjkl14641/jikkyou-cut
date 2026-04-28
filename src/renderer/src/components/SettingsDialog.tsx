import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle } from 'lucide-react';
import styles from './SettingsDialog.module.css';

type Props = {
  open: boolean;
  hasApiKey: boolean;
  onClose: () => void;
  onValidateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
  onSaveApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
};

const API_KEY_DOC_URL = 'https://aistudio.google.com/app/apikey';

export default function SettingsDialog({
  open,
  hasApiKey,
  onClose,
  onValidateApiKey,
  onSaveApiKey,
  onClearApiKey,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setKeyInput('');
      setError(null);
      setSaving(false);
      ref.current?.showModal();
    } else {
      ref.current?.close();
    }
  }, [open]);

  const handleSave = async () => {
    const key = keyInput.trim();
    if (!key) {
      setError('APIキーを入力してください');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await onValidateApiKey(key);
      if (!result.valid) {
        setError(result.error ?? 'APIキーが無効です');
        setSaving(false);
        return;
      }
      await onSaveApiKey(key);
      // Drop the key from local component state; never echo back.
      setKeyInput('');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError(null);
    try {
      await onClearApiKey();
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
          disabled={saving}
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <label className={styles.label} htmlFor="api-key">
            Gemini APIキー
          </label>

          {hasApiKey && (
            <div className={styles.statusOk}>
              <CheckCircle size={16} strokeWidth={1.5} className={styles.statusIcon} />
              <span>設定済み</span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleClear}
                disabled={saving}
              >
                削除
              </button>
            </div>
          )}

          <div className={styles.row} style={{ marginTop: hasApiKey ? 12 : 0 }}>
            <input
              id="api-key"
              type="password"
              className={styles.input}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hasApiKey ? '新しいキーを入力して上書き...' : 'AIza...'}
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <div className={styles.help}>
            Google AI Studio で発行できます:{' '}
            <a href={API_KEY_DOC_URL} target="_blank" rel="noreferrer">
              {API_KEY_DOC_URL}
            </a>
            <br />
            キーはOSの資格情報マネージャ(Windowsの場合DPAPI)で暗号化保存されます。
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onClose}
          disabled={saving}
        >
          キャンセル
        </button>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSave}
          disabled={saving || keyInput.trim().length === 0}
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </dialog>
  );
}

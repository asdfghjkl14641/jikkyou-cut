import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle } from 'lucide-react';
import DataCollectionSettings from './DataCollectionSettings';
import styles from './SettingsDialog.module.css';

type Props = {
  open: boolean;
  hasApiKey: boolean;
  hasAnthropicApiKey: boolean;
  onClose: () => void;
  onValidateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
  onSaveApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onValidateAnthropicApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onSaveAnthropicApiKey: (key: string) => Promise<void>;
  onClearAnthropicApiKey: () => Promise<void>;
};

const GLADIA_DOC_URL = 'https://app.gladia.io/';
const ANTHROPIC_DOC_URL = 'https://console.anthropic.com/';

export default function SettingsDialog({
  open,
  hasApiKey,
  hasAnthropicApiKey,
  onClose,
  onValidateApiKey,
  onSaveApiKey,
  onClearApiKey,
  onValidateAnthropicApiKey,
  onSaveAnthropicApiKey,
  onClearAnthropicApiKey,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [gladiaInput, setGladiaInput] = useState('');
  const [gladiaError, setGladiaError] = useState<string | null>(null);
  const [gladiaSaving, setGladiaSaving] = useState(false);
  const [anthInput, setAnthInput] = useState('');
  const [anthError, setAnthError] = useState<string | null>(null);
  const [anthSaving, setAnthSaving] = useState(false);
  const [anthSuccess, setAnthSuccess] = useState(false);

  useEffect(() => {
    if (open) {
      setGladiaInput('');
      setGladiaError(null);
      setGladiaSaving(false);
      setAnthInput('');
      setAnthError(null);
      setAnthSaving(false);
      setAnthSuccess(false);
      ref.current?.showModal();
    } else {
      ref.current?.close();
    }
  }, [open]);

  const handleSaveGladia = async () => {
    const key = gladiaInput.trim();
    if (!key) {
      setGladiaError('APIキーを入力してください');
      return;
    }
    setGladiaSaving(true);
    setGladiaError(null);
    try {
      const result = await onValidateApiKey(key);
      if (!result.valid) {
        setGladiaError(result.error ?? 'APIキーが無効です');
        setGladiaSaving(false);
        return;
      }
      await onSaveApiKey(key);
      setGladiaInput('');
    } catch (err) {
      setGladiaError((err as Error).message);
    } finally {
      setGladiaSaving(false);
    }
  };

  const handleClearGladia = async () => {
    setGladiaSaving(true);
    setGladiaError(null);
    try {
      await onClearApiKey();
    } finally {
      setGladiaSaving(false);
    }
  };

  const handleSaveAnth = async () => {
    const key = anthInput.trim();
    if (!key) {
      setAnthError('APIキーを入力してください');
      return;
    }
    setAnthSaving(true);
    setAnthError(null);
    setAnthSuccess(false);
    try {
      const result = await onValidateAnthropicApiKey(key);
      if (!result.ok) {
        setAnthError(result.error ?? 'APIキーが無効です');
        setAnthSaving(false);
        return;
      }
      await onSaveAnthropicApiKey(key);
      setAnthInput('');
      setAnthSuccess(true);
    } catch (err) {
      setAnthError((err as Error).message);
    } finally {
      setAnthSaving(false);
    }
  };

  const handleClearAnth = async () => {
    setAnthSaving(true);
    setAnthError(null);
    try {
      await onClearAnthropicApiKey();
      setAnthSuccess(false);
    } finally {
      setAnthSaving(false);
    }
  };

  const anySaving = gladiaSaving || anthSaving;

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
          disabled={anySaving}
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className={styles.body}>
        {/* Gladia (transcription) */}
        <div className={styles.section}>
          <label className={styles.label} htmlFor="api-key">
            Gladia APIキー(文字起こし用)
          </label>

          {hasApiKey && (
            <div className={styles.statusOk}>
              <CheckCircle size={16} strokeWidth={1.5} className={styles.statusIcon} />
              <span>設定済み</span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleClearGladia}
                disabled={anySaving}
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
              value={gladiaInput}
              onChange={(e) => setGladiaInput(e.target.value)}
              placeholder={hasApiKey ? '新しいキーを入力して上書き...' : 'Gladia API key'}
              spellCheck={false}
              autoComplete="off"
              disabled={anySaving}
            />
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleSaveGladia}
              disabled={anySaving || gladiaInput.trim().length === 0}
              style={{ marginLeft: 8 }}
            >
              {gladiaSaving ? '保存中...' : '保存'}
            </button>
          </div>
          <div className={styles.help}>
            Gladia ダッシュボードで発行できます:{' '}
            <a href={GLADIA_DOC_URL} target="_blank" rel="noreferrer">
              {GLADIA_DOC_URL}
            </a>
            <br />
            キーはOSの資格情報マネージャ(Windowsの場合DPAPI)で暗号化保存されます。
          </div>
          {gladiaError && <div className={styles.error}>{gladiaError}</div>}
        </div>

        {/* Anthropic (AI title summarisation) */}
        <div className={styles.section}>
          <label className={styles.label} htmlFor="anthropic-key">
            Anthropic APIキー(AI タイトル生成用)
          </label>

          {hasAnthropicApiKey && (
            <div className={styles.statusOk}>
              <CheckCircle size={16} strokeWidth={1.5} className={styles.statusIcon} />
              <span>設定済み</span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleClearAnth}
                disabled={anySaving}
              >
                削除
              </button>
            </div>
          )}

          <div className={styles.row} style={{ marginTop: hasAnthropicApiKey ? 12 : 0 }}>
            <input
              id="anthropic-key"
              type="password"
              className={styles.input}
              value={anthInput}
              onChange={(e) => setAnthInput(e.target.value)}
              placeholder={hasAnthropicApiKey ? '新しいキーを入力して上書き...' : 'sk-ant-...'}
              spellCheck={false}
              autoComplete="off"
              disabled={anySaving}
            />
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleSaveAnth}
              disabled={anySaving || anthInput.trim().length === 0}
              style={{ marginLeft: 8 }}
            >
              {anthSaving ? '検証中...' : '保存'}
            </button>
          </div>
          <div className={styles.help}>
            Anthropic Console で発行できます:{' '}
            <a href={ANTHROPIC_DOC_URL} target="_blank" rel="noreferrer">
              {ANTHROPIC_DOC_URL}
            </a>
            <br />
            切り抜き区間のタイトル自動生成に使われます(Claude Haiku 4.5)。設定しなくても他機能には影響しません。
          </div>
          {anthError && <div className={styles.error}>{anthError}</div>}
          {anthSuccess && <div className={styles.statusOk} style={{ marginTop: 8 }}>
            <CheckCircle size={14} strokeWidth={1.5} className={styles.statusIcon} />
            <span>キーを検証して保存しました</span>
          </div>}
        </div>

        {/* Data-collection pipeline (Phase 1) — its own bordered block. */}
        <DataCollectionSettings />
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onClose}
          disabled={anySaving}
        >
          閉じる
        </button>
      </div>
    </dialog>
  );
}

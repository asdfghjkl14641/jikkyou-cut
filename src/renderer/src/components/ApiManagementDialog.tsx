import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle, Edit2, Trash2, Plus, KeyRound, FileText } from 'lucide-react';
import CollectionLogViewer from './CollectionLogViewer';
import styles from './ApiManagementDialog.module.css';

// Centralised API-key management screen. Hosts:
//   * Gladia key (transcription, single)
//   * Anthropic key (AI title summarisation, single)
//   * YouTube Data API keys (data collection, multi up to 10)
//   * Per-key YouTube quota breakdown
//
// Reachable from menu "API 管理" / Ctrl+Shift+A. Replaces the API-key
// sections that previously lived inside SettingsDialog.

const MAX_YT_KEYS = 10;
const YT_DAILY_QUOTA_PER_KEY = 10_000;

type Tab = 'keys' | 'log';

type Props = {
  open: boolean;
  onClose: () => void;
  // Existing API key handlers — passed through from App.tsx so we
  // re-use the validation paths from useSettings without duplicating
  // them here.
  hasGladia: boolean;
  hasAnthropic: boolean;
  onValidateGladia: (key: string) => Promise<{ valid: boolean; error?: string }>;
  onSaveGladia: (key: string) => Promise<void>;
  onClearGladia: () => Promise<void>;
  onValidateAnthropic: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onSaveAnthropic: (key: string) => Promise<void>;
  onClearAnthropic: () => Promise<void>;
};

export default function ApiManagementDialog({
  open,
  onClose,
  hasGladia,
  hasAnthropic,
  onValidateGladia,
  onSaveGladia,
  onClearGladia,
  onValidateAnthropic,
  onSaveAnthropic,
  onClearAnthropic,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('keys');

  useEffect(() => {
    if (open) {
      ref.current?.showModal();
      setTab('keys');
    } else {
      ref.current?.close();
    }
  }, [open]);

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} onCancel={onClose}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <KeyRound size={18} />
          API 管理
        </h2>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="閉じる">
          <X size={18} />
        </button>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'keys' ? styles.tabActive : ''}`}
          onClick={() => setTab('keys')}
        >
          <KeyRound size={13} />
          API キー
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'log' ? styles.tabActive : ''}`}
          onClick={() => setTab('log')}
        >
          <FileText size={13} />
          収集ログ
        </button>
      </div>

      <div className={styles.body}>
        {tab === 'keys' ? (
          <KeysTab
            hasGladia={hasGladia}
            hasAnthropic={hasAnthropic}
            onValidateGladia={onValidateGladia}
            onSaveGladia={onSaveGladia}
            onClearGladia={onClearGladia}
            onValidateAnthropic={onValidateAnthropic}
            onSaveAnthropic={onSaveAnthropic}
            onClearAnthropic={onClearAnthropic}
          />
        ) : (
          <CollectionLogViewer />
        )}
      </div>
    </dialog>
  );
}

// ===========================================================================
// API キー タブ
// ===========================================================================

function KeysTab(props: {
  hasGladia: boolean;
  hasAnthropic: boolean;
  onValidateGladia: (key: string) => Promise<{ valid: boolean; error?: string }>;
  onSaveGladia: (key: string) => Promise<void>;
  onClearGladia: () => Promise<void>;
  onValidateAnthropic: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onSaveAnthropic: (key: string) => Promise<void>;
  onClearAnthropic: () => Promise<void>;
}) {
  return (
    <div className={styles.keysTab}>
      <SingleKeySection
        title="Gladia(文字起こし)"
        docUrl="https://app.gladia.io/"
        registered={props.hasGladia}
        onValidate={async (k) => {
          const r = await props.onValidateGladia(k);
          return { ok: r.valid, error: r.error };
        }}
        onSave={props.onSaveGladia}
        onClear={props.onClearGladia}
      />
      <SingleKeySection
        title="Anthropic(AI タイトル要約)"
        docUrl="https://console.anthropic.com/"
        registered={props.hasAnthropic}
        onValidate={props.onValidateAnthropic}
        onSave={props.onSaveAnthropic}
        onClear={props.onClearAnthropic}
      />
      <YoutubeKeysSection />
    </div>
  );
}

// ---- Single-key section (Gladia / Anthropic) ------------------------------

function SingleKeySection(props: {
  title: string;
  docUrl: string;
  registered: boolean;
  onValidate: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    const key = draft.trim();
    if (!key) {
      setError('APIキーを入力してください');
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const v = await props.onValidate(key);
      if (!v.ok) {
        setError(v.error ?? 'APIキーが無効です');
        return;
      }
      await props.onSave(key);
      setDraft('');
      setEditing(false);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm(`${props.title} のキーを削除しますか?`)) return;
    setBusy(true);
    try {
      await props.onClear();
      setSuccess(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.keySection}>
      <div className={styles.keySectionHeader}>
        <h3 className={styles.keySectionTitle}>{props.title}</h3>
        <div className={styles.keySectionStatus}>
          {props.registered ? (
            <span className={styles.statusOk}>
              <CheckCircle size={13} />
              登録済み
            </span>
          ) : (
            <span className={styles.statusMuted}>未登録</span>
          )}
        </div>
        <div className={styles.keySectionActions}>
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => setEditing((v) => !v)}
            disabled={busy}
          >
            <Edit2 size={12} />
            {editing ? '閉じる' : '編集'}
          </button>
          {props.registered && (
            <button
              type="button"
              className={`${styles.smallButton} ${styles.smallButtonDanger}`}
              onClick={handleClear}
              disabled={busy}
            >
              <Trash2 size={12} />
              削除
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className={styles.editRow}>
          <input
            type="password"
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={props.registered ? '新しいキーで上書き...' : 'APIキーを入力'}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleSave}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? '検証中...' : '検証 + 保存'}
          </button>
        </div>
      )}

      <div className={styles.help}>
        発行元: <a href={props.docUrl} target="_blank" rel="noreferrer">{props.docUrl}</a>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {success && (
        <div className={styles.successInline}>
          <CheckCircle size={12} />
          検証して保存しました
        </div>
      )}
    </section>
  );
}

// ---- YouTube multi-key section --------------------------------------------

type QuotaRow = { keyIndex: number; unitsUsed: number };

function YoutubeKeysSection() {
  const [keyCount, setKeyCount] = useState(0);
  const [quota, setQuota] = useState<QuotaRow[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load + 5-second poll for live quota visibility.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [c, q] = await Promise.all([
          window.api.youtubeApiKeys.getKeyCount(),
          window.api.collectionLog.getQuotaPerKey(),
        ]);
        if (!alive) return;
        setKeyCount(c);
        setQuota(q);
      } catch {
        // ignore — UI tolerates a missed poll
      }
    };
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  const totalUsed = quota.reduce((acc, r) => acc + r.unitsUsed, 0);
  const totalCap = keyCount * YT_DAILY_QUOTA_PER_KEY;

  const handleSave = async () => {
    setError(null);
    const cleaned = draft.map((k) => k.trim()).filter((k) => k.length > 0);
    if (cleaned.length === 0) {
      setError('少なくとも 1 つのキーを入力してください');
      return;
    }
    setBusy(true);
    try {
      await window.api.youtubeApiKeys.setKeys(cleaned);
      setDraft(['']);
      setEditing(false);
      setKeyCount(await window.api.youtubeApiKeys.getKeyCount());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm(`登録されている YouTube API キー ${keyCount} 個を全て削除しますか?`)) return;
    setBusy(true);
    try {
      await window.api.youtubeApiKeys.clear();
      setKeyCount(0);
      setQuota([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.keySection}>
      <div className={styles.keySectionHeader}>
        <h3 className={styles.keySectionTitle}>YouTube Data API(データ収集、最大 {MAX_YT_KEYS})</h3>
        <div className={styles.keySectionStatus}>
          <span className={keyCount > 0 ? styles.statusOk : styles.statusMuted}>
            {keyCount > 0 ? `${keyCount} 件登録済み` : '未登録'}
          </span>
        </div>
        <div className={styles.keySectionActions}>
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => setEditing((v) => !v)}
            disabled={busy}
          >
            <Edit2 size={12} />
            {editing ? '閉じる' : 'キー一覧を編集'}
          </button>
          {keyCount > 0 && (
            <button
              type="button"
              className={`${styles.smallButton} ${styles.smallButtonDanger}`}
              onClick={handleClear}
              disabled={busy}
            >
              <Trash2 size={12} />
              全削除
            </button>
          )}
        </div>
      </div>

      {keyCount > 0 && (
        <div className={styles.quotaPanel}>
          <div className={styles.quotaSummary}>
            本日のクォータ消費:&nbsp;
            <span className={styles.quotaTotal}>{totalUsed.toLocaleString()}</span>
            &nbsp;/&nbsp;
            <span>{totalCap.toLocaleString()}</span>
          </div>
          <div className={styles.quotaBars}>
            {Array.from({ length: keyCount }).map((_, i) => {
              const used = quota.find((q) => q.keyIndex === i)?.unitsUsed ?? 0;
              const pct = Math.min(100, (used / YT_DAILY_QUOTA_PER_KEY) * 100);
              return (
                <div key={i} className={styles.quotaBarRow}>
                  <span className={styles.quotaBarLabel}>キー {i + 1}</span>
                  <div className={styles.quotaBar}>
                    <div className={styles.quotaBarFill} style={{ width: `${pct}%` }} />
                  </div>
                  <span className={styles.quotaBarValue}>
                    {used.toLocaleString()} / {YT_DAILY_QUOTA_PER_KEY.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editing && (
        <div className={styles.multiKeyEditor}>
          {draft.map((key, i) => (
            <div key={i} className={styles.multiKeyRow}>
              <input
                type="password"
                className={styles.input}
                value={key}
                onChange={(e) =>
                  setDraft((prev) => {
                    const next = [...prev];
                    next[i] = e.target.value;
                    return next;
                  })
                }
                placeholder={`キー ${i + 1}`}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => setDraft((prev) => prev.filter((_, idx) => idx !== i))}
                disabled={busy || draft.length === 1}
                title="この行を削除"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className={styles.multiKeyActions}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() =>
                setDraft((prev) => (prev.length >= MAX_YT_KEYS ? prev : [...prev, '']))
              }
              disabled={busy || draft.length >= MAX_YT_KEYS}
            >
              <Plus size={12} />
              キーを追加
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSave}
              disabled={busy || draft.every((k) => !k.trim())}
            >
              {busy ? '保存中...' : '全て保存(既存を上書き)'}
            </button>
          </div>
        </div>
      )}

      <div className={styles.help}>
        Google Cloud Console で YouTube Data API v3 を有効化して発行。1 キーあたり 1 日 {YT_DAILY_QUOTA_PER_KEY.toLocaleString()} unit、複数キーで分散すると収集量が増えます。
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </section>
  );
}

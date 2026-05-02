import { useEffect, useState } from 'react';
import { ChevronLeft, CheckCircle, Edit2, Trash2, Plus, X, KeyRound, FileText } from 'lucide-react';
import CollectionLogViewer from './CollectionLogViewer';
import { useEditorStore } from '../store/editorStore';
import styles from './ApiManagementView.module.css';

// Full-screen API management screen. Replaces the previous
// `ApiManagementDialog` modal — same content, but mounted as a top-
// level phase so the user gets a complete screen swap (matching the
// load / clip-select / edit pattern).
//
// Internals (KeysTab / SingleKeySection / YoutubeKeysSection) are
// straight ports from the dialog; only the outer chrome changes.
//
// Reachable from menu "API 管理" / Ctrl+Shift+A. The store's
// openApiManagement() / closeApiManagement() handle the phase swap.

// Bumped 10 → 50 (2026-05-03). Heavy users can hold 30+ keys for
// quota rotation; the previous 10-row UI cap was the actual cause of
// the "30 keys saved → only some persist" report — the editor never
// let the user input beyond row 10. Defensive cap on the storage side
// is `YT_KEYS_JSON_MAX_BYTES` (100 KB ≈ 1500 keys) in secureStorage.
const MAX_YT_KEYS = 50;
const YT_DAILY_QUOTA_PER_KEY = 10_000;

type Tab = 'keys' | 'log';

type Props = {
  hasGladia: boolean;
  hasAnthropic: boolean;
  onValidateGladia: (key: string) => Promise<{ valid: boolean; error?: string }>;
  onSaveGladia: (key: string) => Promise<void>;
  onClearGladia: () => Promise<void>;
  onValidateAnthropic: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onSaveAnthropic: (key: string) => Promise<void>;
  onClearAnthropic: () => Promise<void>;
};

export default function ApiManagementView({
  hasGladia,
  hasAnthropic,
  onValidateGladia,
  onSaveGladia,
  onClearGladia,
  onValidateAnthropic,
  onSaveAnthropic,
  onClearAnthropic,
}: Props) {
  const [tab, setTab] = useState<Tab>('keys');
  const closeApiManagement = useEditorStore((s) => s.closeApiManagement);

  // Esc anywhere on the screen → back to previous phase. We listen on
  // window so it works regardless of which inner element has focus.
  // Inputs that intercept Escape (rare for our forms) can stop
  // propagation if needed; nothing currently does.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't close if the user is typing in an input/textarea — they
      // probably meant to abort an edit, not leave the screen.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      closeApiManagement();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeApiManagement]);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button type="button" className={styles.backButton} onClick={closeApiManagement}>
            <ChevronLeft size={18} />
            戻る
          </button>
          <h1 className={styles.title}>
            <KeyRound size={18} />
            API 管理
          </h1>
        </div>
      </header>

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

      <main className={styles.body}>
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
          // The viewer lives inside a flex:1 container, so its
          // CollectionLogViewer's `flex:1; min-height:0` chain reaches
          // the screen edge automatically.
          <CollectionLogViewer />
        )}
      </main>
    </div>
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
    // Diagnostic log so we can correlate with [secureStorage] entries
    // when investigating "key count drops on reload" reports. We only
    // log counts, not the keys themselves.
    console.log(`[ApiManagement] saving ${cleaned.length} YouTube keys (draft rows: ${draft.length})`);
    setBusy(true);
    try {
      await window.api.youtubeApiKeys.setKeys(cleaned);
      const reloadCount = await window.api.youtubeApiKeys.getKeyCount();
      console.log(`[ApiManagement] save complete; getKeyCount=${reloadCount}`);
      setDraft(['']);
      setEditing(false);
      setKeyCount(reloadCount);
    } catch (err) {
      console.warn('[ApiManagement] save failed:', err);
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
          <div className={styles.multiKeyRows}>
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
          </div>
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
              キーを追加({draft.length} / {MAX_YT_KEYS})
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

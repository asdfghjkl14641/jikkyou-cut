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
  // Existing saved keys (loaded on edit-mode entry). Read-only here:
  // the user can mark them for removal via × but cannot edit in place.
  // The previous design seeded these into password inputs, where the
  // user could not visually distinguish a pre-filled row from an empty
  // one and ended up overwriting their existing keys.
  const [existing, setExisting] = useState<string[]>([]);
  const [removeMask, setRemoveMask] = useState<boolean[]>([]);
  // Brand-new keys typed during this edit session. Always at least one
  // empty row so the input is visible.
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

  // Load existing keys when entering edit mode. They go into a
  // separate `existing` list (not into draft) so the user cannot
  // accidentally overwrite them by typing into a masked password
  // field. The IPC `getKeys` returns plaintext (deliberate; see
  // common/types.ts comment).
  useEffect(() => {
    if (!editing) {
      setExisting([]);
      setRemoveMask([]);
      setDraft(['']);
      return;
    }
    let alive = true;
    void window.api.youtubeApiKeys.getKeys().then((keys) => {
      if (!alive) return;
      setExisting(keys);
      setRemoveMask(new Array(keys.length).fill(false));
      setDraft(['']);
    }).catch(() => {
      // ignore — error display reserved for save failures
    });
    return () => { alive = false; };
  }, [editing]);

  const totalUsed = quota.reduce((acc, r) => acc + r.unitsUsed, 0);
  const totalCap = keyCount * YT_DAILY_QUOTA_PER_KEY;

  const keptCount = existing.filter((_, i) => !removeMask[i]).length;
  const newCount = draft.map((k) => k.trim()).filter((k) => k.length > 0).length;
  const finalCount = keptCount + newCount;
  const canAddDraftRow = !busy && existing.length + draft.length < MAX_YT_KEYS;

  // Mask middle of a key for safe display. Standard YouTube keys are
  // 39 chars — keeping first 6 + last 4 lets the user disambiguate
  // multiple keys without leaking the secret to a screenshot.
  const maskKey = (key: string): string => {
    if (key.length <= 12) return '•'.repeat(key.length);
    return `${key.slice(0, 6)}${'•'.repeat(Math.min(key.length - 10, 12))}${key.slice(-4)}`;
  };

  const handleSave = async () => {
    setError(null);
    const kept = existing.filter((_, i) => !removeMask[i]);
    const newOnes = draft.map((k) => k.trim()).filter((k) => k.length > 0);
    // Dedupe in case the user pastes a key that's already saved.
    const merged = Array.from(new Set([...kept, ...newOnes]));
    if (merged.length === 0) {
      setError('少なくとも 1 つのキーが必要です');
      return;
    }
    setBusy(true);
    try {
      await window.api.youtubeApiKeys.setKeys(merged);
      const reloadCount = await window.api.youtubeApiKeys.getKeyCount();
      setExisting([]);
      setRemoveMask([]);
      setDraft(['']);
      setEditing(false);
      setKeyCount(reloadCount);
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
          {existing.length > 0 && (
            <div className={styles.existingKeyList}>
              <div className={styles.existingKeyHeader}>
                登録済み({keptCount} / {existing.length} 個を保持)
              </div>
              {existing.map((k, i) => {
                const removed = removeMask[i];
                return (
                  <div
                    key={i}
                    className={`${styles.existingKeyRow} ${removed ? styles.existingKeyRowRemoved : ''}`}
                  >
                    <span className={styles.existingKeyLabel}>キー {i + 1}</span>
                    <code className={styles.existingKeyValue}>{maskKey(k)}</code>
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() =>
                        setRemoveMask((prev) => {
                          const next = [...prev];
                          next[i] = !next[i];
                          return next;
                        })
                      }
                      disabled={busy}
                      title={removed ? '削除を取り消す' : 'このキーを保存時に削除'}
                    >
                      {removed ? '取消' : <X size={12} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className={styles.newKeySection}>
            <div className={styles.newKeyHeader}>
              {existing.length > 0 ? '新しいキーを追加' : '新しいキー'}
            </div>
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
                    placeholder="AIza... で始まる新規キー"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className={styles.smallButton}
                    onClick={() =>
                      setDraft((prev) => {
                        const next = prev.filter((_, idx) => idx !== i);
                        return next.length === 0 ? [''] : next;
                      })
                    }
                    disabled={busy || draft.length === 1}
                    title="この行を削除"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.multiKeyActions}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() =>
                setDraft((prev) => {
                  if (existing.length + prev.length >= MAX_YT_KEYS) return prev;
                  return [...prev, ''];
                })
              }
              disabled={!canAddDraftRow}
            >
              <Plus size={12} />
              新規行を追加(現在 {existing.length + draft.length} / {MAX_YT_KEYS})
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSave}
              disabled={busy || finalCount === 0}
            >
              {busy ? '保存中...' : `保存(合計 ${finalCount} 個)`}
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

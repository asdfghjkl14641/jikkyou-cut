import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  CheckCircle,
  Edit2,
  Trash2,
  Plus,
  X,
  KeyRound,
  FileText,
  Database,
  ShieldAlert,
  FolderOpen,
  Download,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import type {
  ApiKeysBackupStatus,
  ApiKeysImportPlan,
} from '../../../common/types';
import CollectionLogViewer from './CollectionLogViewer';
import DataCollectionSettings from './DataCollectionSettings';
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

type Tab = 'keys' | 'collection' | 'log';

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
          className={`${styles.tab} ${tab === 'collection' ? styles.tabActive : ''}`}
          onClick={() => setTab('collection')}
        >
          <Database size={13} />
          データ収集
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
        {tab === 'keys' && (
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
        )}
        {tab === 'collection' && (
          // Hosts the same DataCollectionSettings the user used to find
          // hidden in the Settings dialog — moved here so the data-
          // collection controls (有効化 / 1 回だけ取得 / 取得を停止)
          // sit alongside the API keys + collection log tabs that
          // they're conceptually grouped with.
          <div className={styles.collectionTab}>
            <DataCollectionSettings />
          </div>
        )}
        {tab === 'log' && (
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
  // 2026-05-04 — bumping `bumpStatus` re-fetches the backup status
  // banner. We pass it down to import/export so a successful import or
  // any saveSecret round-trip refreshes the "最終バックアップ" line
  // without forcing a reload.
  const [statusBump, setStatusBump] = useState(0);
  const bumpStatus = useCallback(() => setStatusBump((n) => n + 1), []);

  return (
    <div className={styles.keysTab}>
      <BackupSection statusBump={statusBump} />
      <ImportExportSection onChanged={bumpStatus} />
      <SingleKeySection
        title="Gladia(文字起こし)"
        docUrl="https://app.gladia.io/"
        registered={props.hasGladia}
        onValidate={async (k) => {
          const r = await props.onValidateGladia(k);
          return { ok: r.valid, error: r.error };
        }}
        onSave={async (k) => {
          await props.onSaveGladia(k);
          bumpStatus();
        }}
        onClear={async () => {
          await props.onClearGladia();
          bumpStatus();
        }}
      />
      <SingleKeySection
        title="Anthropic(AI タイトル要約)"
        docUrl="https://console.anthropic.com/"
        registered={props.hasAnthropic}
        onValidate={props.onValidateAnthropic}
        onSave={async (k) => {
          await props.onSaveAnthropic(k);
          bumpStatus();
        }}
        onClear={async () => {
          await props.onClearAnthropic();
          bumpStatus();
        }}
      />
      <YoutubeKeysSection onChanged={bumpStatus} refreshTrigger={statusBump} />
      <GeminiKeysSection onChanged={bumpStatus} refreshTrigger={statusBump} />
    </div>
  );
}

// ===========================================================================
// 🔒 Backup status + folder access
// ===========================================================================

function BackupSection(props: { statusBump: number }) {
  const [status, setStatus] = useState<ApiKeysBackupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.apiKeysBackup.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [props.statusBump]);

  const fmt = (iso: string | null): string => {
    if (!iso) return '未生成';
    try {
      const d = new Date(iso);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return iso;
    }
  };

  const counts = status?.counts;
  // Always render every slot so a "0 個" / "(なし)" jumps out — the
  // user explicitly asked the saved-state visibility to be obvious.
  const slotChips = counts
    ? [
        { label: 'Gemini', value: counts.gemini > 0 ? `${counts.gemini} 個` : '0 個', filled: counts.gemini > 0 },
        { label: 'YouTube', value: counts.youtube > 0 ? `${counts.youtube} 個` : '0 個', filled: counts.youtube > 0 },
        { label: 'Gladia', value: counts.gladia ? '✓' : '—', filled: counts.gladia },
        { label: 'Anthropic', value: counts.anthropic ? '✓' : '—', filled: counts.anthropic },
        { label: 'Twitch', value: counts.twitchClientSecret ? '✓' : '—', filled: counts.twitchClientSecret },
      ]
    : [];

  return (
    <section className={styles.backupSection}>
      <div className={styles.backupHeader}>
        <h3 className={styles.backupTitle}>
          <ShieldAlert size={14} />
          API キー バックアップ
        </h3>
        <button
          type="button"
          className={styles.smallButton}
          onClick={() => window.api.apiKeysBackup.revealFile()}
          disabled={!status}
        >
          <FolderOpen size={12} />
          場所を開く
        </button>
      </div>
      <div className={styles.backupBody}>
        <div className={styles.backupRow}>
          <span className={styles.backupLabel}>場所:</span>
          <code className={styles.backupPath}>{status?.filePath ?? '...'}</code>
        </div>
        <div className={styles.backupRow}>
          <span className={styles.backupLabel}>最終バックアップ:</span>
          <span>{fmt(status?.lastBackupAt ?? null)}</span>
        </div>
        {slotChips.length > 0 && (
          <div className={styles.backupRow}>
            <span className={styles.backupLabel}>保存中のキー:</span>
            <span className={styles.slotChips}>
              {slotChips.map((c) => (
                <span
                  key={c.label}
                  className={c.filled ? styles.slotChipOk : styles.slotChipEmpty}
                >
                  {c.label}: {c.value}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
      <div className={styles.backupWarning}>
        <AlertTriangle size={12} />
        平文バックアップは暗号化されていません。他人と共有しない、外部にアップロードしないでください。1Password / Bitwarden 等の安全な場所への追加コピーを推奨します。
      </div>
    </section>
  );
}

// ===========================================================================
// 🔄 Import / export
// ===========================================================================

function ImportExportSection(props: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [importPreview, setImportPreview] = useState<{
    filePath: string;
    plan: ApiKeysImportPlan;
  } | null>(null);

  const handleExport = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await window.api.apiKeysBackup.exportToFile();
      if (!r.ok) {
        if (!('canceled' in r) || !r.canceled) {
          setMessage({ kind: 'err', text: r.error ?? 'エクスポートに失敗しました' });
        }
        return;
      }
      const c = r.counts;
      const total =
        c.gemini + c.youtube + (c.gladia ? 1 : 0) + (c.anthropic ? 1 : 0)
        + (c.twitchClientId ? 1 : 0) + (c.twitchClientSecret ? 1 : 0);
      setMessage({ kind: 'ok', text: `${total} 個のキーをエクスポートしました: ${r.filePath}` });
    } finally {
      setBusy(false);
    }
  };

  const handleImportPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await window.api.apiKeysBackup.importPreview();
      if (!r.ok) {
        if (!('canceled' in r) || !r.canceled) {
          setMessage({ kind: 'err', text: r.error ?? 'インポートのプレビューに失敗しました' });
        }
        return;
      }
      setImportPreview({ filePath: r.filePath, plan: r.plan });
    } finally {
      setBusy(false);
    }
  };

  const handleImportApply = async (mode: 'merge' | 'replace') => {
    if (!importPreview) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await window.api.apiKeysBackup.importApply({
        filePath: importPreview.filePath,
        mode,
      });
      if (!r.ok) {
        setMessage({ kind: 'err', text: r.error });
        return;
      }
      const total = r.applied.reduce((sum, x) => sum + x.count, 0);
      setMessage({ kind: 'ok', text: `${total} 個のキーをインポートしました(${r.applied.length} スロット)` });
      setImportPreview(null);
      props.onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.importExportSection}>
      <div className={styles.importExportHeader}>
        <h3 className={styles.backupTitle}>
          <Download size={14} />
          インポート / エクスポート
        </h3>
      </div>
      <div className={styles.importExportButtons}>
        <button
          type="button"
          className={styles.smallButton}
          onClick={handleExport}
          disabled={busy}
        >
          <Download size={12} />
          全 API キーをエクスポート
        </button>
        <button
          type="button"
          className={styles.smallButton}
          onClick={handleImportPreview}
          disabled={busy}
        >
          <Upload size={12} />
          JSON からインポート
        </button>
      </div>
      <div className={styles.help}>
        別 PC への移行 / バックアップからの復元 / 大量キー一括登録 用です。
        エクスポート JSON は平文を含みます。
      </div>
      {message && (
        <div className={message.kind === 'ok' ? styles.successInline : styles.error}>
          {message.text}
        </div>
      )}
      {importPreview && (
        <ImportPreviewDialog
          filePath={importPreview.filePath}
          plan={importPreview.plan}
          busy={busy}
          onApply={handleImportApply}
          onCancel={() => setImportPreview(null)}
        />
      )}
    </section>
  );
}

function ImportPreviewDialog(props: {
  filePath: string;
  plan: ApiKeysImportPlan;
  busy: boolean;
  onApply: (mode: 'merge' | 'replace') => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const p = props.plan;

  const arrRow = (label: string, slot: { incoming: number; current: number }) => (
    <div className={styles.importRow}>
      <span className={styles.importRowLabel}>{label}</span>
      <span className={styles.importRowValue}>
        {slot.incoming} 個{slot.current > 0 && ` (現在 ${slot.current})`}
      </span>
    </div>
  );
  const boolRow = (label: string, slot: { incoming: boolean; current: boolean }) => (
    <div className={styles.importRow}>
      <span className={styles.importRowLabel}>{label}</span>
      <span className={styles.importRowValue}>
        {slot.incoming ? (slot.current ? '上書き' : '追加') : '(なし)'}
      </span>
    </div>
  );

  return (
    <div className={styles.importDialogBackdrop}>
      <div className={styles.importDialog}>
        <h3 className={styles.importDialogTitle}>インポート内容の確認</h3>
        <div className={styles.importDialogPath}>{props.filePath}</div>

        <div className={styles.importPlanBox}>
          {arrRow('Gemini', p.gemini)}
          {arrRow('YouTube', p.youtube)}
          {boolRow('Gladia', p.gladia)}
          {boolRow('Anthropic', p.anthropic)}
          <div className={styles.importRow}>
            <span className={styles.importRowLabel}>Twitch Client ID</span>
            <span className={styles.importRowValue}>
              {p.twitchClientId.incoming ? (p.twitchClientId.current ? '上書き' : '追加') : '(なし)'}
            </span>
          </div>
          {boolRow('Twitch Client Secret', p.twitchClientSecret)}
        </div>

        {p.invalid.length > 0 && (
          <div className={styles.importInvalidBox}>
            <strong>形式不正でスキップ: {p.invalid.length} 件</strong>
            <ul>
              {p.invalid.slice(0, 5).map((x, i) => (
                <li key={i}>{x.slot}: {x.reason}</li>
              ))}
              {p.invalid.length > 5 && <li>... 他 {p.invalid.length - 5} 件</li>}
            </ul>
          </div>
        )}

        <div className={styles.importModeBox}>
          <label className={styles.importModeRow}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
              disabled={props.busy}
            />
            既存に追加(マージ) — 重複は除外
          </label>
          <label className={styles.importModeRow}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
              disabled={props.busy}
            />
            完全に置き換え — 既存キーは破棄
          </label>
        </div>

        <div className={styles.importDialogActions}>
          <button
            type="button"
            className={styles.smallButton}
            onClick={props.onCancel}
            disabled={props.busy}
          >
            キャンセル
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => props.onApply(mode)}
            disabled={props.busy}
          >
            {props.busy ? '適用中...' : 'インポート'}
          </button>
        </div>
      </div>
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

function YoutubeKeysSection(props: { onChanged?: () => void; refreshTrigger?: number }) {
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
  }, [props.refreshTrigger]);

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
      props.onChanged?.();
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
      props.onChanged?.();
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

// ---- Gemini multi-key section --------------------------------------------
// Mirrors YouTube's quota-panel pattern — always-visible per-key bars
// with a per-row delete button. The add flow is simpler than YouTube's
// (single input + immediate save instead of batch edit) since Gemini
// keys are typically added one at a time from AI Studio.

const MAX_GEMINI_KEYS = 50;
const GEMINI_USAGE_REFRESH_MS = 30_000;

type GeminiUsageRow = {
  keyHash: string;
  todayCount: number;
  todayLimit: number;
  lastError: string | null;
};

function geminiKeyStatus(usage: GeminiUsageRow): { label: string; color: 'green' | 'yellow' | 'red' } {
  if (usage.lastError) {
    return { label: '🔴 一時的に利用不可', color: 'red' };
  }
  const ratio = usage.todayLimit > 0 ? usage.todayCount / usage.todayLimit : 0;
  if (ratio >= 1.0) return { label: '🔴 上限達成', color: 'red' };
  if (ratio >= 0.9) return { label: '⚠ もうすぐ上限', color: 'yellow' };
  return { label: '● 利用可能', color: 'green' };
}

function GeminiKeysSection(props: { onChanged?: () => void; refreshTrigger?: number }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [usages, setUsages] = useState<GeminiUsageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load + periodic usage refresh. The keys themselves change
  // only on add/remove (we re-fetch in those handlers explicitly), so
  // the interval is for usage counters drifting forward as the user
  // runs analyses.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [k, u] = await Promise.all([
          window.api.gemini.getKeys(),
          window.api.gemini.getKeyUsages(),
        ]);
        if (!alive) return;
        setKeys(k);
        setUsages(u);
      } catch {
        // ignore — UI tolerates a missed poll
      }
    };
    void refresh();
    const interval = setInterval(refresh, GEMINI_USAGE_REFRESH_MS);
    return () => { alive = false; clearInterval(interval); };
  }, [props.refreshTrigger]);

  // Mask middle of a key for safe display. Gemini keys are usually 39
  // chars (AIzaSy + 33 chars); 6 + 4 visible matches YouTube's row.
  const maskKey = (key: string): string => {
    if (key.length <= 12) return '•'.repeat(key.length);
    return `${key.slice(0, 6)}${'•'.repeat(Math.min(key.length - 10, 12))}${key.slice(-4)}`;
  };

  const handleAddKey = async () => {
    setError(null);
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('キーを入力してください');
      return;
    }
    if (keys.includes(trimmed)) {
      setError('既に登録されているキーです');
      return;
    }
    if (keys.length >= MAX_GEMINI_KEYS) {
      setError(`キー数が上限(${MAX_GEMINI_KEYS} 件)に達しています`);
      return;
    }
    setBusy(true);
    try {
      const next = [...keys, trimmed];
      await window.api.gemini.setKeys(next);
      setDraft('');
      const [reloaded, u] = await Promise.all([
        window.api.gemini.getKeys(),
        window.api.gemini.getKeyUsages(),
      ]);
      setKeys(reloaded);
      setUsages(u);
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveKey = async (idx: number) => {
    if (!window.confirm(`キー ${idx + 1} を削除しますか?`)) return;
    setBusy(true);
    try {
      const next = keys.filter((_, i) => i !== idx);
      await window.api.gemini.setKeys(next);
      const [reloaded, u] = await Promise.all([
        window.api.gemini.getKeys(),
        window.api.gemini.getKeyUsages(),
      ]);
      setKeys(reloaded);
      setUsages(u);
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm(`登録されている Gemini API キー ${keys.length} 個を全て削除しますか?`)) return;
    setBusy(true);
    try {
      await window.api.gemini.clear();
      setKeys([]);
      setUsages([]);
      props.onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.keySection}>
      <div className={styles.keySectionHeader}>
        <h3 className={styles.keySectionTitle}>Gemini(動画音声分析、最大 {MAX_GEMINI_KEYS})</h3>
        <div className={styles.keySectionStatus}>
          <span className={keys.length > 0 ? styles.statusOk : styles.statusMuted}>
            {keys.length > 0 ? `${keys.length} 件登録済み` : '未登録'}
          </span>
        </div>
        <div className={styles.keySectionActions}>
          {keys.length > 0 && (
            <button
              type="button"
              className={`${styles.smallButton} ${styles.smallButtonDanger}`}
              onClick={handleClearAll}
              disabled={busy}
            >
              <Trash2 size={12} />
              全削除
            </button>
          )}
        </div>
      </div>

      {keys.length > 0 && (
        <div className={styles.quotaPanel}>
          <div className={styles.quotaSummary}>
            本日のリクエスト消費(概算):&nbsp;
            <span className={styles.quotaTotal}>
              ~{usages.reduce((acc, u) => acc + u.todayCount, 0).toLocaleString()}
            </span>
            &nbsp;/&nbsp;
            <span>{(keys.length * (usages[0]?.todayLimit ?? 500)).toLocaleString()} RPD</span>
          </div>
          <div className={styles.quotaBars}>
            {keys.map((k, i) => {
              const usage = usages[i] ?? {
                keyHash: '',
                todayCount: 0,
                todayLimit: 500,
                lastError: null,
              };
              const status = geminiKeyStatus(usage);
              const pct = Math.min(
                100,
                usage.todayLimit > 0 ? (usage.todayCount / usage.todayLimit) * 100 : 0,
              );
              const barColor =
                status.color === 'red'
                  ? '#ef4444'
                  : status.color === 'yellow'
                  ? '#f59e0b'
                  : undefined;
              return (
                <div key={i} className={styles.quotaBarRow}>
                  <span className={styles.quotaBarLabel}>キー {i + 1}</span>
                  <code style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 130 }}>
                    {maskKey(k)}
                  </code>
                  <div className={styles.quotaBar}>
                    <div
                      className={styles.quotaBarFill}
                      style={{ width: `${pct}%`, ...(barColor ? { background: barColor } : {}) }}
                    />
                  </div>
                  <span className={styles.quotaBarValue}>
                    ~{usage.todayCount.toLocaleString()} / {usage.todayLimit.toLocaleString()} RPD
                  </span>
                  <span style={{ fontSize: 11, minWidth: 110 }}>{status.label}</span>
                  <button
                    type="button"
                    className={`${styles.smallButton} ${styles.smallButtonDanger}`}
                    onClick={() => void handleRemoveKey(i)}
                    disabled={busy}
                    title={`キー ${i + 1} を削除`}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className={styles.editRow} style={{ marginTop: 8 }}>
        <input
          type="password"
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            keys.length === 0
              ? 'AIza... で始まる Gemini API キーを貼り付けて「追加」'
              : '別のキーを追加(AIza...)'
          }
          spellCheck={false}
          autoComplete="off"
          disabled={busy || keys.length >= MAX_GEMINI_KEYS}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && draft.trim().length > 0) {
              void handleAddKey();
            }
          }}
        />
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleAddKey}
          disabled={busy || draft.trim().length === 0 || keys.length >= MAX_GEMINI_KEYS}
        >
          <Plus size={12} />
          追加
        </button>
      </div>

      <div className={styles.help}>
        発行元: <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">https://aistudio.google.com/app/apikey</a>
        — gemini-2.5-flash で動画音声を構造理解。1 キーあたり 1 日 500 リクエスト(無料枠)、複数キーで分散します。使用量は自前カウントの概算で AI Studio dashboard とはズレ得ます。
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </section>
  );
}

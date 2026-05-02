import { useEffect, useState } from 'react';
import { Plus, X, Database, Play, Pause } from 'lucide-react';
import styles from './SettingsDialog.module.css';

// Settings dialog block for the Phase 1 data-collection pipeline:
//   * YouTube Data API keys (BYOK, multi, max 10)
//   * Per-creator targeting list
//   * Collection-status panel (read-only, polled)
//
// Hosted in SettingsDialog as a third major section. The component
// owns its own state — parent doesn't need to plumb anything beyond
// rendering it.

const MAX_KEYS = 10;

type Stats = {
  videoCount: number;
  creatorCount: number;
  quotaUsedToday: number;
  isRunning: boolean;
  lastCollectedAt: string | null;
};

type CreatorEntry = { name: string; channelId: string | null };

export default function DataCollectionSettings() {
  // ---- API keys ------------------------------------------------------------
  // We don't read existing keys back (renderer never sees plaintext).
  // Instead we keep a count + edit buffer of fresh inputs. Save replaces
  // the whole set on disk.
  const [keyCount, setKeyCount] = useState(0);
  const [keyDraft, setKeyDraft] = useState<string[]>(['']);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keysSaving, setKeysSaving] = useState(false);

  // ---- Creator list --------------------------------------------------------
  const [creators, setCreators] = useState<CreatorEntry[]>([]);
  const [newCreatorName, setNewCreatorName] = useState('');
  const [creatorError, setCreatorError] = useState<string | null>(null);

  // ---- Stats ---------------------------------------------------------------
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

  // Initial load + 5-second poll for stats. The polled call is cheap
  // (one SQLite COUNT(*) plus a SUM) so this isn't a perf concern.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [count, list, st] = await Promise.all([
          window.api.youtubeApiKeys.getKeyCount(),
          window.api.creators.list(),
          window.api.dataCollection.getStats(),
        ]);
        if (!alive) return;
        setKeyCount(count);
        setCreators(list);
        setStats(st);
      } catch (err) {
        console.warn('[data-collection-settings] refresh failed:', err);
      }
    };
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  // ---- API key handlers ----------------------------------------------------

  const updateKeyDraftAt = (i: number, value: string) => {
    setKeyDraft((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  const addKeyRow = () => {
    setKeyDraft((prev) => (prev.length >= MAX_KEYS ? prev : [...prev, '']));
  };

  const removeKeyRow = (i: number) => {
    setKeyDraft((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleSaveKeys = async () => {
    setKeyError(null);
    const cleaned = keyDraft.map((k) => k.trim()).filter((k) => k.length > 0);
    if (cleaned.length === 0) {
      setKeyError('少なくとも 1 つのキーを入力してください');
      return;
    }
    setKeysSaving(true);
    try {
      await window.api.youtubeApiKeys.setKeys(cleaned);
      setKeyDraft(['']);
      const c = await window.api.youtubeApiKeys.getKeyCount();
      setKeyCount(c);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeysSaving(false);
    }
  };

  const handleClearKeys = async () => {
    setKeysSaving(true);
    try {
      await window.api.youtubeApiKeys.clear();
      setKeyCount(0);
    } finally {
      setKeysSaving(false);
    }
  };

  // ---- Creator handlers ----------------------------------------------------

  const handleAddCreator = async () => {
    setCreatorError(null);
    const name = newCreatorName.trim();
    if (!name) return;
    if (creators.some((c) => c.name === name)) {
      setCreatorError('既に登録されています');
      return;
    }
    try {
      await window.api.creators.add(name, null);
      const list = await window.api.creators.list();
      setCreators(list);
      setNewCreatorName('');
    } catch (err) {
      setCreatorError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveCreator = async (name: string) => {
    await window.api.creators.remove(name);
    setCreators(await window.api.creators.list());
  };

  // ---- Manager controls ----------------------------------------------------

  const handleTriggerNow = async () => {
    setBusy(true);
    try {
      await window.api.dataCollection.triggerNow();
      // Stats refresh happens via the 5 s poll; users see the count
      // tick up once the batch is done (1-3 minutes typically).
    } finally {
      setBusy(false);
    }
  };

  const handlePauseResume = async () => {
    setBusy(true);
    try {
      if (stats?.isRunning) {
        await window.api.dataCollection.pause();
      } else {
        await window.api.dataCollection.resume();
      }
      setStats(await window.api.dataCollection.getStats());
    } finally {
      setBusy(false);
    }
  };

  const formatDateTime = (iso: string | null): string => {
    if (!iso) return '未実行';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className={styles.section}>
      <div className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Database size={16} />
        <span>切り抜きデータ収集(Phase 1 蓄積基盤)</span>
      </div>

      {/* Status panel (read-only) */}
      <div className={styles.help} style={{ marginTop: 0 }}>
        切り抜き動画の伸びパターンを学習するためのバックグラウンド収集です。
        YouTube Data API キーを登録すると、5 秒後に自動で起動して 1 時間ごとにバッチ実行されます。
      </div>

      <div
        style={{
          background: 'rgba(99, 102, 241, 0.06)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
          borderRadius: 6,
          padding: '8px 12px',
          marginTop: 8,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          fontSize: 12,
        }}
      >
        <div>
          <span style={{ color: 'var(--text-muted)' }}>動画</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats?.videoCount.toLocaleString() ?? '...'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>配信者</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats?.creatorCount ?? '...'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>本日のクォータ</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {stats?.quotaUsedToday.toLocaleString() ?? '...'} / {(keyCount * 10000).toLocaleString()}
          </span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>状態</span>:&nbsp;
          <span style={{ color: stats?.isRunning ? 'var(--accent-success)' : 'var(--text-muted)' }}>
            {stats?.isRunning ? '実行中' : '停止中'}
          </span>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <span style={{ color: 'var(--text-muted)' }}>最終収集</span>:&nbsp;
          {formatDateTime(stats?.lastCollectedAt ?? null)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleTriggerNow}
          disabled={busy || keyCount === 0}
          title={keyCount === 0 ? '先に API キーを登録してください' : '今すぐ 1 バッチ実行'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Play size={12} />
          今すぐ実行
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={handlePauseResume}
          disabled={busy || keyCount === 0}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {stats?.isRunning ? <Pause size={12} /> : <Play size={12} />}
          {stats?.isRunning ? '一時停止' : '再開'}
        </button>
      </div>

      {/* API keys */}
      <div className={styles.label} style={{ marginTop: 16 }}>
        YouTube Data API キー(現在 {keyCount} 件登録済み、最大 {MAX_KEYS} 個)
      </div>
      <div className={styles.help}>
        Google Cloud Console で発行(YouTube Data API v3 を有効化)。1 キーあたり 1 日 10,000 unit の上限のため、複数キーで分散すると収集量が増えます。
      </div>
      {keyDraft.map((key, i) => (
        <div key={i} className={styles.row} style={{ marginTop: 6 }}>
          <input
            type="password"
            className={styles.input}
            value={key}
            onChange={(e) => updateKeyDraftAt(i, e.target.value)}
            placeholder={`キー ${i + 1}`}
            spellCheck={false}
            autoComplete="off"
            disabled={keysSaving}
          />
          <button
            type="button"
            className={styles.cancelButton}
            onClick={() => removeKeyRow(i)}
            disabled={keysSaving || keyDraft.length === 1}
            style={{ marginLeft: 4, padding: '4px 8px' }}
            title="この行を削除"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={addKeyRow}
          disabled={keysSaving || keyDraft.length >= MAX_KEYS}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Plus size={12} />
          キーを追加
        </button>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSaveKeys}
          disabled={keysSaving || keyDraft.every((k) => !k.trim())}
        >
          {keysSaving ? '保存中...' : '全て保存'}
        </button>
        {keyCount > 0 && (
          <button
            type="button"
            className={styles.cancelButton}
            onClick={handleClearKeys}
            disabled={keysSaving}
          >
            登録済みを全削除
          </button>
        )}
      </div>
      {keyError && <div className={styles.error}>{keyError}</div>}

      {/* Creator list */}
      <div className={styles.label} style={{ marginTop: 16 }}>
        特定配信者リスト(優先的に収集する人物名)
      </div>
      <div className={styles.help}>
        登録された名前で「&lt;人物名&gt; 切り抜き」を検索します。チャンネル ID 紐づけは Phase 2 で自動化予定。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {creators.map((c) => (
          <span
            key={c.name}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 999,
              padding: '2px 4px 2px 10px',
              fontSize: 12,
            }}
          >
            {c.name}
            <button
              type="button"
              onClick={() => void handleRemoveCreator(c.name)}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--text-muted)', cursor: 'pointer',
                padding: '0 4px',
              }}
              title={`${c.name} を削除`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {creators.length === 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>(未登録 — 広めの検索クエリのみで収集します)</span>
        )}
      </div>
      <div className={styles.row} style={{ marginTop: 8 }}>
        <input
          type="text"
          className={styles.input}
          value={newCreatorName}
          onChange={(e) => setNewCreatorName(e.target.value)}
          placeholder="配信者名(例: 葛葉)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAddCreator();
          }}
        />
        <button
          type="button"
          className={styles.saveButton}
          onClick={() => void handleAddCreator()}
          disabled={!newCreatorName.trim()}
          style={{ marginLeft: 8 }}
        >
          追加
        </button>
      </div>
      {creatorError && <div className={styles.error}>{creatorError}</div>}
    </div>
  );
}

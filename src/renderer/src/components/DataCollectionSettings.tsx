import { useEffect, useState } from 'react';
import { X, Database, Play, Pause } from 'lucide-react';
import styles from './SettingsDialog.module.css';

// Hosted under SettingsDialog. As of the API-management refactor,
// YouTube API key entry has moved to ApiManagementDialog. This block
// keeps:
//   * The collection-status panel (read-only, polled)
//   * The per-creator targeting list (add / remove)
//
// Manual trigger / pause still live here so users adjusting their
// creator list can immediately fire a collection without leaving the
// Settings dialog.

type Stats = {
  videoCount: number;
  creatorCount: number;
  quotaUsedToday: number;
  isRunning: boolean;
  lastCollectedAt: string | null;
};

type CreatorEntry = { name: string; channelId: string | null };

export default function DataCollectionSettings() {
  const [keyCount, setKeyCount] = useState(0);
  const [creators, setCreators] = useState<CreatorEntry[]>([]);
  const [newCreatorName, setNewCreatorName] = useState('');
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

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

  const handleTriggerNow = async () => {
    setBusy(true);
    try {
      await window.api.dataCollection.triggerNow();
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
        <span>切り抜きデータ収集(Phase 1 蓄積)</span>
      </div>

      <div className={styles.help} style={{ marginTop: 0 }}>
        切り抜き動画の伸びパターンを学習するためのバックグラウンド収集。API キーは「API 管理」画面で登録します。
      </div>

      {/* Status panel */}
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
            {stats?.isRunning ? '実行中' : keyCount === 0 ? '未起動(API キー未登録)' : '停止中'}
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
          title={keyCount === 0 ? '先に API 管理画面で YouTube キーを登録してください' : '今すぐ 1 バッチ実行'}
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

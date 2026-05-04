import { useEffect, useState } from 'react';
import { X, Database, Play, Pause, Square, BarChart3 } from 'lucide-react';
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
  uploaderCount: number;
  quotaUsedToday: number;
  isRunning: boolean;
  isPaused: boolean;
  isEnabled: boolean;
  isBatchActive: boolean;
  nextBatchAtSec: number | null;
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
      // Refresh immediately so the status flips to 取得中 without
      // waiting for the next 5-second poll tick.
      setStats(await window.api.dataCollection.getStats());
    } finally {
      setBusy(false);
    }
  };

  const handleRunPatternAnalysis = async () => {
    setBusy(true);
    try {
      const r = await window.api.dataCollection.runPatternAnalysis();
      const lines: string[] = ['パターン分析が完了しました', ''];
      lines.push(
        `全動画統合: ${r.globalGenerated ? `✅(${r.globalAnalyzed} 動画)` : '❌(動画なし)'}`,
      );
      lines.push(`個別: ${r.generatedCreators.length} creators${r.generatedCreators.length > 0 ? ` (${r.generatedCreators.join(', ')})` : ''}`);
      lines.push(`スキップ: ${r.skippedCreators} creators(サンプル < 20)`);
      lines.push(`グループ別: ${r.generatedGroups.length} グループ${r.generatedGroups.length > 0 ? ` (${r.generatedGroups.join(', ')})` : ''}`);
      lines.push('');
      lines.push('出力先: userData/patterns/');
      window.alert(lines.join('\n'));
    } catch (err) {
      window.alert(`パターン分析に失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelCurrent = async () => {
    if (!stats?.isBatchActive) return;
    const ok = window.confirm(
      '進行中の取得を停止しますか?\n\n現在のバッチは破棄されます(部分的に保存済みのデータは残ります)。',
    );
    if (!ok) return;
    setBusy(true);
    try {
      await window.api.dataCollection.cancelCurrent();
      setStats(await window.api.dataCollection.getStats());
    } finally {
      setBusy(false);
    }
  };

  // Persistent master switch — separate axis from pause/resume.
  // Enabling shows a confirm so the user understands quota will start
  // ticking; disabling needs no confirm (it's the safer direction).
  const handleToggleEnabled = async () => {
    if (!stats) return;
    if (!stats.isEnabled) {
      const ok = window.confirm(
        'データ収集を有効化します。\n\n' +
          'バックグラウンドで自動的に YouTube Data API を消費する収集が開始されます。\n' +
          '検索クエリ戦略を確定してから有効化することを推奨します。\n\n' +
          'よろしいですか?',
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await window.api.dataCollection.setEnabled(!stats.isEnabled);
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

  // "次のサイクルまで N 分" — UX-friendly countdown for the 待機中
  // status. <= 60s collapses to "間もなく" (the 2026-05-03 dynamic-
  // cycle change made the shortest tier 3 min, so a sub-minute
  // precision readout no longer carries useful information).
  const formatNextBatch = (sec: number | null): string => {
    if (sec == null) return '';
    if (sec <= 60) return '間もなく';
    const minutes = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (minutes < 60) return `次まで ${minutes} 分${remSec > 0 ? ` ${remSec} 秒` : ''}`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return `次まで ${hours} 時間${remMin > 0 ? ` ${remMin} 分` : ''}`;
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
          <span style={{ color: 'var(--text-muted)' }}>配信者(seed)</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats?.creatorCount ?? '...'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>切り抜きチャンネル</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stats?.uploaderCount?.toLocaleString() ?? '...'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>本日のクォータ</span>:&nbsp;
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {stats?.quotaUsedToday.toLocaleString() ?? '...'} / {(keyCount * 10000).toLocaleString()}
          </span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>自動収集</span>:&nbsp;
          {stats?.isEnabled ? (
            <span style={{ color: 'var(--accent-success)' }}>🟢 有効</span>
          ) : (
            <span style={{ color: 'var(--accent-danger, #ef4444)' }}>🔴 無効</span>
          )}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>状態</span>:&nbsp;
          {(() => {
            // Status precedence:
            //   1. batch in flight → "取得中…" (regardless of enabled)
            //   2. enabled + idle → "待機中 (次まで N 分)"
            //   3. paused → "一時停止中"
            //   4. disabled → "停止中(自動収集無効)" / "未起動"
            if (stats?.isBatchActive) {
              return <span style={{ color: 'var(--accent-success)' }}>🟢 取得中…</span>;
            }
            if (!stats?.isEnabled) {
              return <span style={{ color: 'var(--text-muted)' }}>⚫ 停止中(自動収集無効)</span>;
            }
            if (stats.isPaused) {
              return <span style={{ color: 'var(--accent-warning)' }}>⏸ 一時停止中</span>;
            }
            if (stats.isRunning) {
              const next = formatNextBatch(stats.nextBatchAtSec);
              return (
                <span style={{ color: 'var(--accent-warning)' }}>
                  ⏸ 待機中{next ? `(${next})` : ''}
                </span>
              );
            }
            if (keyCount === 0) {
              return <span style={{ color: 'var(--text-muted)' }}>⚫ 未起動(API キー未登録)</span>;
            }
            return <span style={{ color: 'var(--text-muted)' }}>⚫ 停止中</span>;
          })()}
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <span style={{ color: 'var(--text-muted)' }}>最終収集</span>:&nbsp;
          {formatDateTime(stats?.lastCollectedAt ?? null)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {/* Persistent master switch (re-instates after app restart) */}
        <button
          type="button"
          className={stats?.isEnabled ? styles.cancelButton : styles.saveButton}
          onClick={handleToggleEnabled}
          disabled={busy || !stats}
          title={
            stats?.isEnabled
              ? '自動収集を無効化(進行中バッチ停止 + 再起動後も自動開始しない)'
              : '自動収集を有効化(バックグラウンドで定期収集を開始 + 再起動後も自動開始)'
          }
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {stats?.isEnabled ? <Pause size={12} /> : <Play size={12} />}
          {stats?.isEnabled ? '無効化する' : '有効化する'}
        </button>
        {/* One-shot manual trigger (was 「今すぐ実行」 — renamed for
            clarity of intent: 取得 maps onto data acquisition better
            than 実行) */}
        <button
          type="button"
          className={styles.cancelButton}
          onClick={handleTriggerNow}
          disabled={busy || keyCount === 0 || !stats?.isEnabled || stats.isBatchActive}
          title={
            !stats?.isEnabled
              ? 'データ収集を先に有効化してください'
              : keyCount === 0
              ? '先に API 管理画面で YouTube キーを登録してください'
              : stats.isBatchActive
              ? '進行中のバッチが完了するまで待ってください'
              : '今すぐ 1 サイクル分だけ取得'
          }
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Play size={12} />
          1 回だけ取得
        </button>
        {/* Cancel-in-flight — disabled unless a batch is mid-flight.
            Doesn't change isEnabled / pause state, so the regular
            schedule still ticks unaffected. */}
        <button
          type="button"
          className={`${styles.cancelButton} ${styles.smallButtonDanger ?? ''}`}
          onClick={handleCancelCurrent}
          disabled={busy || !stats?.isBatchActive}
          title={
            !stats?.isBatchActive
              ? '進行中のバッチがありません'
              : '進行中のバッチを停止(現在のサイクルは破棄)'
          }
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Square size={12} />
          取得を停止
        </button>
        {/* Phase 2a — sweep accumulated videos and emit per-creator
            + per-group pattern JSON files. Synchronous on the main
            side, ~1s for the current data volume. */}
        <button
          type="button"
          className={styles.cancelButton}
          onClick={handleRunPatternAnalysis}
          disabled={busy || (stats?.videoCount ?? 0) === 0}
          title={
            (stats?.videoCount ?? 0) === 0
              ? '先に動画を蓄積してください(videos が 0 件)'
              : 'userData/patterns/ にパターン JSON を生成(配信者ごと + グループごと)'
          }
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <BarChart3 size={12} />
          パターン分析を実行
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

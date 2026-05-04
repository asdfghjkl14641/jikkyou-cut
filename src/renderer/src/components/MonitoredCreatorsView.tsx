import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  Search,
  Plus,
  Trash2,
  AlertCircle,
  AlertTriangle,
  Radio,
  RefreshCw,
  RotateCw,
  Film,
  FolderOpen,
  Edit3,
  StopCircle,
} from 'lucide-react';
import styles from './MonitoredCreatorsView.module.css';
import { useEditorStore } from '../store/editorStore';
import { monitoredCreatorKey, type MonitoredCreator } from '../../../common/config';
import type {
  LiveStreamInfo,
  RecordingMetadata,
  StreamMonitorStatus,
} from '../../../common/types';

// 段階 X1 (revised) — full-screen monitored-creators registration page.
//
// Flow:
//   1) User types a Japanese display name (e.g. "柊ツルギ")
//   2) Gemini answers with potential YouTube/Twitch handles +
//      confidence ('high' | 'medium' | 'low')
//   3) Concrete profile lookups (Twitch Helix + YouTube Data API)
//      run in parallel, dropping platforms Gemini didn't suggest
//   4) Result cards render — one per platform that resolved
//   5) Add button → confirm dialog → addMonitoredCreator → list update
//
// The confirmation dialog is non-skippable per spec ("誤登録防止").

type Platform = 'twitch' | 'youtube';

// 2026-05-04 — Hybrid search introduced data-source provenance, which
// supersedes the old Gemini-confidence chip. Three values:
//   'gemini'       — Gemini guess, resolved by handle / login lookup
//   'api-fallback' — search.list / Twitch search/channels candidate
//   'manual'       — user typed handle / channelId directly
// The UI chooses the badge (✓ green / ⚠ yellow / 👤 blue) off this.
type CardSource = 'gemini' | 'api-fallback' | 'manual';

type SearchCardCommon = {
  platform: Platform;
  displayName: string;
  profileImageUrl: string | null;
  source: CardSource;
  // ISO 8601 account/channel creation timestamp from the platform's
  // user/channels endpoint. Empty string when unavailable.
  createdAt: string;
};

type TwitchCard = SearchCardCommon & {
  platform: 'twitch';
  twitchUserId: string;
  twitchLogin: string;
  // null = follower count couldn't be retrieved (most app-only
  // Twitch tokens can't read /helix/channels/followers).
  followerCount: number | null;
};

type YouTubeCard = SearchCardCommon & {
  platform: 'youtube';
  youtubeChannelId: string;
  youtubeHandle: string | null;
  subscriberCount: number | null;
};

type SearchCard = TwitchCard | YouTubeCard;

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'done';
      cards: SearchCard[];
      warning: string | null;
      // 2026-05-04 — fold threshold metadata into search state so the
      // 0-hit relaxation hint UI knows whether the empty result came
      // from "no matches at all" vs "matches got filtered out".
      filteredOut: { twitch: number; youtube: number };
      thresholdApplied: number;
    }
  | { kind: 'error'; message: string };

const PLATFORM_LABEL: Record<Platform, string> = { twitch: 'Twitch', youtube: 'YouTube' };

export default function MonitoredCreatorsView() {
  const closeMonitoredCreators = useEditorStore((s) => s.closeMonitoredCreators);

  const [creators, setCreators] = useState<MonitoredCreator[]>([]);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({ kind: 'idle' });
  const [pendingAdd, setPendingAdd] = useState<SearchCard | null>(null);
  const [adding, setAdding] = useState(false);
  // Manual-input fallback (for when Gemini's handle guess is wrong /
  // returns the wrong same-name account). Collapsed by default.
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTwitchLogin, setManualTwitchLogin] = useState('');
  const [manualYouTubeInput, setManualYouTubeInput] = useState('');
  const [manualBusy, setManualBusy] = useState<'twitch' | 'youtube' | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [monitorStatus, setMonitorStatus] = useState<StreamMonitorStatus | null>(null);
  // 段階 X4 fix — preventSleepDuringRecording is read once at mount
  // and on user toggle. The main-side recorder reads from
  // AppConfig directly when each recording starts, so this is just
  // for UI binding.
  const [preventSleep, setPreventSleep] = useState<boolean>(true);
  // 2026-05-04 — Persisted minimum follower threshold for API search
  // results. Loaded from AppConfig at mount, written back on user
  // change. Default 200K covers every 大手 / 事務所 — small individual
  // streamers fall through to manual-input (which doesn't apply this
  // filter).
  const [minFollowers, setMinFollowers] = useState<number>(200_000);
  // 段階 X3+X4 — auto-record state. Loaded once at mount + kept in
  // sync via the streamRecorder:progress IPC events. The renderer
  // never writes to disk; main owns the metadata files.
  const [recordings, setRecordings] = useState<RecordingMetadata[]>([]);
  // Drives the "X 分前" labels — tick once a minute so they refresh
  // without polling the main process. Just a counter; never read,
  // only triggers re-render via setState.
  const [, setTick] = useState(0);

  // Initial list load + initial monitor status.
  useEffect(() => {
    let alive = true;
    void window.api.monitoredCreators.list().then((list) => {
      if (alive) setCreators(list);
    });
    void window.api.streamMonitor.getStatus().then((s) => {
      if (alive) setMonitorStatus(s);
    });
    void window.api.streamRecorder.list().then((rs) => {
      if (alive) setRecordings(rs);
    });
    void window.api.getSettings().then((cfg) => {
      if (!alive) return;
      setPreventSleep(cfg.preventSleepDuringRecording);
      setMinFollowers(cfg.searchMinFollowers ?? 200_000);
    });
    return () => { alive = false; };
  }, []);

  const handleTogglePreventSleep = useCallback(async (next: boolean) => {
    setPreventSleep(next);
    await window.api.saveSettings({ preventSleepDuringRecording: next });
  }, []);

  const handleChangeMinFollowers = useCallback(async (next: number) => {
    const clean = Math.max(0, Math.floor(next));
    setMinFollowers(clean);
    await window.api.saveSettings({ searchMinFollowers: clean });
  }, []);

  // Subscribe to streamRecorder progress events. Updates / inserts
  // the recording in-place by recordingId — main side may emit the
  // same id multiple times (status transitions, file size refreshes).
  useEffect(() => {
    const off = window.api.streamRecorder.onProgress((meta) => {
      setRecordings((prev) => {
        const idx = prev.findIndex((r) => r.recordingId === meta.recordingId);
        if (idx < 0) return [meta, ...prev];
        const next = [...prev];
        next[idx] = meta;
        return next;
      });
    });
    return off;
  }, []);

  // Subscribe to monitor status pushes so the toggle / live cards
  // update without re-polling. The main process emits 'streamMonitor:
  // status' on every poll completion + on every setEnabled/pollNow IPC.
  useEffect(() => {
    const off = window.api.streamMonitor.onStatus((s) => setMonitorStatus(s));
    return off;
  }, []);

  // 60-second clock tick for relative-time labels.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Index live streams by `${platform}:${creatorKey}` for O(1) lookup
  // when rendering the registered-creators list.
  const liveByKey = useMemo(() => {
    const map = new Map<string, LiveStreamInfo>();
    if (!monitorStatus) return map;
    for (const s of monitorStatus.liveStreams) {
      map.set(`${s.platform}:${s.creatorKey}`, s);
    }
    return map;
  }, [monitorStatus]);

  const handleToggleMonitor = useCallback(async (enabled: boolean) => {
    const next = await window.api.streamMonitor.setEnabled(enabled);
    setMonitorStatus(next);
  }, []);

  const handleManualPoll = useCallback(async () => {
    const next = await window.api.streamMonitor.pollNow();
    setMonitorStatus(next);
  }, []);

  const handleManualTwitchFetch = useCallback(async () => {
    const login = manualTwitchLogin.trim();
    if (!login) return;
    setManualBusy('twitch');
    setManualError(null);
    try {
      const profile = await window.api.creatorSearch.fetchTwitchProfile(login);
      if (!profile) {
        setManualError(`Twitch ログイン名 "${login}" が見つかりませんでした`);
        return;
      }
      // Surface as a search-result card with source='manual' so the
      // existing add → confirm-dialog flow handles registration.
      // Manual cards bypass the threshold filter — filteredOut=0, the
      // relaxation hint code never fires for them.
      setSearchState({
        kind: 'done',
        cards: [
          {
            platform: 'twitch',
            twitchUserId: profile.userId,
            twitchLogin: profile.login,
            displayName: profile.displayName,
            profileImageUrl: profile.profileImageUrl,
            source: 'manual',
            createdAt: profile.createdAt,
            followerCount: profile.followerCount,
          },
        ],
        warning: null,
        filteredOut: { twitch: 0, youtube: 0 },
        thresholdApplied: 0,
      });
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualBusy(null);
    }
  }, [manualTwitchLogin]);

  const handleManualYouTubeFetch = useCallback(async () => {
    const raw = manualYouTubeInput.trim();
    if (!raw) return;
    setManualBusy('youtube');
    setManualError(null);
    try {
      // UCxxx (24 chars, starts with UC) is a channelId. Anything
      // else (`@handle` or bare `handle`) is treated as a handle.
      const isChannelId = /^UC[A-Za-z0-9_-]{22}$/.test(raw);
      const profile = await window.api.creatorSearch.fetchYouTubeProfile(
        isChannelId ? { channelId: raw } : { handle: raw },
      );
      if (!profile) {
        setManualError(
          `YouTube ${isChannelId ? 'チャンネル ID' : 'ハンドル'} "${raw}" が見つかりませんでした`,
        );
        return;
      }
      setSearchState({
        kind: 'done',
        cards: [
          {
            platform: 'youtube',
            youtubeChannelId: profile.channelId,
            youtubeHandle: profile.handle,
            displayName: profile.channelName,
            profileImageUrl: profile.profileImageUrl,
            source: 'manual',
            createdAt: profile.createdAt,
            subscriberCount: profile.subscriberCount,
          },
        ],
        filteredOut: { twitch: 0, youtube: 0 },
        thresholdApplied: 0,
        warning: null,
      });
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualBusy(null);
    }
  }, [manualYouTubeInput]);

  // 段階 X3+X4 — open a recording in the editor. Picks the highest-
  // fidelity available file: VOD if completed, otherwise the live
  // capture (still useful for review while VOD re-fetch is pending).
  // closeMonitoredCreators() pops back to the previous editing
  // phase, then setFile() lands on clip-select with the recording's
  // file path.
  const handleOpenInEditor = useCallback(async (meta: RecordingMetadata) => {
    const filename = meta.files.vod ?? meta.files.live;
    if (!filename) {
      alert('録画ファイルが見つかりません(まだ録画中、または失敗しています)。');
      return;
    }
    // Build the absolute path. main wrote `folder` in the metadata
    // for exactly this purpose so the renderer doesn't need to know
    // the recordings-dir convention.
    const absPath = `${meta.folder}\\${filename}`;
    closeMonitoredCreators();
    // Defer setFile until after closeMonitoredCreators's phase swap
    // settles so the load → clip-select transition fires once.
    setTimeout(() => {
      useEditorStore.getState().setFile(absPath);
    }, 0);
  }, [closeMonitoredCreators]);

  const handleStopRecording = useCallback(async (meta: RecordingMetadata) => {
    if (!window.confirm(`「${meta.displayName}」の録画を停止しますか?`)) return;
    await window.api.streamRecorder.stop({ creatorKey: meta.creatorKey });
  }, []);

  const handleDeleteRecording = useCallback(async (meta: RecordingMetadata) => {
    if (!window.confirm(`「${meta.displayName}」の録画ファイルを削除しますか?この操作は取り消せません。`)) return;
    await window.api.streamRecorder.delete({ recordingId: meta.recordingId });
    setRecordings((prev) => prev.filter((r) => r.recordingId !== meta.recordingId));
  }, []);

  const handleRevealRecording = useCallback(async (meta: RecordingMetadata) => {
    await window.api.streamRecorder.revealInFolder({ recordingId: meta.recordingId });
  }, []);

  // Aggregate sizes for the section header. live + vod sums.
  const recordingsTotalBytes = useMemo(() => {
    let total = 0;
    for (const r of recordings) {
      total += r.fileSizeBytes.live ?? 0;
      total += r.fileSizeBytes.vod ?? 0;
    }
    return total;
  }, [recordings]);

  const runSearch = useCallback(async (
    rawQuery: string,
    minFollowersOverride?: number | null,
  ) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    setSearchState({ kind: 'loading' });
    try {
      const r = await window.api.creatorSearch.searchAll({
        query: trimmed,
        minFollowersOverride,
      });
      const cards: SearchCard[] = [];

      const twitchSrc: CardSource =
        r.source.twitch === 'gemini' ? 'gemini' : 'api-fallback';
      for (const t of r.twitch) {
        cards.push({
          platform: 'twitch',
          twitchUserId: t.userId,
          twitchLogin: t.login,
          displayName: t.displayName,
          profileImageUrl: t.profileImageUrl || null,
          source: twitchSrc,
          createdAt: t.createdAt,
          followerCount: t.followerCount,
        });
      }

      const youtubeSrc: CardSource =
        r.source.youtube === 'gemini' ? 'gemini' : 'api-fallback';
      for (const y of r.youtube) {
        cards.push({
          platform: 'youtube',
          youtubeChannelId: y.channelId,
          youtubeHandle: y.handle,
          displayName: y.channelName,
          profileImageUrl: y.profileImageUrl,
          source: youtubeSrc,
          createdAt: y.createdAt,
          subscriberCount: y.subscriberCount,
        });
      }

      if (cards.length === 0) {
        // Differentiate "no matches at all" from "matches got filtered
        // out by threshold" so the relaxation hint UI can fire only
        // when there's something behind the curtain.
        const totalFilteredOut = r.filteredOut.twitch + r.filteredOut.youtube;
        const warning = totalFilteredOut > 0
          ? `閾値 ${formatThreshold(r.thresholdApplied)} 未満で ${totalFilteredOut} 件除外しました。下のボタンで閾値を下げて再検索できます。`
          : '該当する配信者が見つかりませんでした(Gemini も API 検索もヒットなし)。別の名前で検索してみてください。';
        setSearchState({
          kind: 'done',
          cards: [],
          warning,
          filteredOut: r.filteredOut,
          thresholdApplied: r.thresholdApplied,
        });
      } else {
        // Soft warning when ANY platform fell back to API search —
        // the user should double-check follower counts before adding.
        const fellBack: string[] = [];
        if (r.source.twitch === 'api-fallback') fellBack.push('Twitch');
        if (r.source.youtube === 'api-fallback') fellBack.push('YouTube');
        const baseWarn = fellBack.length > 0
          ? `${fellBack.join(' / ')} は API 検索結果です。フォロワー数で本人か確認してください。`
          : null;
        const totalFilteredOut = r.filteredOut.twitch + r.filteredOut.youtube;
        const filterNote = totalFilteredOut > 0
          ? `(閾値 ${formatThreshold(r.thresholdApplied)} 未満で ${totalFilteredOut} 件除外)`
          : null;
        const warning = [baseWarn, filterNote].filter((s): s is string => !!s).join(' ');
        setSearchState({
          kind: 'done',
          cards,
          warning: warning || null,
          filteredOut: r.filteredOut,
          thresholdApplied: r.thresholdApplied,
        });
      }
    } catch (err) {
      setSearchState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleSearch = useCallback(() => {
    void runSearch(query);
  }, [query, runSearch]);

  const confirmAdd = useCallback(async () => {
    if (!pendingAdd) return;
    setAdding(true);
    try {
      const next = pendingAdd.platform === 'twitch'
        ? await window.api.monitoredCreators.add({
            platform: 'twitch',
            twitchUserId: pendingAdd.twitchUserId,
            twitchLogin: pendingAdd.twitchLogin,
            displayName: pendingAdd.displayName,
            profileImageUrl: pendingAdd.profileImageUrl,
            followerCount: pendingAdd.followerCount,
            accountCreatedAt: pendingAdd.createdAt,
          })
        : await window.api.monitoredCreators.add({
            platform: 'youtube',
            youtubeChannelId: pendingAdd.youtubeChannelId,
            youtubeHandle: pendingAdd.youtubeHandle,
            displayName: pendingAdd.displayName,
            profileImageUrl: pendingAdd.profileImageUrl,
            subscriberCount: pendingAdd.subscriberCount,
            accountCreatedAt: pendingAdd.createdAt,
          });
      setCreators(next);
      setPendingAdd(null);
      // Clear search results after successful add — the user will
      // typically search a different name next.
      setSearchState({ kind: 'idle' });
      setQuery('');
    } catch (err) {
      // Surface the error in the confirm dialog itself rather than
      // closing it — the user might retry.
      alert(`登録に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
  }, [pendingAdd]);

  const handleRemove = useCallback(async (creator: MonitoredCreator) => {
    const ok = window.confirm(`「${creator.displayName}」(${PLATFORM_LABEL[creator.platform]})を登録解除しますか?`);
    if (!ok) return;
    const next = await window.api.monitoredCreators.remove({
      platform: creator.platform,
      key: monitoredCreatorKey(creator),
    });
    setCreators(next);
  }, []);

  const handleToggle = useCallback(async (creator: MonitoredCreator, enabled: boolean) => {
    const next = await window.api.monitoredCreators.setEnabled({
      platform: creator.platform,
      key: monitoredCreatorKey(creator),
      enabled,
    });
    setCreators(next);
  }, []);

  // 2026-05-04 fix — re-resolve Twitch user_id from login. The user
  // sees this as "↻ 再取得" on each Twitch row. Useful when the
  // streamMonitor stops returning a known-live creator (most common
  // cause: stale user_id from a Gemini-misregistered handle, or the
  // streamer renaming their Twitch login).
  const handleRefetchTwitch = useCallback(async (creator: MonitoredCreator) => {
    if (creator.platform !== 'twitch') return;
    const res = await window.api.monitoredCreators.refetchTwitch({
      twitchUserId: creator.twitchUserId,
    });
    if (!res.ok) {
      alert(`再取得失敗: ${res.error ?? 'unknown error'}`);
      return;
    }
    // Refresh the full list so the renamed entry shows under its new
    // userId (and any displayName / login changes propagate).
    const next = await window.api.monitoredCreators.list();
    setCreators(next);
    if (res.updated) {
      const oldId = creator.twitchUserId;
      const newId = res.updated.platform === 'twitch' ? res.updated.twitchUserId : null;
      if (newId && oldId !== newId) {
        alert(`user_id が更新されました: ${oldId} → ${newId}`);
      } else {
        alert('user_id は最新の状態でした(変更なし)。配信検知されない場合は他の原因です。');
      }
    }
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.backButton}
          onClick={closeMonitoredCreators}
          title="戻る"
        >
          <ChevronLeft size={16} />
          戻る
        </button>
        <h1 className={styles.title}>登録チャンネル</h1>
      </div>

      <div className={styles.body}>
        {/* ---- Stream-monitor status bar (段階 X2) ---- */}
        <MonitorStatusBar
          status={monitorStatus}
          onToggle={handleToggleMonitor}
          onPollNow={handleManualPoll}
        />

        {/* ---- Sleep prevention toggle (段階 X4 fix) ---- */}
        <SleepPreventionRow
          enabled={preventSleep}
          onToggle={handleTogglePreventSleep}
          activeCount={recordings.filter((r) => r.status === 'recording').length}
        />

        {/* ---- Search section ---- */}
        <div className={styles.section}>
          <div className={styles.sectionLabel}>配信者を検索</div>
          <div className={styles.searchRow}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="配信者の名前(日本語可、例: 柊ツルギ / 葛葉)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch();
              }}
              spellCheck={false}
              autoComplete="off"
              disabled={searchState.kind === 'loading'}
            />
            <button
              type="button"
              className={styles.searchButton}
              onClick={handleSearch}
              disabled={!query.trim() || searchState.kind === 'loading'}
            >
              <Search size={16} />
              {searchState.kind === 'loading' ? '検索中…' : '検索'}
            </button>
          </div>
          <div className={styles.help}>
            Gemini で YouTube / Twitch のチャンネル候補を推定し、各プラットフォームの API でプロフィールを取得します。両方ヒットした場合は両方表示されます。
          </div>

          {/* 2026-05-04 — Threshold widget. Targets the API-fallback
              branch (Gemini results pass through regardless). */}
          <ThresholdWidget value={minFollowers} onChange={handleChangeMinFollowers} />

          {/* Manual-input fallback. Collapsed by default — visible
              entry point but not visually competing with the primary
              Gemini-driven flow. */}
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'var(--font-size-xs)',
              padding: '4px 0',
              textAlign: 'left',
            }}
          >
            {manualOpen ? '▼' : '▶'} Gemini で見つからない場合、手動で入力する
          </button>
          {manualOpen && (
            <div
              style={{
                marginTop: 6,
                padding: 10,
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(255,255,255,0.02)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Twitch ログイン名(URL の末尾、例: <span style={{ fontFamily: 'var(--font-mono)' }}>kato_junichi0817</span>)
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    className={styles.searchInput}
                    placeholder="例: kato_junichi0817"
                    value={manualTwitchLogin}
                    onChange={(e) => setManualTwitchLogin(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleManualTwitchFetch(); }}
                    spellCheck={false}
                    autoComplete="off"
                    style={{ padding: '6px 10px', fontSize: 'var(--font-size-sm)' }}
                  />
                  <button
                    type="button"
                    className={styles.searchButton}
                    onClick={() => void handleManualTwitchFetch()}
                    disabled={!manualTwitchLogin.trim() || manualBusy != null}
                    style={{ padding: '6px 14px' }}
                  >
                    {manualBusy === 'twitch' ? '取得中…' : 'Twitch で取得'}
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
                  YouTube チャンネル(@handle または UCxxxx... のチャンネル ID)
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    className={styles.searchInput}
                    placeholder="例: @kato または UCabcdef123..."
                    value={manualYouTubeInput}
                    onChange={(e) => setManualYouTubeInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleManualYouTubeFetch(); }}
                    spellCheck={false}
                    autoComplete="off"
                    style={{ padding: '6px 10px', fontSize: 'var(--font-size-sm)' }}
                  />
                  <button
                    type="button"
                    className={styles.searchButton}
                    onClick={() => void handleManualYouTubeFetch()}
                    disabled={!manualYouTubeInput.trim() || manualBusy != null}
                    style={{ padding: '6px 14px' }}
                  >
                    {manualBusy === 'youtube' ? '取得中…' : 'YouTube で取得'}
                  </button>
                </div>
              </div>
              {manualError && (
                <div className={styles.errorBox}>
                  <AlertCircle size={16} />
                  <span>{manualError}</span>
                </div>
              )}
              <div className={styles.help} style={{ marginTop: 0 }}>
                取得したプロフィールは検索結果に表示されます。「追加」を押すと通常通り確認ダイアログ → 登録の流れに乗ります。
              </div>
            </div>
          )}
        </div>

        {/* ---- Search results ---- */}
        {searchState.kind === 'error' && (
          <div className={styles.errorBox}>
            <AlertCircle size={16} />
            <span>{searchState.message}</span>
          </div>
        )}
        {searchState.kind === 'done' && searchState.cards.length === 0 && (
          <div>
            {searchState.warning && (
              <div className={styles.errorBox}>
                <AlertCircle size={16} />
                <span>{searchState.warning}</span>
              </div>
            )}
            <RelaxationHint
              filteredOutTotal={searchState.filteredOut.twitch + searchState.filteredOut.youtube}
              currentThreshold={searchState.thresholdApplied}
              onRetry={(threshold) => void runSearch(query, threshold)}
              onOpenManual={() => setManualOpen(true)}
            />
          </div>
        )}
        {searchState.kind === 'done' && searchState.cards.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>検索結果</div>
            {searchState.warning && (
              <div className={styles.errorBox} style={{ marginBottom: 8 }}>
                <AlertCircle size={16} />
                <span>{searchState.warning}</span>
              </div>
            )}
            <div className={styles.cardGrid}>
              {searchState.cards.map((card) => (
                <SearchResultCard
                  key={`${card.platform}:${card.platform === 'twitch' ? card.twitchUserId : card.youtubeChannelId}`}
                  card={card}
                  onAdd={() => setPendingAdd(card)}
                  alreadyAdded={creators.some((c) =>
                    c.platform === card.platform &&
                    monitoredCreatorKey(c) === (card.platform === 'twitch' ? card.twitchUserId : card.youtubeChannelId),
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* ---- Recordings (段階 X3+X4) ---- */}
        {recordings.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>
              録画済み動画{' '}
              <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
                ({recordings.length} 件、合計 {formatBytes(recordingsTotalBytes)})
              </span>
            </div>
            <div className={styles.creatorList}>
              {recordings.map((r) => (
                <RecordingRow
                  key={r.recordingId}
                  recording={r}
                  onOpen={() => void handleOpenInEditor(r)}
                  onStop={() => void handleStopRecording(r)}
                  onDelete={() => void handleDeleteRecording(r)}
                  onReveal={() => void handleRevealRecording(r)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ---- Registered list ---- */}
        <div className={styles.section}>
          <div className={styles.sectionLabel}>登録済み ({creators.length} 人)</div>
          {creators.length === 0 ? (
            <div className={styles.empty}>
              まだ配信者が登録されていません。上のフォームから検索 → 追加してください。
            </div>
          ) : (
            <div className={styles.creatorList}>
              {creators.map((c) => (
                <RegisteredRow
                  key={`${c.platform}:${monitoredCreatorKey(c)}`}
                  creator={c}
                  liveStream={liveByKey.get(`${c.platform}:${monitoredCreatorKey(c)}`) ?? null}
                  onRemove={() => handleRemove(c)}
                  onToggle={(enabled) => handleToggle(c, enabled)}
                  onRefetch={c.platform === 'twitch' ? () => void handleRefetchTwitch(c) : undefined}
                />
              ))}
            </div>
          )}
          <div className={styles.help}>
            段階 X1 では登録のみ。配信検知 + 自動録画は段階 X2-X4 で実装予定です。
          </div>
        </div>
      </div>

      {pendingAdd && (
        <ConfirmAddDialog
          card={pendingAdd}
          onConfirm={() => void confirmAdd()}
          onCancel={() => setPendingAdd(null)}
          submitting={adding}
        />
      )}
    </div>
  );
}

function SearchResultCard(props: {
  card: SearchCard;
  alreadyAdded: boolean;
  onAdd: () => void;
}) {
  const { card, alreadyAdded, onAdd } = props;
  const subText = card.platform === 'twitch'
    ? `@${card.twitchLogin}`
    : (card.youtubeHandle ?? card.youtubeChannelId);
  // Stats line: follower / subscriber count + warning badge.
  // The number is the user's primary signal for "this is the real
  // person, not an impostor with the same display name". 2026-05-04
  // refinement: dropped the openedAt date (redundant given the count)
  // and added an explicit warning badge for sub-10K accounts.
  const rawCount =
    card.platform === 'twitch' ? card.followerCount : card.subscriberCount;
  const countLabel = card.platform === 'twitch' ? 'フォロワー' : '登録者';
  const countValue = formatCount(rawCount);
  const warning = getFollowerWarning(rawCount);
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        {card.profileImageUrl ? (
          <img src={card.profileImageUrl} alt="" className={styles.cardAvatar} />
        ) : (
          <div className={styles.cardAvatarFallback} />
        )}
        <div className={styles.cardInfo}>
          <div className={styles.cardName}>{card.displayName}</div>
          <div className={styles.cardSub}>{subText}</div>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-muted)',
        }}
      >
        <span>{countLabel}: <strong style={{ color: 'var(--text-primary)' }}>{countValue}</strong></span>
        <FollowerWarningBadge warning={warning} />
      </div>
      <div>
        <span className={`${styles.platformTag} ${card.platform === 'twitch' ? styles.platformTagTwitch : styles.platformTagYoutube}`}>
          {PLATFORM_LABEL[card.platform]}
        </span>
        <SourceBadge source={card.source} />
      </div>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.addButton}
          onClick={onAdd}
          disabled={alreadyAdded}
          title={alreadyAdded ? '登録済み' : ''}
        >
          <Plus size={14} />
          {alreadyAdded ? '登録済み' : '追加'}
        </button>
      </div>
    </div>
  );
}

// Compact human-readable count: 543 / 1.2K / 10.5K / 1.2M / null="不明".
// Not perfectly i18n'd — this app is JP-only, "K"/"M" are universal
// enough that switching to 万/億 would be over-engineering.
// Threshold display: "20 万" / "100 万" / "なし". Japanese readers
// expect 万 over Western "K"/"M" for round-number population counts,
// even though formatCount stays Western for raw follower numbers.
function formatThreshold(n: number): string {
  if (n <= 0) return '閾値なし';
  if (n >= 10_000) return `${Math.floor(n / 10_000).toLocaleString()} 万`;
  return n.toLocaleString();
}

function formatCount(n: number | null): string {
  if (n == null) return '不明';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

// Quality thresholds for the impostor-warning badges. Tuned to the
// observed real-world data on 2026-05-04:
//   - The fake "JunichiKato" Twitch account had 15 followers
//   - The real 柊ツルギ had 436K
// 1K is a hard floor for "almost certainly the wrong person", 10K is
// "small / individual streamer territory — verify it's the one you
// meant". Same scale applied to YouTube subscribers.
const FOLLOWER_THRESHOLDS = {
  CRITICAL: 1000,
  LOW: 10_000,
} as const;

type FollowerWarning = 'critical' | 'low' | 'ok' | 'unknown';

function getFollowerWarning(count: number | null): FollowerWarning {
  if (count == null) return 'unknown';
  if (count < FOLLOWER_THRESHOLDS.CRITICAL) return 'critical';
  if (count < FOLLOWER_THRESHOLDS.LOW) return 'low';
  return 'ok';
}

// Renderable badge JSX or null. Centralised so SearchResultCard,
// RegisteredRow and ConfirmAddDialog share the same look — easier
// to retune later. Both 'ok' and 'unknown' produce no badge (the
// number itself, or "不明", is the only signal).
function FollowerWarningBadge(props: { warning: FollowerWarning }) {
  if (props.warning === 'critical') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '1px 6px',
          borderRadius: 999,
          background: 'rgba(239, 68, 68, 0.15)',
          color: '#ff7373',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 'var(--font-weight-medium)',
          marginLeft: 6,
        }}
        title="フォロワー / 登録者が 1K 未満。同名別人 / 偽物アカウントの可能性が高い"
      >
        🚨 誤登録の可能性
      </span>
    );
  }
  if (props.warning === 'low') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '1px 6px',
          borderRadius: 999,
          background: 'rgba(245, 158, 11, 0.15)',
          color: '#f59e0b',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 'var(--font-weight-medium)',
          marginLeft: 6,
        }}
        title="フォロワー / 登録者が 10K 未満。本人で合っているか確認してください"
      >
        ⚠ 要確認
      </span>
    );
  }
  return null;
}

// 2026-05-04 — Provenance chip for the search result card. Tells the
// user where this row came from so they can weight their judgement:
//   gemini       → green "✓ Gemini 推測"  — high prior, but could be wrong
//   api-fallback → yellow "⚠ API 検索結果" — multiple candidates, eyeball
//                                            the follower count
//   manual       → blue  "👤 手動入力"     — user typed handle directly
function SourceBadge(props: { source: CardSource }) {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-medium)',
    marginLeft: 6,
  };
  if (props.source === 'gemini') {
    return (
      <span
        style={{ ...base, background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80' }}
        title="Gemini が回答した推測。多くの場合は正しいが、同名別人を返すケースがあるので follower 数で確認を"
      >
        ✓ Gemini 推測
      </span>
    );
  }
  if (props.source === 'api-fallback') {
    return (
      <span
        style={{ ...base, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}
        title="Gemini に該当データなし。Twitch/YouTube の API 検索結果。フォロワー数で本人か必ず確認"
      >
        ⚠ API 検索結果
      </span>
    );
  }
  return (
    <span
      style={{ ...base, background: 'rgba(99, 102, 241, 0.15)', color: 'var(--accent-primary)' }}
      title="手動入力した handle / channelId から取得"
    >
      👤 手動入力
    </span>
  );
}

// 2026-05-04 — Persistent-threshold widget. Drives AppConfig.searchMinFollowers
// directly via window.api.saveSettings; preset buttons cover the four
// realistic decision points (5万 / 10万 / 20万 / 50万). The numeric
// input on the right lets a power user pick anything else, including
// 0 (= no filter, equivalent to pre-2026-05-04 behaviour).
function ThresholdWidget(props: { value: number; onChange: (n: number) => void }) {
  const presets = [50_000, 100_000, 200_000, 500_000, 1_000_000];
  const [draft, setDraft] = useState(String(props.value));
  // Sync draft when external value changes (preset click, settings load).
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        marginTop: 8,
        fontSize: 'var(--font-size-xs)',
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>API 検索結果の最小フォロワー / 登録者数:</span>
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => props.onChange(p)}
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            border: '1px solid ' + (props.value === p ? 'var(--accent-primary)' : 'var(--border-strong)'),
            background: props.value === p ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: props.value === p ? 'var(--accent-primary)' : 'var(--text-secondary)',
            fontSize: 'var(--font-size-xs)',
            cursor: 'pointer',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatThreshold(p)}
        </button>
      ))}
      <input
        type="number"
        min={0}
        step={10_000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n) && n >= 0) props.onChange(Math.floor(n));
          else setDraft(String(props.value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        style={{
          width: 90,
          padding: '2px 6px',
          background: 'rgba(0, 0, 0, 0.3)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontSize: 'var(--font-size-xs)',
          fontVariantNumeric: 'tabular-nums',
        }}
        title="0 = 閾値なし(API 検索結果すべて表示)"
      />
      <span style={{ color: 'var(--text-muted)' }}>人 (Gemini / 手動入力は閾値無視)</span>
    </div>
  );
}

// 2026-05-04 — Inline retry-with-lower-threshold button row. Shown
// only when filteredOutTotal > 0 (= "matches existed but got filtered
// out"). The 4 buttons each fire a one-shot search with the override;
// AppConfig stays untouched. The 5th button bounces the user into the
// manual-input fallback when even 0 produced nothing.
function RelaxationHint(props: {
  filteredOutTotal: number;
  currentThreshold: number;
  onRetry: (threshold: number) => void;
  onOpenManual: () => void;
}) {
  const candidates = [100_000, 50_000, 0].filter((t) => t < props.currentThreshold);
  if (props.filteredOutTotal === 0 && candidates.length === 0) {
    return (
      <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
        手動入力で直接 handle / channelId を指定するとこのフィルタを通らずに取得できます。
        <button
          type="button"
          onClick={props.onOpenManual}
          style={{ marginLeft: 8, padding: '2px 8px', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-primary)', fontSize: 'var(--font-size-xs)', cursor: 'pointer' }}
        >
          手動入力で探す
        </button>
      </div>
    );
  }
  if (candidates.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'rgba(245, 158, 11, 0.06)',
        border: '1px solid rgba(245, 158, 11, 0.25)',
        borderRadius: 'var(--radius-sm)',
        marginTop: 8,
        flexWrap: 'wrap',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-secondary)',
      }}
    >
      <span>閾値を下げて再検索:</span>
      {candidates.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => props.onRetry(t)}
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            border: '1px solid var(--border-strong)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-xs)',
            cursor: 'pointer',
          }}
        >
          {formatThreshold(t)}人で再検索
        </button>
      ))}
      <button
        type="button"
        onClick={props.onOpenManual}
        style={{
          padding: '2px 8px',
          borderRadius: 999,
          border: '1px solid var(--border-strong)',
          background: 'transparent',
          color: 'var(--accent-primary)',
          fontSize: 'var(--font-size-xs)',
          cursor: 'pointer',
        }}
      >
        手動入力で探す
      </button>
    </div>
  );
}

function RegisteredRow(props: {
  creator: MonitoredCreator;
  liveStream: LiveStreamInfo | null;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
  onRefetch?: () => void;
}) {
  const { creator, liveStream, onRemove, onToggle, onRefetch } = props;
  const subText = creator.platform === 'twitch'
    ? `@${creator.twitchLogin}`
    : (creator.youtubeHandle ?? creator.youtubeChannelId);
  // Stats line — same shape as SearchResultCard. Shows up below the
  // handle/login. For pre-2026-05-04 entries (no metadata captured at
  // register time), shows "不明" + suggests using the 再取得 button.
  const rawCount =
    creator.platform === 'twitch'
      ? creator.followerCount ?? null
      : creator.subscriberCount ?? null;
  const countLabel = creator.platform === 'twitch' ? 'フォロワー' : '登録者';
  const countValue = formatCount(rawCount);
  const warning = getFollowerWarning(rawCount);
  return (
    <div className={`${styles.creatorRow} ${!creator.enabled ? styles.disabled : ''}`}>
      {creator.profileImageUrl ? (
        <img src={creator.profileImageUrl} alt="" className={styles.cardAvatar} />
      ) : (
        <div className={styles.cardAvatarFallback} />
      )}
      <div className={styles.cardInfo}>
        <div className={styles.cardName}>
          {creator.displayName}
          {liveStream && <LiveBadge startedAt={liveStream.startedAt} />}
        </div>
        <div className={styles.cardSub}>
          {liveStream ? (
            <a
              href={liveStream.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}
              title={liveStream.title}
            >
              {liveStream.title || '配信中'}
            </a>
          ) : (
            subText
          )}
        </div>
        <div className={styles.cardSub} style={{ fontFamily: 'inherit', marginTop: 2 }}>
          {countLabel}: <strong style={{ color: 'var(--text-primary)' }}>{countValue}</strong>
          <FollowerWarningBadge warning={warning} />
        </div>
      </div>
      <span className={`${styles.platformTag} ${creator.platform === 'twitch' ? styles.platformTagTwitch : styles.platformTagYoutube}`}>
        {PLATFORM_LABEL[creator.platform]}
      </span>
      <label className={styles.toggleLabel} title="OFF にすると配信検知ポーリングの対象から外れます">
        <input
          type="checkbox"
          checked={creator.enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        監視中
      </label>
      {onRefetch && (
        <button
          type="button"
          className={styles.deleteButton}
          onClick={onRefetch}
          title="user_id を Twitch から再取得(配信検知されない時に試してください)"
          aria-label="再取得"
        >
          <RotateCw size={12} />
          再取得
        </button>
      )}
      <button
        type="button"
        className={styles.deleteButton}
        onClick={onRemove}
        title="削除"
        aria-label="削除"
      >
        <Trash2 size={12} />
        削除
      </button>
    </div>
  );
}

function LiveBadge(props: { startedAt: string }) {
  const minsAgo = Math.max(0, Math.floor((Date.now() - new Date(props.startedAt).getTime()) / 60_000));
  const label = minsAgo < 60
    ? `${minsAgo} 分前から`
    : `${Math.floor(minsAgo / 60)} 時間 ${minsAgo % 60} 分前から`;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 8,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'rgba(239, 68, 68, 0.15)',
        color: '#ff7373',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-medium)',
      }}
      title={`配信開始: ${new Date(props.startedAt).toLocaleString('ja-JP')}`}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#ef4444',
          boxShadow: '0 0 6px #ef4444',
        }}
      />
      配信中 ({label})
    </span>
  );
}

function MonitorStatusBar(props: {
  status: StreamMonitorStatus | null;
  onToggle: (enabled: boolean) => void;
  onPollNow: () => void;
}) {
  const { status, onToggle, onPollNow } = props;
  const enabled = status?.enabled ?? false;
  const liveCount = status?.liveStreams.length ?? 0;
  const lastLabel = status?.lastPollAt
    ? `最終チェック: ${relativeMinutes(status.lastPollAt)} 前`
    : '最終チェック: なし';
  const nextLabel = status?.nextPollAt && enabled
    ? `次回: ${relativeMinutesFuture(status.nextPollAt)}`
    : null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: enabled ? 'rgba(59, 130, 246, 0.06)' : 'rgba(255,255,255,0.02)',
      }}
    >
      <Radio
        size={16}
        color={enabled ? '#3b82f6' : 'var(--text-muted)'}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)' }}>
          配信監視: {enabled ? 'ON' : 'OFF'}
          {enabled && liveCount > 0 && (
            <span style={{ marginLeft: 8, color: '#ef4444' }}>
              ● {liveCount} 人配信中
            </span>
          )}
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {lastLabel}
          {nextLabel && <> · {nextLabel}</>}
          {status?.isRunning && <> · チェック中…</>}
        </div>
      </div>
      <button
        type="button"
        className={styles.deleteButton}
        onClick={onPollNow}
        disabled={!enabled || status?.isRunning}
        title="今すぐチェック"
        aria-label="今すぐチェック"
        style={{ padding: '4px 8px' }}
      >
        <RefreshCw size={12} />
        今すぐ
      </button>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        有効
      </label>
    </div>
  );
}

function SleepPreventionRow(props: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  activeCount: number;
}) {
  const { enabled, onToggle, activeCount } = props;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 14px',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: enabled ? 'rgba(245, 158, 11, 0.06)' : 'rgba(255,255,255,0.02)',
      }}
    >
      <span style={{ fontSize: 16 }}>🔋</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)' }}>
          PC スリープ防止
          {enabled && activeCount > 0 && (
            <span style={{ marginLeft: 8, color: '#f59e0b' }}>
              ● 録画中(防止 ON)
            </span>
          )}
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          録画中は PC をスリープさせません(深夜運用推奨)。ディスプレイは消えても録画は継続します。
        </div>
      </div>
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        有効
      </label>
    </div>
  );
}

function relativeMinutes(timestampMs: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - timestampMs) / 60_000));
  if (mins < 1) return '今';
  return `${mins} 分`;
}

function relativeMinutesFuture(timestampMs: number): string {
  const mins = Math.max(0, Math.ceil((timestampMs - Date.now()) / 60_000));
  if (mins < 1) return 'まもなく';
  return `${mins} 分後`;
}

function ConfirmAddDialog(props: {
  card: SearchCard;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const { card, onConfirm, onCancel, submitting } = props;
  const subText = card.platform === 'twitch'
    ? `@${card.twitchLogin}`
    : (card.youtubeHandle ?? card.youtubeChannelId);
  // Repeat the impostor-warning logic from the search-result card.
  // Critical = sub-1K = the "same name, different person" case we
  // saw with JunichiKato (15 followers) vs the real kato_junichi0817.
  // Show the count + warning prominently in the dialog so the user
  // gets one more chance to bail out.
  const rawCount =
    card.platform === 'twitch' ? card.followerCount : card.subscriberCount;
  const countLabel = card.platform === 'twitch' ? 'フォロワー' : '登録者';
  const countValue = formatCount(rawCount);
  const warning = getFollowerWarning(rawCount);
  return (
    <div className={styles.confirmBackdrop} onClick={onCancel}>
      <div className={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.confirmTitle}>以下のチャンネルを登録しますか?</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {card.profileImageUrl ? (
            <img src={card.profileImageUrl} alt="" className={styles.cardAvatar} />
          ) : (
            <div className={styles.cardAvatarFallback} />
          )}
          <div className={styles.cardInfo}>
            <div className={styles.cardName}>
              {card.displayName}
              <FollowerWarningBadge warning={warning} />
            </div>
            <div className={styles.cardSub}>
              <span className={`${styles.platformTag} ${card.platform === 'twitch' ? styles.platformTagTwitch : styles.platformTagYoutube}`} style={{ marginRight: 6 }}>
                {PLATFORM_LABEL[card.platform]}
              </span>
              {subText}
              {' · '}
              {countLabel}: <strong style={{ color: 'var(--text-primary)' }}>{countValue}</strong>
            </div>
          </div>
        </div>
        {warning === 'critical' && (
          <div
            style={{
              padding: 10,
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#ff7373',
              fontSize: 'var(--font-size-sm)',
              lineHeight: 1.5,
            }}
          >
            🚨 この {card.platform === 'twitch' ? 'チャンネル' : 'チャンネル'}は{countLabel}が <strong>{countValue}</strong> と少なく、本人ではない可能性が高いです。本当に登録しますか?
          </div>
        )}
        {warning === 'low' && (
          <div className={styles.errorBox}>
            <AlertTriangle size={16} />
            <span>{countLabel}が {countValue} と少なめです。本人で合っているか確認してください。</span>
          </div>
        )}
        {card.source === 'api-fallback' && (
          <div className={styles.errorBox}>
            <AlertTriangle size={16} />
            <span>Gemini が情報を持っていなかったため API 検索結果から表示しています。同名別人の可能性があるので、follower 数 / handle 文字列を必ず確認してください。</span>
          </div>
        )}
        <div className={styles.help}>
          誤登録防止のため確認しています。同一人物が両プラットフォームで活動している場合、それぞれ別エントリとして登録します。
        </div>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.deleteButton}
            onClick={onCancel}
            disabled={submitting}
          >
            キャンセル
          </button>
          <button
            type="button"
            className={styles.searchButton}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? '登録中…' : warning === 'critical' ? 'それでも登録する' : '登録する'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- 段階 X3+X4 helpers -----

const RECORDING_STATUS_LABEL: Record<RecordingMetadata['status'], string> = {
  recording: '録画中(LIVE)',
  'live-ended': 'ライブ終了 — VOD 待機中',
  'vod-fetching': 'VOD 取得中',
  completed: '完成',
  failed: '失敗',
};

const RECORDING_STATUS_COLOR: Record<RecordingMetadata['status'], string> = {
  recording: '#ef4444',
  'live-ended': 'var(--text-muted)',
  'vod-fetching': 'var(--accent-primary)',
  completed: 'var(--accent-success)',
  failed: 'var(--accent-danger)',
};

function formatBytes(b: number): string {
  if (b <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(k)));
  return `${(b / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDateRange(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : null;
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!end) return `${fmt(start)} - 録画中`;
  return `${fmt(start)} - ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

function RecordingRow(props: {
  recording: RecordingMetadata;
  onOpen: () => void;
  onStop: () => void;
  onDelete: () => void;
  onReveal: () => void;
}) {
  const { recording, onOpen, onStop, onDelete, onReveal } = props;
  // 2026-05-04 — Multi-segment recordings (yt-dlp respawned mid-stream
  // due to fragment-fetch failure) report a `liveSegments` array. The
  // displayed total bytes is the sum across all segments + VOD;
  // `fileSizeBytes.live` only ever holds the latest segment.
  const segmentCount = recording.liveSegments?.length ?? (recording.files.live ? 1 : 0);
  const liveSegmentTotal = recording.liveSegmentSizes
    ? recording.liveSegmentSizes.reduce((a, b) => a + b, 0)
    : (recording.fileSizeBytes.live ?? 0);
  const totalBytes = liveSegmentTotal + (recording.fileSizeBytes.vod ?? 0);
  const isRecording = recording.status === 'recording';
  const canEdit = !!(recording.files.vod ?? recording.files.live);
  return (
    <div className={styles.creatorRow}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 'var(--radius-md)',
          background: 'rgba(255,255,255,0.06)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
        }}
      >
        <Film size={20} />
      </div>
      <div className={styles.cardInfo}>
        <div className={styles.cardName}>
          {recording.displayName}{' '}
          <span
            className={`${styles.platformTag} ${recording.platform === 'twitch' ? styles.platformTagTwitch : styles.platformTagYoutube}`}
            style={{ marginLeft: 4 }}
          >
            {recording.platform === 'twitch' ? 'Twitch' : 'YouTube'}
          </span>
        </div>
        <div className={styles.cardSub} style={{ fontFamily: 'inherit' }}>
          {recording.title || '(タイトル未取得)'}
        </div>
        <div className={styles.cardSub} style={{ fontFamily: 'inherit', marginTop: 2 }}>
          <span style={{ color: RECORDING_STATUS_COLOR[recording.status], fontWeight: 'var(--font-weight-medium)' }}>
            ● {RECORDING_STATUS_LABEL[recording.status]}
          </span>
          {' · '}
          {formatDateRange(recording.startedAt, recording.endedAt)}
          {' · '}
          {formatBytes(totalBytes)}
          {segmentCount > 1 && (
            <>
              {' · '}
              <span title="yt-dlp が中断 → 自動再起動した分割録画です。最新セグメントが「編集を開始」で開きます" style={{ color: 'var(--accent-warning, #f59e0b)' }}>
                {segmentCount} ファイル分割(再起動 {(recording.restartCount ?? segmentCount - 1)} 回)
              </span>
            </>
          )}
        </div>
        {recording.errorMessage && (
          <div className={styles.cardSub} style={{ color: 'var(--accent-danger)', marginTop: 2 }}>
            ⚠ {recording.errorMessage}
          </div>
        )}
      </div>
      {canEdit && (
        <button
          type="button"
          className={styles.searchButton}
          onClick={onOpen}
          title="編集を開始"
          style={{ padding: '6px 12px' }}
        >
          <Edit3 size={14} />
          編集を開始
        </button>
      )}
      <button
        type="button"
        className={styles.deleteButton}
        onClick={onReveal}
        title="フォルダを開く"
        aria-label="フォルダを開く"
      >
        <FolderOpen size={12} />
      </button>
      {isRecording ? (
        <button
          type="button"
          className={styles.deleteButton}
          onClick={onStop}
          title="録画停止"
          aria-label="録画停止"
        >
          <StopCircle size={12} />
          停止
        </button>
      ) : (
        <button
          type="button"
          className={styles.deleteButton}
          onClick={onDelete}
          title="削除"
          aria-label="削除"
        >
          <Trash2 size={12} />
          削除
        </button>
      )}
    </div>
  );
}


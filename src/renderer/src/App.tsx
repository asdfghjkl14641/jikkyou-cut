import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from './store/editorStore';
import { useSettings } from './hooks/useSettings';
import { useEditKeyboard } from './hooks/useEditKeyboard';
import { useProjectAutoSave } from './hooks/useProjectAutoSave';
import DropZone from './components/DropZone';
import RecentVideosSection from './components/RecentVideosSection';
import VideoPlayer, {
  type VideoPlayerHandle,
} from './components/VideoPlayer';
import ApiKeySetupBanner from './components/ApiKeySetupBanner';
import RestoreBanner from './components/RestoreBanner';
import SettingsDialog from './components/SettingsDialog';
import ApiManagementView from './components/ApiManagementView';
import MonitoredCreatorsView from './components/MonitoredCreatorsView';
import { OperationsDialog } from './components/OperationsDialog';
import TranscribeButton from './components/TranscribeButton';
import EditableTranscriptList from './components/EditableTranscriptList';
import Timeline from './components/Timeline';
import ExportPreview from './components/ExportPreview';
import ExportProgressDialog from './components/ExportProgressDialog';
import TranscriptionContextForm from './components/TranscriptionContextForm';
import type { TranscriptionContext } from '../../common/config';
import { X, Settings, Scissors, Subtitles, ChevronLeft } from 'lucide-react';
import SubtitleSettingsDialog from './components/SubtitleSettingsDialog';
import UrlDownloadProgressDialog, { buildDialogProgress } from './components/UrlDownloadProgressDialog';
import TermsOfServiceModal from './components/TermsOfServiceModal';
import ClipSelectView from './components/ClipSelectView';
import type { UrlDownloadProgress } from '../../common/types';
import styles from './App.module.css';

// Prototype-stage default for the DropZone URL input: while we're
// iterating on a single test video, this saves the user from pasting it
// every launch. Used only as a fallback when `lastDownloadUrl` is null —
// any previously-downloaded URL takes precedence.
const PROTOTYPE_DEFAULT_URL = 'https://www.youtube.com/watch?v=O5gI5cIM4Yc&t=3s';

// 2026-05-04 — Mirror of main/urlDownload.deriveSessionId for the
// recognised platforms (YouTube watch + youtu.be short + Twitch
// /videos/<id>). Used by the parallel-DL flow to set state.sessionId
// synchronously so comment-analysis progress events fired BEFORE
// audio resolves don't hit the stale-session drop. Returns null for
// unrecognised URLs — caller falls back to waiting for audio in that
// case (rare; covers SoundCloud / Vimeo / etc.). The hash fallback
// path in main is intentionally NOT mirrored here — those URLs are
// rare and the existing await-audio path still works for them.
function deriveSessionIdSync(url: string): string | null {
  const ytWatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (ytWatch) return `youtube_${ytWatch[1]}`;
  const ytShort = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (ytShort) return `youtube_${ytShort[1]}`;
  const twitch = url.match(/twitch\.tv\/.*\/?videos?\/(\d+)/) ?? url.match(/\/videos\/(\d+)/);
  if (twitch) return `twitch_${twitch[1]}`;
  return null;
}

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const phase = useEditorStore((s) => s.phase);
  // Stage 6a — when the user backs out of an active URL session
  // (clearFile sets sessionId to null), abort any in-flight chat
  // replay yt-dlp process so we stop wasting bandwidth.
  const sessionId = useEditorStore((s) => s.sessionId);
  const prevSessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    console.log(
      '[comment-debug:app] sessionId watcher fire: prev=',
      prevSessionIdRef.current,
      'next=',
      sessionId,
    );
    if (prevSessionIdRef.current && !sessionId) {
      console.log('[comment-debug:app] >>> sessionId went null, calling commentAnalysis.cancel()');
      void window.api.commentAnalysis.cancel().catch(() => {});
    }
    prevSessionIdRef.current = sessionId;
  }, [sessionId]);
  const setPhase = useEditorStore((s) => s.setPhase);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setCurrentSec = useEditorStore((s) => s.setCurrentSec);
  const restoreFromProject = useEditorStore((s) => s.restoreFromProject);

  const {
    view,
    save,
    validateApiKey,
    setApiKey,
    clearApiKey,
    validateAnthropicApiKey,
    setAnthropicApiKey,
    clearAnthropicApiKey,
  } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // API management is now a phase, not a modal — this is removed in
  // favour of useEditorStore's openApiManagement / closeApiManagement.
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  const [downloadProgressOpen, setDownloadProgressOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<UrlDownloadProgress | null>(null);
  // 2026-05-04 — Sibling progress slots so the 4-bar dialog can show
  // video/comment/scoring even while audio is still downloading. Each
  // is updated by the matching IPC stream during startDownloadFlow.
  const [videoDlProgress, setVideoDlProgress] = useState<{ active: boolean; done: boolean; percent: number }>({ active: false, done: false, percent: 0 });
  const [commentProgress, setCommentProgress] = useState<{ active: boolean; done: boolean; phase: 'chat' | 'viewers' | 'scoring' | null }>({ active: false, done: false, phase: null });
  const [scoringDone, setScoringDone] = useState(false);
  // URL waiting on TOS acceptance. Captured the moment the user submits in
  // DropZone; consumed once the TOS modal is accepted (or cleared on
  // cancel). Without this, the URL the user typed gets lost between TOS
  // accept and the actual download start.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  const loadSubtitleSettings = useEditorStore((s) => s.loadSubtitleSettings);

  useEffect(() => {
    void loadSubtitleSettings();

    // アプリ起動時にダウンロード済みフォントを @font-face として CSS に登録
    async function registerInstalledFonts() {
      try {
        const installedFonts = await window.api.fonts.listInstalled();
        for (const font of installedFonts) {
          const fontUrl = `file://${font.filePath.replace(/\\/g, '/')}`;
          const fontFace = new FontFace(font.family, `url("${fontUrl}")`);
          await fontFace.load();
          document.fonts.add(fontFace);
        }
      } catch (err) {
        console.warn('Failed to register installed fonts', err);
      }
    }
    void registerInstalledFonts();
  }, [loadSubtitleSettings]);

  // Hydrate the in-memory collaborationMode + expectedSpeakerCount from
  // disk. We use a low-level setState rather than the public setters so
  // this initial sync doesn't trigger another saveSettings round-trip.
  // `view` arrives async from useSettings — guarded so we only fire once
  // per non-null value.
  useEffect(() => {
    if (!view) return;
    useEditorStore.setState({
      collaborationMode: view.config.collaborationMode,
      expectedSpeakerCount: view.config.expectedSpeakerCount,
    });
  }, [view]);

  const videoRef = useRef<VideoPlayerHandle>(null);

  // `nonce` lets the banner remount (and re-trigger its fade animation +
  // auto-dismiss timer) when a different restore happens for a new file.
  const [restoreInfo, setRestoreInfo] = useState<{
    total: number;
    deleted: number;
    nonce: number;
  } | null>(null);

  const dismissRestoreBanner = useCallback(() => setRestoreInfo(null), []);

  useEditKeyboard({
    togglePlayPause: () => videoRef.current?.togglePlayPause(),
  });

  useProjectAutoSave();

  // Try to restore an existing `<basename>.jcut.json` whenever a video is
  // loaded. If none exists, the cues stay empty and the user has to run a
  // fresh transcription.
  useEffect(() => {
    // Clear any leftover banner from a previous video before the new
    // loadProject call settles.
    setRestoreInfo(null);
    if (!filePath) return;
    let alive = true;
    window.api
      .loadProject(filePath)
      .then((project) => {
        if (!alive || !project || !project.cues || project.cues.length === 0) return;
        restoreFromProject(project);
        const deleted = project.cues.reduce((n, c) => n + (c.deleted ? 1 : 0), 0);
        setRestoreInfo({
          total: project.cues.length,
          deleted,
          nonce: Date.now(),
        });
      })
      .catch((err) => {
        console.warn('[project] load failed:', err);
      });
    return () => {
      alive = false;
    };
  }, [filePath, restoreFromProject]);

  useEffect(
    () =>
      window.api.onMenuOpenFile(async () => {
        const absPath = await window.api.openFileDialog();
        if (absPath) setFile(absPath);
      }),
    [setFile],
  );

  useEffect(
    () => window.api.onMenuOpenSettings(() => setSettingsOpen(true)),
    [],
  );

  useEffect(
    () => window.api.onMenuOpenOperations?.(() => setOperationsOpen(true)),
    [],
  );

  useEffect(
    // Menu / Ctrl+Shift+A → swap to api-management phase. The store
    // tracks where we came from so the back button restores it.
    () => window.api.onMenuOpenApiManagement?.(() =>
      useEditorStore.getState().openApiManagement(),
    ),
    [],
  );

  useEffect(
    // 段階 X1 — Menu / Ctrl+Shift+M → swap to monitored-creators phase.
    // Same swap-in pattern as api-management; the editing video state
    // (filePath / clipSegments / cues) survives untouched.
    () => window.api.onMenuOpenMonitoredCreators?.(() =>
      useEditorStore.getState().openMonitoredCreators(),
    ),
    [],
  );

  // 段階 X2 — track live-stream count globally so the floating
  // indicator below can show across all phases (edit / clip-select /
  // load). Updated by status events and on initial mount.
  const [liveCount, setLiveCount] = useState(0);
  useEffect(() => {
    void window.api.streamMonitor?.getStatus().then((s) => setLiveCount(s.liveStreams.length));
    const off = window.api.streamMonitor?.onStatus((s) => setLiveCount(s.liveStreams.length));
    return off;
  }, []);
  
  useEffect(() => {
    window.api.setWindowTitle(fileName || '');
  }, [fileName]);

  const handleContextChange = useCallback(
    (next: TranscriptionContext) => {
      void save({ transcriptionContext: next });
    },
    [save],
  );

  const handleSeek = useCallback((sec: number) => {
    videoRef.current?.seekTo(sec);
  }, []);

  // Drives the actual yt-dlp download. Resolves outputDir from settings;
  // if the user hasn't picked one yet, prompts a directory picker on first
  // run and persists the choice. Quality also comes from saved settings
  // (default 'best'). Only called after TOS has been accepted.
  const startDownloadFlow = useCallback(
    async (url: string) => {
      console.log('[comment-debug:app] startDownloadFlow entry: url=', url);
      if (!view) return;

      // Resolve output directory: persisted preference, or prompt once.
      let outputDir = view.config.defaultDownloadDir;
      if (!outputDir) {
        const picked = await window.api.openDirectoryDialog();
        if (!picked) return;
        outputDir = picked;
        await save({ defaultDownloadDir: picked });
      }

      const quality = view.config.defaultDownloadQuality || 'best';

      // 2026-05-04 — TRUE parallel kickoff for ALL background work.
      // Same-tick fires:
      //   - metadata pre-fetch (yt-dlp --skip-download, ~1-3 sec)
      //   - audio DL
      //   - video DL
      // Once metadata resolves, comment analysis fires (it needs
      // durationSec). On Twitch VODs where audio = full HLS length
      // (~17 min for an 11h stream), this is the difference between
      // comment fetch waiting 17 min vs starting after 2 sec.
      setDownloadProgressOpen(true);
      setDownloadProgress(null);
      setVideoDlProgress({ active: true, done: false, percent: 0 });
      setCommentProgress({ active: false, done: false, phase: null });
      setScoringDone(false);
      const audioCleanup = window.api.urlDownload.onAudioProgress((p) => {
        setDownloadProgress(p);
      });

      const videoCleanup = window.api.urlDownload.onVideoProgress((p) => {
        const ratio = Number.isFinite(p.percent) ? p.percent / 100 : 0;
        useEditorStore.getState().setVideoDownloadProgress(Math.max(0, Math.min(1, ratio)));
        // Mirror to dialog state so the 4-bar UI updates while
        // audio is still downloading.
        setVideoDlProgress((prev) => ({
          active: !prev.done,
          done: prev.done,
          percent: Number.isFinite(p.percent) ? p.percent : prev.percent,
        }));
      });
      const videoPromise = window.api.urlDownload.startVideoOnly({
        url,
        quality,
        outputDir,
        // sessionId omitted — main derives from URL.
      });

      // Fire metadata pre-fetch + comment analysis synchronously. The
      // sessionId we use to gate "stale session" drops is derived
      // from the URL right now (same regex main uses) — that lets
      // comment events arriving BEFORE audio.resolve survive the
      // store check. For URLs we can't classify (unknown), fall back
      // to the legacy "wait for audio.sessionId" path below.
      const earlySessionId = deriveSessionIdSync(url);
      let commentProgressCleanup: (() => void) | null = null;
      let commentPromise: Promise<unknown> | null = null;
      if (earlySessionId) {
        commentProgressCleanup = window.api.commentAnalysis.onProgress((p) => {
          const state = useEditorStore.getState();
          if (state.sessionId !== earlySessionId) return;
          if (state.commentAnalysisStatus.kind !== 'loading') return;
          state.setCommentAnalysisStatus({ kind: 'loading', phase: p.phase });
          // Mirror to dialog state. 'scoring' phase moves to its own row.
          setCommentProgress({ active: true, done: false, phase: p.phase });
          if (p.phase === 'scoring' && p.percent >= 100) {
            setScoringDone(true);
          }
        });
        commentPromise = window.api.urlDownload
          .fetchMetadata({ url })
          .then((meta) => {
            if (meta.durationSec == null) {
              throw new Error('duration unavailable from metadata pre-fetch');
            }
            console.log(
              `[comment-debug:app] firing comment analysis early: durationSec=${meta.durationSec} (audio not yet resolved)`,
            );
            useEditorStore.getState().setCommentAnalysisStatus({ kind: 'loading', phase: 'chat' });
            setCommentProgress({ active: true, done: false, phase: 'chat' });
            return window.api.commentAnalysis.start({
              sourceUrl: url,
              durationSec: meta.durationSec,
            });
          })
          .then((analysis) => {
            commentProgressCleanup?.();
            setCommentProgress({ active: false, done: true, phase: null });
            setScoringDone(true);
            const state = useEditorStore.getState();
            if (state.sessionId !== earlySessionId) return;
            state.setCommentAnalysisStatus({ kind: 'ready', analysis });
          })
          .catch((err) => {
            commentProgressCleanup?.();
            setCommentProgress({ active: false, done: false, phase: null });
            const state = useEditorStore.getState();
            const msg = err instanceof Error ? err.message : String(err);
            if (state.sessionId !== earlySessionId) return;
            state.setCommentAnalysisStatus({ kind: 'error', message: msg });
          });
      }

      let audio;
      try {
        audio = await window.api.urlDownload.startAudioOnly({ url, outputDir });
      } catch (err) {
        setDownloadProgressOpen(false);
        audioCleanup();
        videoCleanup();
        // Audio failure invalidates the whole flow — cancel the in-flight
        // video DL too so we don't leak a long-running process the user
        // can no longer reach.
        void window.api.urlDownload.cancelVideo().catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== 'TRANSCRIPTION_CANCELLED' && msg !== 'EXPORT_CANCELLED') {
          alert(`音声ダウンロードに失敗しました: ${msg}`);
        }
        return;
      }
      audioCleanup();
      setDownloadProgressOpen(false);
      console.log(
        '[comment-debug:app] audio result: sessionId=',
        audio.sessionId,
        'audioFilePath=',
        audio.audioFilePath,
        'durationSec=',
        audio.durationSec,
      );

      // Open ClipSelectView immediately — AI extract is unblocked from
      // here. videoFilePath stays null until the background DL below
      // resolves; the view shows a DL overlay in the player area.
      console.log(
        '[comment-debug:app] enterClipSelectFromUrl called with sessionId=',
        audio.sessionId,
      );
      useEditorStore.getState().enterClipSelectFromUrl({
        audioFilePath: audio.audioFilePath,
        sessionId: audio.sessionId,
        sourceUrl: url,
        durationSec: audio.durationSec,
        fileName: audio.videoTitle,
      });
      console.log(
        '[comment-debug:app] post-enterClipSelectFromUrl, store sessionId=',
        useEditorStore.getState().sessionId,
      );
      void save({ lastDownloadUrl: url });

      // 2026-05-04 — Comment analysis was already fired from
      // metadata.then() above (when the URL is a recognised platform).
      // For unknown URLs (no early sessionId), fire it here as the
      // legacy fallback so we still get an analysis attempt.
      const expectedSession = earlySessionId ?? audio.sessionId;
      if (!commentPromise) {
        useEditorStore.getState().setCommentAnalysisStatus({ kind: 'loading', phase: 'chat' });
        const cleanup = window.api.commentAnalysis.onProgress((p) => {
          const state = useEditorStore.getState();
          if (state.sessionId !== expectedSession) return;
          if (state.commentAnalysisStatus.kind !== 'loading') return;
          state.setCommentAnalysisStatus({ kind: 'loading', phase: p.phase });
        });
        void window.api.commentAnalysis
          .start({
            sourceUrl: url,
            durationSec: audio.durationSec,
          })
          .then((analysis) => {
            cleanup();
            const state = useEditorStore.getState();
            if (state.sessionId !== expectedSession) return;
            state.setCommentAnalysisStatus({ kind: 'ready', analysis });
          })
          .catch((err) => {
            cleanup();
            const state = useEditorStore.getState();
            const msg = err instanceof Error ? err.message : String(err);
            if (state.sessionId !== expectedSession) return;
            state.setCommentAnalysisStatus({ kind: 'error', message: msg });
          });
      }
      // Reference commentPromise so unused-var lint doesn't fire when
      // the legacy fallback path is taken.
      void commentPromise;

      // Global patterns preload — file-read in main, ms-scale. Failure
      // is silent: autoExtract still loads internally on the main side
      // when the time comes, so the worst case is just no preload.
      void window.api.aiSummary
        .loadGlobalPatterns()
        .then((patterns) => {
          const state = useEditorStore.getState();
          if (state.sessionId !== expectedSession) return;
          state.setGlobalPatterns(patterns);
        })
        .catch(() => {
          // intentional: best-effort cache, autoExtract has its own fallback
        });

      // 2026-05-04 — Video DL is already in flight (fired before the
      // audio await). Attach the result/error handlers now that we
      // know the canonical sessionId from the resolved audio.
      videoPromise
        .then((result) => {
          videoCleanup();
          setVideoDlProgress({ active: false, done: true, percent: 100 });
          const state = useEditorStore.getState();
          if (state.sessionId === result.sessionId) {
            state.setVideoFilePath(result.videoFilePath);
          }
        })
        .catch((err) => {
          videoCleanup();
          setVideoDlProgress({ active: false, done: false, percent: 0 });
          const msg = err instanceof Error ? err.message : String(err);
          const state = useEditorStore.getState();
          if (state.sessionId === audio.sessionId) {
            state.setVideoDownloadFailure(msg);
          }
        });
    },
    [view, save],
  );

  // Entry point from DropZone. If TOS hasn't been accepted yet, stash the
  // URL and show the modal first; otherwise go straight to the download.
  const handleUrlDownloadRequested = useCallback(
    (url: string) => {
      if (!view) return;
      if (view.config.urlDownloadAccepted) {
        void startDownloadFlow(url);
      } else {
        setPendingUrl(url);
        setTosOpen(true);
      }
    },
    [view, startDownloadFlow],
  );

  const handleTosAccept = useCallback(async () => {
    await save({ urlDownloadAccepted: true });
    setTosOpen(false);
    if (pendingUrl) {
      const url = pendingUrl;
      setPendingUrl(null);
      void startDownloadFlow(url);
    }
  }, [save, pendingUrl, startDownloadFlow]);

  const handleTosClose = useCallback(() => {
    setTosOpen(false);
    setPendingUrl(null);
  }, []);

  const handleCancelDownload = useCallback(() => {
    window.api.urlDownload.cancel();
    setDownloadProgressOpen(false);
  }, []);

  const apiKeyConfigured = view?.hasApiKey ?? false;
  const showBanner = view != null && !apiKeyConfigured;

  // Full-screen swap to API management — replaces everything
  // (header / banner / phase-body) so the user gets a clean view.
  // SettingsDialog stays mounted via the main-return path below; we
  // close it implicitly on swap because the same store action pushes
  // 'api-management' onto phase, which doesn't render the dialog
  // host. (The dialog's <dialog> element is in the unrendered tree
  // for as long as we're on this phase.)
  if (phase === 'api-management' && view) {
    return (
      <main className={styles.app}>
        <ApiManagementView
          hasGladia={view.hasApiKey}
          hasAnthropic={view.hasAnthropicApiKey}
          onValidateGladia={validateApiKey}
          onSaveGladia={setApiKey}
          onClearGladia={clearApiKey}
          onValidateAnthropic={validateAnthropicApiKey}
          onSaveAnthropic={setAnthropicApiKey}
          onClearAnthropic={clearAnthropicApiKey}
        />
      </main>
    );
  }

  // 段階 X1 — full-screen monitored-creators page. Same swap-in idiom
  // as api-management: editing state survives untouched, back button
  // restores previousPhase.
  if (phase === 'monitored-creators') {
    return (
      <main className={styles.app}>
        <MonitoredCreatorsView />
      </main>
    );
  }

  return (
    <main className={styles.app}>
      {/* 段階 X2 — global live-stream indicator. Pinned top-right so
          it doesn't interfere with the per-phase header. The
          monitored-creators / api-management phases are early-returned
          above, so by reaching here the indicator only renders on the
          editing phases (load / clip-select / edit). */}
      {liveCount > 0 && (
        <button
          type="button"
          onClick={() => useEditorStore.getState().openMonitoredCreators()}
          title={`${liveCount} 人が配信中です。クリックで登録チャンネル画面を開く`}
          style={{
            position: 'fixed',
            top: 8,
            right: 12,
            zIndex: 50,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: 999,
            background: 'rgba(239, 68, 68, 0.15)',
            color: '#ff7373',
            fontFamily: 'inherit',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 'var(--font-weight-medium)',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
          }}
          aria-label={`${liveCount} 人配信中`}
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
          {liveCount} 人配信中
        </button>
      )}
      {phase === 'edit' && (
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button
              type="button"
              className={styles.backToClipSelect}
              onClick={() => setPhase('clip-select')}
              title="切り抜き範囲を選び直す"
            >
              <ChevronLeft strokeWidth={2} size={18} />
              範囲を選び直す
            </button>
            {view && (
              <TranscriptionContextForm
                initial={view.config.transcriptionContext}
                onChange={handleContextChange}
              />
            )}
            <TranscribeButton apiKeyConfigured={apiKeyConfigured} />
          </div>
          <div className={styles.headerRight}>
            {fileName && (
              <div className={styles.fileInfo}>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={clearFile}
                  title="動画を閉じる"
                >
                  <X strokeWidth={1.5} size={18} />
                </button>
              </div>
            )}
            <button
              type="button"
              className={`${styles.iconButton} ${styles.settingsButton}`}
              onClick={() => setSubtitleSettingsOpen(true)}
              title="字幕設定"
            >
              <Subtitles strokeWidth={1.5} size={18} />
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.settingsButton}`}
              onClick={() => setSettingsOpen(true)}
              title="設定"
            >
              <Settings strokeWidth={1.5} size={18} />
            </button>
          </div>
        </header>
      )}

      {showBanner && (
        <ApiKeySetupBanner onOpenSettings={() => setSettingsOpen(true)} />
      )}

      {restoreInfo && (
        <RestoreBanner
          key={restoreInfo.nonce}
          total={restoreInfo.total}
          deleted={restoreInfo.deleted}
          onDismiss={dismissRestoreBanner}
        />
      )}

      <section className={styles.body}>
        {phase === 'load' && (
          <div className={styles.bodyEmpty}>
            <DropZone
              onFileSelected={setFile}
              onUrlDownloadRequested={handleUrlDownloadRequested}
              defaultUrl={view?.config.lastDownloadUrl ?? PROTOTYPE_DEFAULT_URL}
            />
            {/* 2026-05-04 — Inline feed of auto-recorded streams +
                URL-downloaded VODs from the last 24h. Self-hides when
                empty, so a fresh install sees just the DropZone. */}
            <RecentVideosSection />
          </div>
        )}

        {phase === 'clip-select' && <ClipSelectView />}

        {phase === 'edit' && filePath && (
          <>
            <div className={styles.topHalf}>
              <div className={styles.videoArea}>
                <VideoPlayer
                  ref={videoRef}
                  filePath={filePath}
                  onDuration={setDuration}
                  onCurrentTime={setCurrentSec}
                />
              </div>
              <div className={styles.transcriptArea}>
                <EditableTranscriptList onSeek={handleSeek} />
              </div>
            </div>
            <div className={styles.bottomHalf}>
              <ExportPreview />
              <Timeline onSeek={handleSeek} />
            </div>
          </>
        )}
      </section>

      {view && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          // The Settings dialog still owns the "open API management"
          // hand-off button; it now triggers the phase swap.
          onOpenApiManagement={() => useEditorStore.getState().openApiManagement()}
        />
      )}
      <OperationsDialog
        isOpen={operationsOpen}
        onClose={() => setOperationsOpen(false)}
      />
      {subtitleSettingsOpen && (
        <SubtitleSettingsDialog
          open={subtitleSettingsOpen}
          onClose={() => setSubtitleSettingsOpen(false)}
        />
      )}

      <ExportProgressDialog />

      <TermsOfServiceModal
        isOpen={tosOpen}
        onAccept={handleTosAccept}
        onClose={handleTosClose}
      />

      <UrlDownloadProgressDialog
        isOpen={downloadProgressOpen}
        progress={buildDialogProgress({
          audio: {
            active: downloadProgressOpen,
            done: false,
            raw: downloadProgress,
          },
          video: videoDlProgress,
          comment: commentProgress,
          scoringDone,
        })}
        onCancel={handleCancelDownload}
      />
    </main>
  );
}

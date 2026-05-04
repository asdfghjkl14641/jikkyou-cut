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
import UrlDownloadProgressDialog from './components/UrlDownloadProgressDialog';
import TermsOfServiceModal from './components/TermsOfServiceModal';
import ClipSelectView from './components/ClipSelectView';
import type { UrlDownloadProgress } from '../../common/types';
import styles from './App.module.css';

// Prototype-stage default for the DropZone URL input: while we're
// iterating on a single test video, this saves the user from pasting it
// every launch. Used only as a fallback when `lastDownloadUrl` is null —
// any previously-downloaded URL takes precedence.
const PROTOTYPE_DEFAULT_URL = 'https://www.youtube.com/watch?v=O5gI5cIM4Yc&t=3s';

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

      // Stage 2 — audio-first / video-background split.
      // Phase A: await the audio-only DL (fast, ~tens of seconds even
      // for long streams). When this resolves, the user can already
      // run AI extract on the resulting audio file.
      setDownloadProgressOpen(true);
      setDownloadProgress(null);
      const audioCleanup = window.api.urlDownload.onAudioProgress((p) => {
        setDownloadProgress(p);
      });

      let audio;
      try {
        audio = await window.api.urlDownload.startAudioOnly({ url, outputDir });
      } catch (err) {
        setDownloadProgressOpen(false);
        audioCleanup();
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

      // Stage 6a — fire comment analysis + global patterns in parallel
      // with the video DL. Pre-stage 6a these triggered only after
      // ClipSelectView mounted + ran a useEffect; bringing them up here
      // means by the time the user sees the view, chat is usually
      // already loading and patterns are cached.
      const expectedSession = audio.sessionId;
      console.log('[comment-debug:app] commentAnalysis IPC fire: expectedSession=', expectedSession);
      useEditorStore.getState().setCommentAnalysisStatus({ kind: 'loading', phase: 'chat' });
      const commentProgressCleanup = window.api.commentAnalysis.onProgress((p) => {
        const state = useEditorStore.getState();
        console.log(
          '[comment-debug:app] progress event:',
          'phase=', p.phase,
          'storeSessionId=', state.sessionId,
          'expected=', expectedSession,
          'storeStatus=', state.commentAnalysisStatus.kind,
        );
        // Drop progress events from a stale session (user moved on).
        if (state.sessionId !== expectedSession) {
          console.log('[comment-debug:app] >>> progress dropped: session mismatch');
          return;
        }
        // Don't regress 'ready' / 'error' back to 'loading' if a late
        // progress event arrives.
        if (state.commentAnalysisStatus.kind !== 'loading') {
          console.log('[comment-debug:app] >>> progress dropped: status not loading');
          return;
        }
        state.setCommentAnalysisStatus({ kind: 'loading', phase: p.phase });
      });
      void window.api.commentAnalysis
        .start({
          videoFilePath: audio.audioFilePath,
          sourceUrl: url,
          durationSec: audio.durationSec,
        })
        .then((analysis) => {
          commentProgressCleanup();
          const state = useEditorStore.getState();
          console.log(
            '[comment-debug:app] commentAnalysis result received:',
            'messages.length=', analysis.allMessages.length,
            'storeSessionId=', state.sessionId,
            'expected=', expectedSession,
            'match=', state.sessionId === expectedSession,
          );
          if (state.sessionId !== expectedSession) {
            console.log('[comment-debug:app] >>> result DROPPED due to session mismatch');
            return;
          }
          console.log('[comment-debug:app] >>> setting status to ready');
          state.setCommentAnalysisStatus({ kind: 'ready', analysis });
          console.log(
            '[comment-debug:app] post-set: storeStatus=',
            useEditorStore.getState().commentAnalysisStatus.kind,
          );
        })
        .catch((err) => {
          commentProgressCleanup();
          const state = useEditorStore.getState();
          const msg = err instanceof Error ? err.message : String(err);
          console.log(
            '[comment-debug:app] commentAnalysis IPC rejected:',
            'err=', msg,
            'storeSessionId=', state.sessionId,
            'expected=', expectedSession,
          );
          if (state.sessionId !== expectedSession) return;
          state.setCommentAnalysisStatus({ kind: 'error', message: msg });
        });

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

      // Phase B: kick off the video DL in the background. The user can
      // start picking clips off the audio-only ClipSelectView while
      // this runs. Progress + completion flow into the editor store
      // (ClipSelectView reads videoDownloadStatus to render the
      // overlay; setVideoFilePath replaces it with the <video>).
      const videoCleanup = window.api.urlDownload.onVideoProgress((p) => {
        const ratio = Number.isFinite(p.percent) ? p.percent / 100 : 0;
        useEditorStore.getState().setVideoDownloadProgress(Math.max(0, Math.min(1, ratio)));
      });
      void window.api.urlDownload
        .startVideoOnly({ url, quality, outputDir, sessionId: audio.sessionId })
        .then((result) => {
          videoCleanup();
          // Only adopt the video file if the user is still on the same
          // session — bailing the editor out (clearFile) wipes
          // audioFilePath / sessionId. The check protects against a
          // stale promise resolving after the user moved on.
          const state = useEditorStore.getState();
          if (state.sessionId === result.sessionId) {
            state.setVideoFilePath(result.videoFilePath);
          }
        })
        .catch((err) => {
          videoCleanup();
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
        progress={downloadProgress}
        onCancel={handleCancelDownload}
      />
    </main>
  );
}

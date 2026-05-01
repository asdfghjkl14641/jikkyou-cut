import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from './store/editorStore';
import { useSettings } from './hooks/useSettings';
import { useEditKeyboard } from './hooks/useEditKeyboard';
import { useProjectAutoSave } from './hooks/useProjectAutoSave';
import DropZone from './components/DropZone';
import VideoPlayer, {
  type VideoPlayerHandle,
} from './components/VideoPlayer';
import ApiKeySetupBanner from './components/ApiKeySetupBanner';
import RestoreBanner from './components/RestoreBanner';
import SettingsDialog from './components/SettingsDialog';
import { OperationsDialog } from './components/OperationsDialog';
import TranscribeButton from './components/TranscribeButton';
import EditableTranscriptList from './components/EditableTranscriptList';
import Timeline from './components/Timeline';
import ExportPreview from './components/ExportPreview';
import ExportProgressDialog from './components/ExportProgressDialog';
import TranscriptionContextForm from './components/TranscriptionContextForm';
import type { TranscriptionContext } from '../../common/config';
import { X, Settings, Scissors, Subtitles } from 'lucide-react';
import SubtitleSettingsDialog from './components/SubtitleSettingsDialog';
import UrlDownloadDialog from './components/UrlDownloadDialog';
import UrlDownloadProgressDialog from './components/UrlDownloadProgressDialog';
import TermsOfServiceModal from './components/TermsOfServiceModal';
import type { UrlDownloadArgs, UrlDownloadProgress } from '../../common/types';
import styles from './App.module.css';

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setCurrentSec = useEditorStore((s) => s.setCurrentSec);
  const restoreFromProject = useEditorStore((s) => s.restoreFromProject);

  const { view, save, validateApiKey, setApiKey, clearApiKey } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false);
  const [urlDownloadOpen, setUrlDownloadOpen] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  const [downloadProgressOpen, setDownloadProgressOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<UrlDownloadProgress | null>(null);

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

  const handleUrlDownloadClick = useCallback(() => {
    if (!view) return;
    if (view.config.urlDownloadAccepted) {
      setUrlDownloadOpen(true);
    } else {
      setTosOpen(true);
    }
  }, [view]);

  const handleTosAccept = useCallback(async () => {
    await save({ urlDownloadAccepted: true });
    setTosOpen(false);
    setUrlDownloadOpen(true);
  }, [save]);

  const handleStartDownload = useCallback(async (args: UrlDownloadArgs) => {
    setUrlDownloadOpen(false);
    setDownloadProgressOpen(true);
    setDownloadProgress(null);

    // Save settings
    void save({
      defaultDownloadDir: args.outputDir,
      defaultDownloadQuality: args.quality,
    });

    const cleanup = window.api.urlDownload.onProgress((p) => {
      setDownloadProgress(p);
    });

    try {
      const result = await window.api.urlDownload.start(args);
      setDownloadProgressOpen(false);
      // Auto open
      setFile(result.filePath);
    } catch (err: any) {
      setDownloadProgressOpen(false);
      if (err.message !== 'TRANSCRIPTION_CANCELLED' && err.message !== 'EXPORT_CANCELLED') {
        alert(`ダウンロードに失敗しました: ${err.message}`);
      }
    } finally {
      cleanup();
    }
  }, [save, setFile]);

  const handleCancelDownload = useCallback(() => {
    window.api.urlDownload.cancel();
    setDownloadProgressOpen(false);
  }, []);

  const apiKeyConfigured = view?.hasApiKey ?? false;
  const showBanner = view != null && !apiKeyConfigured;

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
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
        {filePath ? (
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
        ) : (
          <div className={styles.bodyEmpty}>
            <DropZone 
              onFileSelected={setFile} 
              onUrlDownloadRequested={handleUrlDownloadClick}
            />
          </div>
        )}
      </section>

      {view && (
        <SettingsDialog
          open={settingsOpen}
          hasApiKey={view.hasApiKey}
          onClose={() => setSettingsOpen(false)}
          onValidateApiKey={validateApiKey}
          onSaveApiKey={setApiKey}
          onClearApiKey={clearApiKey}
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
        onClose={() => setTosOpen(false)}
      />

      {view && (
        <UrlDownloadDialog
          isOpen={urlDownloadOpen}
          onClose={() => setUrlDownloadOpen(false)}
          onDownload={handleStartDownload}
          defaultDir={view.config.defaultDownloadDir}
          defaultQuality={view.config.defaultDownloadQuality}
        />
      )}

      <UrlDownloadProgressDialog
        isOpen={downloadProgressOpen}
        progress={downloadProgress}
        onCancel={handleCancelDownload}
      />
    </main>
  );
}

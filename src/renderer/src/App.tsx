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
import TranscribeButton from './components/TranscribeButton';
import EditableTranscriptList from './components/EditableTranscriptList';
import TranscriptionContextForm from './components/TranscriptionContextForm';
import type { TranscriptionContext } from '../../common/config';
import styles from './App.module.css';

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setDuration = useEditorStore((s) => s.setDuration);
  const restoreFromProject = useEditorStore((s) => s.restoreFromProject);

  const { view, save, validateApiKey, setApiKey, clearApiKey } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      .then((cues) => {
        if (!alive || !cues || cues.length === 0) return;
        restoreFromProject(cues);
        const deleted = cues.reduce((n, c) => n + (c.deleted ? 1 : 0), 0);
        setRestoreInfo({
          total: cues.length,
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

  const handleContextChange = useCallback(
    (next: TranscriptionContext) => {
      void save({ transcriptionContext: next });
    },
    [save],
  );

  const handleSeek = useCallback((sec: number) => {
    videoRef.current?.seekTo(sec);
  }, []);

  const apiKeyConfigured = view?.hasApiKey ?? false;
  const showBanner = view != null && !apiKeyConfigured;

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>jikkyou-cut</h1>
        <div className={styles.headerRight}>
          {fileName && (
            <div className={styles.fileInfo}>
              <span>{fileName}</span>
              <button
                type="button"
                className={styles.iconButton}
                onClick={clearFile}
              >
                閉じる
              </button>
            </div>
          )}
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setSettingsOpen(true)}
            title="設定"
          >
            ⚙ 設定
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
            <div className={styles.left}>
              <VideoPlayer
                ref={videoRef}
                filePath={filePath}
                onDuration={setDuration}
              />
            </div>
            <div className={styles.right}>
              {view && (
                <TranscriptionContextForm
                  initial={view.config.transcriptionContext}
                  onChange={handleContextChange}
                />
              )}
              <TranscribeButton apiKeyConfigured={apiKeyConfigured} />
              <EditableTranscriptList onSeek={handleSeek} />
            </div>
          </>
        ) : (
          <div className={styles.bodyEmpty}>
            <DropZone onFileSelected={setFile} />
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
    </main>
  );
}

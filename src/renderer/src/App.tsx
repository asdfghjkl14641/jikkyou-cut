import { useEffect, useState, useCallback } from 'react';
import { useEditorStore } from './store/editorStore';
import { useSettings } from './hooks/useSettings';
import DropZone from './components/DropZone';
import VideoPlayer from './components/VideoPlayer';
import ApiKeySetupBanner from './components/ApiKeySetupBanner';
import SettingsDialog from './components/SettingsDialog';
import TranscribeButton from './components/TranscribeButton';
import TranscriptList from './components/TranscriptList';
import TranscriptionContextForm from './components/TranscriptionContextForm';
import type { TranscriptionContext } from '../../common/config';
import styles from './App.module.css';

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setDuration = useEditorStore((s) => s.setDuration);

  const { view, save, validateApiKey, setApiKey, clearApiKey } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

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

      <section className={styles.body}>
        {filePath ? (
          <>
            <div className={styles.left}>
              <VideoPlayer filePath={filePath} onDuration={setDuration} />
            </div>
            <div className={styles.right}>
              {view && (
                <TranscriptionContextForm
                  initial={view.config.transcriptionContext}
                  onChange={handleContextChange}
                />
              )}
              <TranscribeButton apiKeyConfigured={apiKeyConfigured} />
              <TranscriptList />
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

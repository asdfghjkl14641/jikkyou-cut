import { useEffect, useState } from 'react';
import { useEditorStore } from './store/editorStore';
import { useSettings } from './hooks/useSettings';
import DropZone from './components/DropZone';
import VideoPlayer from './components/VideoPlayer';
import ModelSetupBanner from './components/ModelSetupBanner';
import SettingsDialog from './components/SettingsDialog';
import TranscribeButton from './components/TranscribeButton';
import TranscriptList from './components/TranscriptList';
import styles from './App.module.css';

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);
  const setDuration = useEditorStore((s) => s.setDuration);

  const { settings, save } = useSettings();
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

  const modelConfigured = !!settings?.whisperModelPath;
  const showBanner = settings != null && !modelConfigured;

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
        <ModelSetupBanner onOpenSettings={() => setSettingsOpen(true)} />
      )}

      <section className={styles.body}>
        {filePath ? (
          <>
            <div className={styles.left}>
              <VideoPlayer filePath={filePath} onDuration={setDuration} />
            </div>
            <div className={styles.right}>
              <TranscribeButton modelConfigured={modelConfigured} />
              <TranscriptList />
            </div>
          </>
        ) : (
          <div className={styles.bodyEmpty}>
            <DropZone onFileSelected={setFile} />
          </div>
        )}
      </section>

      {settings && (
        <SettingsDialog
          open={settingsOpen}
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={save}
        />
      )}
    </main>
  );
}

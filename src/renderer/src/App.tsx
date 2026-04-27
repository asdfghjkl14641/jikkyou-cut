import { useEffect } from 'react';
import { useEditorStore } from './store/editorStore';
import DropZone from './components/DropZone';
import VideoPlayer from './components/VideoPlayer';
import styles from './App.module.css';

export default function App() {
  const filePath = useEditorStore((s) => s.filePath);
  const fileName = useEditorStore((s) => s.fileName);
  const setFile = useEditorStore((s) => s.setFile);
  const clearFile = useEditorStore((s) => s.clearFile);

  useEffect(
    () =>
      window.api.onMenuOpenFile(async () => {
        const absPath = await window.api.openFileDialog();
        if (absPath) setFile(absPath);
      }),
    [setFile],
  );

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>jikkyou-cut</h1>
        {fileName && (
          <div className={styles.fileInfo}>
            <span>{fileName}</span>
            <button
              type="button"
              className={styles.closeButton}
              onClick={clearFile}
            >
              閉じる
            </button>
          </div>
        )}
      </header>
      <section className={styles.body}>
        {filePath ? (
          <VideoPlayer filePath={filePath} />
        ) : (
          <DropZone onFileSelected={setFile} />
        )}
      </section>
    </main>
  );
}

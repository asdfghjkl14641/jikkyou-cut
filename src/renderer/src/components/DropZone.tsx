import { useCallback, useState, type DragEvent } from 'react';
import styles from './DropZone.module.css';

type Props = {
  onFileSelected: (absPath: string) => void;
};

export default function DropZone({ onFileSelected }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const handleClick = useCallback(async () => {
    const absPath = await window.api.openFileDialog();
    if (absPath) onFileSelected(absPath);
  }, [onFileSelected]);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const absPath = window.api.getPathForFile(file);
      if (absPath) onFileSelected(absPath);
    },
    [onFileSelected],
  );

  return (
    <button
      type="button"
      className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={styles.primary}>動画ファイルをここにドロップ</div>
      <div className={styles.secondary}>または クリックして選択</div>
    </button>
  );
}

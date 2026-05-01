import { useCallback, useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import styles from './DropZone.module.css';

type Props = {
  onFileSelected: (absPath: string) => void;
  onUrlDownloadRequested: () => void;
};

export default function DropZone({ onFileSelected, onUrlDownloadRequested }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState('');

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

  const isValidUrl = (val: string) => {
    return /youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/|twitch\.tv\/videos\/|twitch\.tv\/.+\/v\//.test(val);
  };

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={styles.iconWrapper}>
          <UploadCloud size={40} className={styles.icon} />
        </div>
        <div className={styles.textContainer}>
          <div className={styles.primary}>動画ファイルをここにドロップ</div>
          <div className={styles.secondary}>クリックしてメニューから選択</div>
        </div>
      </button>

      <div className={styles.urlSection}>

        <div className={styles.urlInputWrapper}>
          <input
            type="text"
            className={styles.urlInput}
            placeholder="YouTube または Twitch のURLを入力"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            type="button"
            className={styles.downloadButton}
            disabled={!isValidUrl(url)}
            onClick={onUrlDownloadRequested}
          >
            ダウンロード
          </button>
        </div>
      </div>
    </div>
  );
}


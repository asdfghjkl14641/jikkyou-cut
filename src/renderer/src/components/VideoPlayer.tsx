import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import styles from './VideoPlayer.module.css';

type Props = { filePath: string };

const toMediaUrl = (absPath: string) =>
  `media://localhost/${encodeURIComponent(absPath)}`;

export default function VideoPlayer({ filePath }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [filePath]);

  const handleError = (_e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaError = videoRef.current?.error;
    if (!mediaError) {
      setError('再生エラー: 不明な原因');
      return;
    }
    if (mediaError.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      setError(
        'このコーデックは未対応です。MP4 (H.264/AAC) または WebM (VP9/Opus) を試してください。',
      );
    } else {
      setError(`再生エラー (code=${mediaError.code}): ${mediaError.message}`);
    }
  };

  return (
    <div className={styles.player}>
      {error && <div className={styles.errorBanner}>{error}</div>}
      <video
        ref={videoRef}
        key={filePath}
        src={toMediaUrl(filePath)}
        controls
        className={styles.video}
        onError={handleError}
      />
    </div>
  );
}

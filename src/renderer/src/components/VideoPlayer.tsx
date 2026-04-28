import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import styles from './VideoPlayer.module.css';

type Props = {
  filePath: string;
  onDuration?: (sec: number) => void;
};

export type VideoPlayerHandle = {
  seekTo: (sec: number) => void;
  togglePlayPause: () => void;
};

const toMediaUrl = (absPath: string) =>
  `media://localhost/${encodeURIComponent(absPath)}`;

const NOT_SUPPORTED_DEFER_MS = 500;

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { filePath, onDuration },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const notSupportedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (sec) => {
        const v = videoRef.current;
        if (!v || !Number.isFinite(sec)) return;
        try {
          v.currentTime = sec;
        } catch {
          // ignore — readyState may be insufficient
        }
      },
      togglePlayPause: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
          v.play().catch(() => {
            // ignore — common when called before metadata is loaded
          });
        } else {
          v.pause();
        }
      },
    }),
    [],
  );

  useEffect(() => {
    setFatalError(null);
    setNetworkWarning(null);
    if (notSupportedTimerRef.current) {
      clearTimeout(notSupportedTimerRef.current);
      notSupportedTimerRef.current = null;
    }
  }, [filePath]);

  useEffect(
    () => () => {
      if (notSupportedTimerRef.current) {
        clearTimeout(notSupportedTimerRef.current);
      }
    },
    [],
  );

  const handleError = (_e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaError = videoRef.current?.error;
    if (!mediaError) return;

    switch (mediaError.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return;

      case MediaError.MEDIA_ERR_NETWORK:
        console.warn('[video] MEDIA_ERR_NETWORK:', mediaError.message);
        setNetworkWarning(
          'ネットワークエラー: 動画の読み込みに問題がありました',
        );
        return;

      case MediaError.MEDIA_ERR_DECODE:
        console.warn('[video] MEDIA_ERR_DECODE:', mediaError.message);
        return;

      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: {
        console.warn(
          '[video] MEDIA_ERR_SRC_NOT_SUPPORTED (deferred 500ms):',
          mediaError.message,
        );
        if (notSupportedTimerRef.current) {
          clearTimeout(notSupportedTimerRef.current);
        }
        notSupportedTimerRef.current = setTimeout(() => {
          notSupportedTimerRef.current = null;
          const stillError = videoRef.current?.error;
          if (
            stillError &&
            stillError.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ) {
            setFatalError(
              'このコーデックは未対応です。MP4 (H.264/AAC) または WebM (VP9/Opus) を試してください。',
            );
          } else {
            console.warn('[video] SRC_NOT_SUPPORTED was transient — recovered');
          }
        }, NOT_SUPPORTED_DEFER_MS);
        return;
      }

      default:
        console.warn(
          `[video] unknown error code=${mediaError.code}:`,
          mediaError.message,
        );
        return;
    }
  };

  const handlePlaying = () => {
    if (notSupportedTimerRef.current) {
      clearTimeout(notSupportedTimerRef.current);
      notSupportedTimerRef.current = null;
    }
    if (networkWarning) setNetworkWarning(null);
  };

  const handleLoadedMetadata = () => {
    const d = videoRef.current?.duration;
    if (d != null && Number.isFinite(d) && d > 0) {
      onDuration?.(d);
    }
  };

  return (
    <div className={styles.player}>
      {fatalError && <div className={styles.errorBanner}>{fatalError}</div>}
      {!fatalError && networkWarning && (
        <div className={styles.warningBanner}>{networkWarning}</div>
      )}
      <video
        ref={videoRef}
        key={filePath}
        src={toMediaUrl(filePath)}
        controls
        className={styles.video}
        onError={handleError}
        onPlaying={handlePlaying}
        onLoadedMetadata={handleLoadedMetadata}
      />
    </div>
  );
});

export default VideoPlayer;

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  decidePreviewSkip,
  deriveKeptRegions,
} from '../../../common/segments';
import { AlertTriangle, XCircle } from 'lucide-react';
import styles from './VideoPlayer.module.css';

type Props = {
  filePath: string;
  onDuration?: (sec: number) => void;
  // Called frequently while playing (rAF), once on seek/pause/end.
  onCurrentTime?: (sec: number) => void;
};

export type VideoPlayerHandle = {
  seekTo: (sec: number) => void;
  togglePlayPause: () => void;
};

const toMediaUrl = (absPath: string) =>
  `media://localhost/${encodeURIComponent(absPath)}`;

const NOT_SUPPORTED_DEFER_MS = 500;
// Minimum time between two auto-skips. Prevents recursive seeking when the
// new currentTime momentarily lies in another deletion gap due to floating
// point boundaries or back-to-back deletions.
const SKIP_COOLDOWN_MS = 50;

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { filePath, onDuration, onCurrentTime },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const notSupportedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const onCurrentTimeRef = useRef(onCurrentTime);
  onCurrentTimeRef.current = onCurrentTime;

  const cues = useEditorStore((s) => s.cues);
  const previewMode = useEditorStore((s) => s.previewMode);

  const regions = useMemo(() => deriveKeptRegions(cues), [cues]);
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  const previewModeRef = useRef(previewMode);
  previewModeRef.current = previewMode;

  const lastSkipAtRef = useRef(0);

  const [fatalError, setFatalError] = useState<string | null>(null);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);

  const stopTicking = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const startTicking = () => {
    stopTicking();
    const tick = () => {
      const v = videoRef.current;
      if (!v) {
        rafRef.current = null;
        return;
      }
      onCurrentTimeRef.current?.(v.currentTime);

      // Preview-mode auto-skip: while ON and the video is actively playing,
      // jump out of any deletion gap into the next kept region.
      if (previewModeRef.current && !v.paused && !v.seeking) {
        const now = performance.now();
        if (now - lastSkipAtRef.current > SKIP_COOLDOWN_MS) {
          const decision = decidePreviewSkip(
            v.currentTime,
            regionsRef.current,
          );
          if (decision.kind === 'skip') {
            lastSkipAtRef.current = now;
            try {
              v.currentTime = decision.toSec;
            } catch {
              // ignore — readyState may be insufficient
            }
          } else if (decision.kind === 'end') {
            lastSkipAtRef.current = now;
            try {
              if (Number.isFinite(v.duration) && v.duration > 0) {
                v.currentTime = v.duration;
              }
            } catch {
              // ignore
            }
            v.pause();
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

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
    onCurrentTimeRef.current?.(0);
  }, [filePath]);

  useEffect(
    () => () => {
      if (notSupportedTimerRef.current) {
        clearTimeout(notSupportedTimerRef.current);
      }
      stopTicking();
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
    startTicking();
  };

  const handlePauseOrEnded = () => {
    stopTicking();
    const v = videoRef.current;
    if (v) onCurrentTimeRef.current?.(v.currentTime);
  };

  const handleSeeked = () => {
    const v = videoRef.current;
    if (v) onCurrentTimeRef.current?.(v.currentTime);
  };

  const handleLoadedMetadata = () => {
    const d = videoRef.current?.duration;
    if (d != null && Number.isFinite(d) && d > 0) {
      onDuration?.(d);
    }
  };

  return (
    <div className={styles.player}>
      {fatalError && (
        <div className={styles.errorBanner}>
          <XCircle strokeWidth={1.5} size={18} />
          <span>{fatalError}</span>
        </div>
      )}
      {!fatalError && networkWarning && (
        <div className={styles.warningBanner}>
          <AlertTriangle strokeWidth={1.5} size={18} />
          <span>{networkWarning}</span>
        </div>
      )}
      <video
        ref={videoRef}
        key={filePath}
        src={toMediaUrl(filePath)}
        controls
        className={styles.video}
        onError={handleError}
        onPlaying={handlePlaying}
        onPause={handlePauseOrEnded}
        onEnded={handlePauseOrEnded}
        onSeeked={handleSeeked}
        onLoadedMetadata={handleLoadedMetadata}
      />
    </div>
  );
});

export default VideoPlayer;

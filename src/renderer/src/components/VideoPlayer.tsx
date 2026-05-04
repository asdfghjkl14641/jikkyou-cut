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
import SubtitleOverlay from './SubtitleOverlay';
import styles from './VideoPlayer.module.css';

type Props = {
  filePath: string;
  onDuration?: (sec: number) => void;
  // Called frequently while playing (rAF), once on seek/pause/end.
  onCurrentTime?: (sec: number) => void;
  // Stage 4 — when transitioning from EmbeddedVideoPlayer to local
  // playback, the parent passes the embed's current time here so this
  // player resumes at the same position. Applied once on the first
  // `loadedmetadata` (subsequent values are ignored — re-mounting the
  // VideoPlayer is the supported way to restart at a new position).
  initialSec?: number;
  // True ⇒ auto-play after the initial seek lands. Used when the embed
  // was playing at the moment of the swap, so the user keeps watching
  // through the transition.
  shouldAutoPlay?: boolean;
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
  { filePath, onDuration, onCurrentTime, initialSec, shouldAutoPlay },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const notSupportedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const onCurrentTimeRef = useRef(onCurrentTime);
  onCurrentTimeRef.current = onCurrentTime;
  // Stage 4 — gate flag so initialSec / shouldAutoPlay only apply on
  // the first loadedmetadata after mount. Subsequent metadata events
  // (e.g. user opens a new file in the same session) reset because the
  // VideoPlayer remounts and the ref starts over.
  const initialSeekAppliedRef = useRef(false);
  const initialSecRef = useRef(initialSec);
  initialSecRef.current = initialSec;
  const shouldAutoPlayRef = useRef(shouldAutoPlay);
  shouldAutoPlayRef.current = shouldAutoPlay;

  const cues = useEditorStore((s) => s.cues);
  const durationSec = useEditorStore((s) => s.durationSec);
  const previewMode = useEditorStore((s) => s.previewMode);

  const regions = useMemo(
    () => deriveKeptRegions(cues, durationSec),
    [cues, durationSec],
  );
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
    // Notify store subscribers that an explicit seek just happened.
    // EditableTranscriptList uses this to scroll the current cue into view.
    useEditorStore.getState().bumpSeekNonce();
  };

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    const d = v.duration;
    if (d != null && Number.isFinite(d) && d > 0) {
      onDuration?.(d);
    }

    // Stage 4 — initial seek + autoplay on the embed→local handoff.
    // Apply once per mount; the parent re-mounts VideoPlayer for any
    // subsequent file swap, which resets the ref.
    if (!initialSeekAppliedRef.current) {
      initialSeekAppliedRef.current = true;
      const seek = initialSecRef.current;
      if (Number.isFinite(seek) && seek != null && seek > 0) {
        try {
          v.currentTime = seek;
        } catch {
          // ignore — readyState may still be insufficient on edge codecs
        }
      }
      if (shouldAutoPlayRef.current) {
        v.play().catch(() => {
          // ignore — autoplay may be blocked by browser policy in
          // dev mode (Electron usually allows but the catch keeps
          // the chain quiet either way)
        });
      }
    }
    // Capture intrinsic dimensions for export-time subtitle PlayResX/Y.
    // Skipped via the store guard if either is 0 (e.g. before metadata).
    useEditorStore.getState().setVideoDimensions(v.videoWidth, v.videoHeight);

    // Defensive volume reset. Chromium occasionally remembers a per-
    // element volume of 0 across reloads (especially with custom
    // protocols like media://), and Electron's autoplay policy can
    // muted-start a fresh element. Force audible defaults here so a
    // newly-loaded video is heard. The user can still drag the volume
    // slider down afterwards — those changes are kept until the next
    // file swap.
    if (v.muted) v.muted = false;
    if (v.volume === 0) v.volume = 1;

    // Defensive: enable every audioTrack the container exposes. Chromium
    // sometimes leaves alternate-language tracks disabled by default,
    // and we've also seen audio-track-zero come up `enabled=false` on
    // certain mp4s where ffmpeg merged a non-AAC audio stream. Walking
    // the list here covers both cases at zero cost.
    const tracks = (v as HTMLVideoElement & {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    }).audioTracks;
    if (tracks && typeof tracks.length === 'number') {
      for (let i = 0; i < tracks.length; i += 1) {
        const t = tracks[i];
        if (t && !t.enabled) t.enabled = true;
      }
    }

    // Diagnostic so we can see in DevTools whether the file actually
    // carries audio at all. Decoded byte count is the smoking gun: 0
    // throughout playback ⇒ codec/decoder problem; >0 but no sound ⇒
    // output-routing / volume problem.
    const audioByteCount = (v as HTMLVideoElement & {
      webkitAudioDecodedByteCount?: number;
    }).webkitAudioDecodedByteCount;
    console.log('[video-audio] loadedmetadata', {
      muted: v.muted,
      volume: v.volume,
      audioTracksLength: tracks?.length ?? null,
      audioDecodedByteCount: audioByteCount ?? null,
      readyState: v.readyState,
      duration: d,
    });
  };

  // Fire once when playback first becomes possible — at this point
  // Chromium has parsed enough of the container to know whether audio
  // is decodable. `webkitAudioDecodedByteCount` jumping to >0 here is
  // the positive signal we want.
  const handleCanPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    const audioByteCount = (v as HTMLVideoElement & {
      webkitAudioDecodedByteCount?: number;
    }).webkitAudioDecodedByteCount;
    console.log('[video-audio] canplay', {
      audioDecodedByteCount: audioByteCount ?? null,
      readyState: v.readyState,
    });
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
      <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
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
          onCanPlay={handleCanPlay}
        />
        <SubtitleOverlay />
      </div>
    </div>
  );
});

export default VideoPlayer;

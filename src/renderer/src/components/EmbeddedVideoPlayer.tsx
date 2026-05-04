import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  loadYouTubeIframeApi,
  type YTPlayer,
  type YTStateChangeEvent,
} from '../lib/youtubePlayerApi';
import {
  loadTwitchPlayerApi,
  type TwitchPlayer,
} from '../lib/twitchPlayerApi';
import styles from './EmbeddedVideoPlayer.module.css';

// Stage 3 — embedded YouTube IFrame / Twitch Embed player. Used while
// the local video file is still downloading (background) so the user
// can preview / pick clips immediately. Limitations vs the local
// VideoPlayer:
//   - No deletion-region preview skip (decidePreviewSkip is <video>-only)
//   - No subtitle overlay (SubtitleOverlay layers on a real <video>)
//   - Seek precision is keyframe-aligned on YouTube
// These are documented in the inline ClipSelectView hint and revisited
// when stage 4 implements the player swap on DL completion.

export type EmbeddedVideoPlayerHandle = {
  play: () => void;
  pause: () => void;
  seekTo: (sec: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
};

type Props = {
  // Stage 2 sessionId — `youtube_<11chars>` / `twitch_<numeric>` /
  // `url_<sha256>`. Only the first two map to embed players; `url_*`
  // (custom HTTP URLs) renders a fallback message — there's no
  // generic embedded player for arbitrary sources.
  sessionId: string;
  onReady?: () => void;
  onTimeUpdate?: (sec: number) => void;
  onDuration?: (sec: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
};

type Platform = 'youtube' | 'twitch' | 'unknown';

function parseSessionId(sessionId: string): { platform: Platform; mediaId: string } {
  if (sessionId.startsWith('youtube_')) {
    return { platform: 'youtube', mediaId: sessionId.slice('youtube_'.length) };
  }
  if (sessionId.startsWith('twitch_')) {
    return { platform: 'twitch', mediaId: sessionId.slice('twitch_'.length) };
  }
  return { platform: 'unknown', mediaId: sessionId };
}

// Twitch Embed requires the parent hostname(s) explicitly. In Electron:
//   - dev:  http://localhost:<port>  ⇒ 'localhost' matches
//   - prod: file://...               ⇒ no hostname; Twitch typically
//                                       rejects file:// origins outright
//                                       even with these fallbacks. The
//                                       prod path may need stage 5+
//                                       follow-up (custom protocol or
//                                       localhost server bridge).
// The list is tried in order by the Twitch SDK (it picks a matching
// origin). Adding more values here is harmless.
const TWITCH_PARENTS = ['localhost', '127.0.0.1', 'jikkyou-cut.local'];

const POLL_INTERVAL_MS = 500;
// Stage 5 — if the embed iframe fails to fire `ready` within this
// window, surface an explicit error. Twitch's X-Frame-Options +
// parent-mismatch rejections render an empty iframe with no event,
// which would otherwise leave the user staring at a blank player.
// 10 s is generous enough for slow networks but tight enough that the
// user gets feedback before they notice "stuck-ness".
const EMBED_READY_TIMEOUT_MS = 10_000;

const EmbeddedVideoPlayer = forwardRef<EmbeddedVideoPlayerHandle, Props>(
  function EmbeddedVideoPlayer(
    { sessionId, onReady, onTimeUpdate, onDuration, onPlayStateChange },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const ytPlayerRef = useRef<YTPlayer | null>(null);
    const twitchPlayerRef = useRef<TwitchPlayer | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Mirrors of callback props so the polling effect doesn't have to
    // re-subscribe every time the parent recreates the function.
    const onTimeUpdateRef = useRef(onTimeUpdate);
    onTimeUpdateRef.current = onTimeUpdate;
    const onDurationRef = useRef(onDuration);
    onDurationRef.current = onDuration;
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const onPlayStateChangeRef = useRef(onPlayStateChange);
    onPlayStateChangeRef.current = onPlayStateChange;

    const [error, setError] = useState<string | null>(null);

    const { platform, mediaId } = parseSessionId(sessionId);

    // Imperative handle. Both YT and Twitch players surface seek + play
    // + pause + getCurrentTime; the wrapper smooths over the slight API
    // name differences (seekTo vs seek, getCurrentTime vs same).
    useImperativeHandle(
      ref,
      () => ({
        play: () => {
          ytPlayerRef.current?.playVideo();
          twitchPlayerRef.current?.play();
        },
        pause: () => {
          ytPlayerRef.current?.pauseVideo();
          twitchPlayerRef.current?.pause();
        },
        seekTo: (sec) => {
          if (!Number.isFinite(sec)) return;
          ytPlayerRef.current?.seekTo(sec, true);
          twitchPlayerRef.current?.seek(sec);
        },
        getCurrentTime: () => {
          if (ytPlayerRef.current) return ytPlayerRef.current.getCurrentTime();
          if (twitchPlayerRef.current) return twitchPlayerRef.current.getCurrentTime();
          return 0;
        },
        getDuration: () => {
          if (ytPlayerRef.current) return ytPlayerRef.current.getDuration();
          if (twitchPlayerRef.current) return twitchPlayerRef.current.getDuration();
          return 0;
        },
      }),
      [],
    );

    // Mount + cleanup. Re-runs when sessionId changes (e.g. user opens
    // a different URL). The container's innerHTML is reset on each
    // mount so the prior iframe — if any — is removed cleanly.
    useEffect(() => {
      if (platform === 'unknown') {
        setError(`埋め込みプレイヤー非対応のセッション(${sessionId})`);
        return;
      }
      const container = containerRef.current;
      if (!container) return;

      let cancelled = false;
      setError(null);
      // Clean any previous mount from a sessionId switch.
      container.innerHTML = '';
      ytPlayerRef.current = null;
      twitchPlayerRef.current = null;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (readyTimerRef.current) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }

      // Arm the ready-or-fail watchdog. Cleared by the SDK's onReady /
      // ready event handlers below; if it fires, we paint a friendly
      // error so the user knows DL completion will rescue playback.
      readyTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        const platformLabel = platform === 'twitch' ? 'Twitch' : 'YouTube';
        setError(
          `${platformLabel} の埋め込み再生に失敗しました。動画ダウンロード完了後にローカル再生されます。`,
        );
      }, EMBED_READY_TIMEOUT_MS);

      // The host element each SDK populates with its iframe. Both APIs
      // accept either an id string or an HTMLElement; we use the
      // element directly to avoid id collisions across multiple
      // EmbeddedVideoPlayer instances.
      const host = document.createElement('div');
      host.style.width = '100%';
      host.style.height = '100%';
      container.appendChild(host);

      // Track whether we've delivered a real (>0) duration yet. YT/Twitch
      // both return 0 from getDuration() during initial buffering — emitting
      // that 0 to the parent overwrites the audio-probe duration that
      // segment 2's enterClipSelectFromUrl already set, which in turn
      // collapses ClipSelectView's `durationSec <= 0` gate and silently
      // cancels comment analysis. We wait until the SDK reports a real
      // value before forwarding it.
      let durationEmitted = false;
      const tryEmitDuration = (player: { getDuration: () => number }) => {
        if (durationEmitted) return;
        try {
          const d = player.getDuration();
          if (Number.isFinite(d) && d > 0) {
            onDurationRef.current?.(d);
            durationEmitted = true;
          }
        } catch {
          // ignore — try again on the next poll tick
        }
      };

      const startPolling = () => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = setInterval(() => {
          try {
            if (ytPlayerRef.current) {
              onTimeUpdateRef.current?.(ytPlayerRef.current.getCurrentTime());
              tryEmitDuration(ytPlayerRef.current);
            } else if (twitchPlayerRef.current) {
              onTimeUpdateRef.current?.(twitchPlayerRef.current.getCurrentTime());
              tryEmitDuration(twitchPlayerRef.current);
            }
          } catch {
            // SDKs occasionally throw during initial buffering; swallow
            // — next tick will try again.
          }
        }, POLL_INTERVAL_MS);
      };

      if (platform === 'youtube') {
        loadYouTubeIframeApi()
          .then((YT) => {
            if (cancelled) return;
            const player = new YT.Player(host, {
              videoId: mediaId,
              width: '100%',
              height: '100%',
              playerVars: {
                rel: 0,
                modestbranding: 1,
                playsinline: 1,
              },
              events: {
                onReady: () => {
                  if (cancelled) return;
                  if (readyTimerRef.current) {
                    clearTimeout(readyTimerRef.current);
                    readyTimerRef.current = null;
                  }
                  ytPlayerRef.current = player;
                  // Try once immediately; if duration isn't ready yet
                  // (very common — onReady fires before the first frame),
                  // the polling loop below will retry until success.
                  tryEmitDuration(player);
                  onReadyRef.current?.();
                  startPolling();
                },
                onStateChange: (e: YTStateChangeEvent) => {
                  // YT.PlayerState.PLAYING = 1, PAUSED = 2
                  if (e.data === 1) onPlayStateChangeRef.current?.(true);
                  else if (e.data === 2 || e.data === 0) {
                    onPlayStateChangeRef.current?.(false);
                  }
                },
                onError: (errEvt) => {
                  // Codes per YT API: 2 = invalid id, 5 = HTML5 player
                  // error, 100 = video not found, 101/150 = embed
                  // disallowed.
                  setError(`YouTube プレイヤーエラー (code=${errEvt.data})`);
                },
              },
            });
          })
          .catch((err) => {
            if (cancelled) return;
            setError(`YouTube IFrame API ロード失敗: ${err instanceof Error ? err.message : String(err)}`);
          });
      } else if (platform === 'twitch') {
        loadTwitchPlayerApi()
          .then((Twitch) => {
            if (cancelled) return;
            const player = new Twitch.Player(host, {
              video: mediaId,
              width: '100%',
              height: '100%',
              parent: TWITCH_PARENTS,
              autoplay: false,
            });
            twitchPlayerRef.current = player;
            // Twitch's READY event fires once the iframe + video is
            // playable. Duration becomes meaningful only after that —
            // and even then is sometimes 0 for the first hundred ms,
            // so we defer to the same poll-until-valid helper.
            player.addEventListener('ready', () => {
              if (cancelled) return;
              if (readyTimerRef.current) {
                clearTimeout(readyTimerRef.current);
                readyTimerRef.current = null;
              }
              tryEmitDuration(player);
              onReadyRef.current?.();
              startPolling();
            });
            player.addEventListener('play', () => onPlayStateChangeRef.current?.(true));
            player.addEventListener('pause', () => onPlayStateChangeRef.current?.(false));
            player.addEventListener('ended', () => onPlayStateChangeRef.current?.(false));
          })
          .catch((err) => {
            if (cancelled) return;
            setError(`Twitch SDK ロード失敗: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      return () => {
        cancelled = true;
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        if (readyTimerRef.current) {
          clearTimeout(readyTimerRef.current);
          readyTimerRef.current = null;
        }
        try {
          ytPlayerRef.current?.destroy();
        } catch {
          // SDK throws if iframe was already removed; ignore
        }
        ytPlayerRef.current = null;
        twitchPlayerRef.current = null;
        // Removing children also kills the iframe; Twitch has no destroy().
        if (container) container.innerHTML = '';
      };
    }, [platform, mediaId, sessionId]);

    return (
      <div className={styles.container}>
        {error ? (
          <div className={styles.error}>
            <div className={styles.errorIcon}>⚠</div>
            <div>{error}</div>
          </div>
        ) : (
          <div ref={containerRef} className={styles.iframeHost} />
        )}
      </div>
    );
  },
);

export default EmbeddedVideoPlayer;

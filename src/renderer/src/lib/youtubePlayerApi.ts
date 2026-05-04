// Singleton loader for the YouTube IFrame Player API. The script
// auto-installs a global `window.YT` and fires
// `window.onYouTubeIframeAPIReady` once. We promisify both so multiple
// EmbeddedVideoPlayer instances can await readiness without racing.

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Minimal subset of YT.Player surface that EmbeddedVideoPlayer uses.
// Avoids pulling in @types/youtube as a dependency.
export type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (sec: number, allowSeekAhead?: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
};

export type YTPlayerEvent = { target: YTPlayer };
export type YTStateChangeEvent = YTPlayerEvent & { data: number };

export type YTNamespace = {
  Player: new (
    elementOrId: string | HTMLElement,
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: YTPlayerEvent) => void;
        onStateChange?: (e: YTStateChangeEvent) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
};

let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window unavailable'));
  }
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        prevCallback?.();
      } catch {
        // ignore — chained callback shouldn't break readiness
      }
      if (window.YT) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube API loaded but window.YT missing'));
      }
    };
    const existing = document.querySelector(
      'script[src*="youtube.com/iframe_api"]',
    );
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('YouTube IFrame API script load failed'));
      document.head.appendChild(tag);
    }
    // 30 s safety timeout — script load can hang on bad networks.
    setTimeout(() => {
      if (!window.YT?.Player) {
        reject(new Error('YouTube IFrame API timed out'));
      }
    }, 30_000);
  });
  return apiPromise;
}

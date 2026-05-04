// Singleton loader for the Twitch Embed Player API. Twitch uses a
// callback-on-script-load pattern (no global ready event, the global
// `Twitch.Player` is available immediately after the script's onload).

declare global {
  interface Window {
    Twitch?: TwitchNamespace;
  }
}

export type TwitchPlayer = {
  play: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isPaused: () => boolean;
  // The SDK doesn't expose destroy(); removing the host element from
  // the DOM is enough. We wrap it as a noop so the consumer code can
  // call destroy() symmetrically with the YT side.
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
};

export type TwitchPlayerOptions = {
  width: string | number;
  height: string | number;
  video?: string;       // VOD ID
  channel?: string;     // live channel name
  parent: string[];     // required for embed; Electron uses ['localhost']
  autoplay?: boolean;
  muted?: boolean;
};

export type TwitchNamespace = {
  Player: new (elementOrId: string | HTMLElement, options: TwitchPlayerOptions) => TwitchPlayer;
};

let apiPromise: Promise<TwitchNamespace> | null = null;

export function loadTwitchPlayerApi(): Promise<TwitchNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window unavailable'));
  }
  if (window.Twitch?.Player) {
    return Promise.resolve(window.Twitch);
  }
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<TwitchNamespace>((resolve, reject) => {
    const existing = document.querySelector(
      'script[src*="player.twitch.tv/js/embed/v1.js"]',
    );
    const onReady = () => {
      if (window.Twitch?.Player) resolve(window.Twitch);
      else reject(new Error('Twitch SDK loaded but window.Twitch missing'));
    };
    if (existing) {
      // Another load already started; poll for readiness.
      const t = setInterval(() => {
        if (window.Twitch?.Player) {
          clearInterval(t);
          onReady();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(t);
        if (!window.Twitch?.Player) reject(new Error('Twitch SDK timed out'));
      }, 30_000);
      return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://player.twitch.tv/js/embed/v1.js';
    tag.async = true;
    tag.onload = onReady;
    tag.onerror = () => reject(new Error('Twitch SDK script load failed'));
    document.head.appendChild(tag);
  });
  return apiPromise;
}

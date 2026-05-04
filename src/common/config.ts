export type TranscriptionContext = {
  gameTitle: string;
  characters: string;
  catchphrases: string;
  notes: string;
};

export const DEFAULT_CONTEXT: TranscriptionContext = {
  gameTitle: '',
  characters: '',
  catchphrases: '',
  notes: '',
};

export type AppConfig = {
  transcriptionContext: TranscriptionContext;
  // Collaboration mode toggle. When true, transcription requests
  // diarization (speaker separation). Default `false` because most users
  // record solo gameplay commentary; flipping ON is a deliberate signal
  // that the source has multiple voices to label.
  collaborationMode: boolean;
  // Expected speaker count for diarization hint.
  //   `null`           → auto-detect (no `diarization_config` sent)
  //   2 / 3 / 4 / 5    → sent as `diarization_config.number_of_speakers`
  //   6                → sent as `diarization_config.min_speakers: 6`
  //                       (treated as the "6+" bucket — no upper bound)
  // Only consulted when `collaborationMode` is true.
  expectedSpeakerCount: number | null;
  // URL Download feature (yt-dlp)
  urlDownloadAccepted: boolean;
  defaultDownloadDir: string | null;
  defaultDownloadQuality: string;
  // Last URL the user submitted to DropZone, used to prefill the input on
  // next launch. Prototype-stage convenience — the user said they got tired
  // of pasting the same link repeatedly while testing.
  lastDownloadUrl: string | null;
  // Background data-collection master switch. Persisted across restarts.
  // Default `false` so installing the app does NOT start consuming
  // YouTube quota until the user explicitly opts in via the Settings
  // toggle — search-query strategy is still being decided when this
  // flag was added.
  dataCollectionEnabled: boolean;
  // yt-dlp --cookies-from-browser source. 'none' = anonymous (default).
  // YouTube's anti-bot heuristics increasingly reject anonymous yt-dlp
  // traffic with "Sign in to confirm you're not a bot", so the user
  // can pick a logged-in browser to forward cookies from.
  // Edge / Chrome are recommended on Windows because they're usually
  // preinstalled and yt-dlp's extractors are stable for them; Firefox
  // and Brave are supported for users on those.
  ytdlpCookiesBrowser: YtdlpCookiesBrowser;
  // Absolute path to a Netscape-format cookies.txt file. Takes
  // precedence over ytdlpCookiesBrowser when set — see getCookiesArgs.
  // Necessary because Windows 11's DPAPI changes + Chrome's process-
  // exclusive cookie DB lock made `--cookies-from-browser` unreliable
  // in practice; manually exporting via "Get cookies.txt LOCALLY" is
  // the only path that works in some user environments.
  // Security: file content holds session credentials. Never log the
  // content; the path itself is fine to log for debugging.
  ytdlpCookiesFile: string | null;
  // Platform-specific cookies.txt overrides. When set, the platform
  // (derived from the URL) takes its dedicated file in preference to
  // the generic ytdlpCookiesFile. The reason for splitting these out
  // is that 段階 6c-era users were ending up with one platform's
  // cookie file getting forwarded to the other platform's requests
  // (harmless, but messy in logs). This also lets a future "use
  // separate accounts per platform" workflow work without manual
  // toggling.
  ytdlpCookiesFileYoutube: string | null;
  ytdlpCookiesFileTwitch: string | null;
  // 段階 X1 — Twitch Helix API credentials. `twitchClientId` is public
  // information (visible in the Twitch developer console); the secret
  // never lives on disk in plaintext — see secureStorage.saveTwitchSecret.
  // We expose `twitchClientId` here for round-trip via settings:get/save
  // because the renderer needs to display the current value in the
  // CreatorManagementTab. The secret stays main-side only.
  twitchClientId: string | null;
  // 段階 X1 — registry of streamers to monitor for auto-recording.
  // The full list is shipped on every settings:get call; the renderer
  // doesn't bother with a separate listMonitoredCreators IPC because
  // the array stays small (realistic ceiling: 50 entries).
  monitoredCreators: MonitoredCreator[];
  // 段階 X2 — master switch for the live-stream polling loop. Defaults
  // false so a fresh install does NOT consume Twitch / YouTube quota
  // until the user explicitly enables it from the registered-channels
  // page. The polling worker reads this on startup and on each
  // settings:save round-trip.
  streamMonitorEnabled: boolean;
  // 段階 X3.5 — task-tray + auto-launch settings.
  //   `closeToTray`: when true, hitting the window's X button hides
  //     the window into the tray instead of quitting the app. Default
  //     true — the app exists primarily to monitor + record streams,
  //     and quitting on a stray X click would silently halt that.
  //   `startOnBoot`: registers jikkyou-cut as a Windows login item.
  //   `startMinimized`: when true (and the app is launched with the
  //     `--minimized` arg from the autorun entry), the main window
  //     stays hidden on boot.
  // Windows-only (process.platform === 'win32'); the macOS / Linux
  // branches are no-ops and the settings UI hides those rows.
  closeToTray: boolean;
  startOnBoot: boolean;
  startMinimized: boolean;
  // 段階 X3 — auto-record settings.
  // `recordingEnabled`: master switch. Off by default — recording
  //   without consent is a regulatory + ethics minefield, and we want
  //   the user to actively opt in via the Settings UI's disclaimer.
  // `recordingDir`: where finished recordings + metadata land. null
  //   means "use the default `<userData>/recordings`"; the user can
  //   override to e.g. a separate drive with more space.
  // `recordingQuality`: passed into yt-dlp / streamlink format selectors.
  //   'best' lets yt-dlp pick the highest available stream.
  // `recordingVodFallback`: if true, after the live stream ends we
  //   poll the platform for the post-stream archive URL and re-download
  //   that as the canonical higher-quality version. The live capture
  //   stays as a backup.
  // `recordingDisclaimerAccepted`: 1-time acknowledgement of the
  //   "use only with permission" warning. The disclaimer dialog shows
  //   once and never again after the user clicks acknowledge.
  recordingEnabled: boolean;
  recordingDir: string | null;
  recordingQuality: 'best' | '1080p' | '720p';
  recordingVodFallback: boolean;
  recordingDisclaimerAccepted: boolean;
  // 段階 X4 fix — when true, the OS power-save blocker is engaged
  // for the lifetime of any active recording. Without this Windows
  // can sleep mid-recording (default power plan: 30 min idle), which
  // silently kills the in-progress yt-dlp / streamlink subprocess +
  // wastes hours of capture. Defaults true because the entire
  // recording feature is built around overnight unattended use.
  preventSleepDuringRecording: boolean;
  // 2026-05-04 — Minimum follower / subscriber count for API-fallback
  // search results. Gemini-derived candidates and manual-input results
  // are NOT filtered by this — only the catch-all API search hits
  // (Twitch /helix/search/channels, YouTube search.list) get gated.
  // Default 200,000 because the user's registration target is almost
  // entirely 大手 / 事務所所属 (にじさんじ, ホロライブ, ぶいすぽ等)
  // — every one of which clears 200K. Drop the threshold (or use the
  // manual-input fallback) for individual streamers.
  searchMinFollowers: number;
};

export type YtdlpCookiesBrowser = 'none' | 'chrome' | 'edge' | 'firefox' | 'brave';

export const YTDLP_COOKIES_BROWSER_VALUES: YtdlpCookiesBrowser[] = [
  'none',
  'chrome',
  'edge',
  'firefox',
  'brave',
];

// Auto-record monitoring entry. Both Twitch and YouTube are first-class
// since 段階 X1 (revised) — the platform discriminator decides which
// optional fields are populated. The same person on YouTube and Twitch
// becomes TWO entries: one per platform, each independently
// addable/removable/toggleable. We don't try to unify them into one
// "person" because the platform IDs are unrelated and stage X3's
// recording will key off platform-specific URLs.
//
// `key()` (helper below) derives a stable platform-specific identifier
// for IPC remove/setEnabled — `twitchUserId` for Twitch entries,
// `youtubeChannelId` for YouTube entries. Both ID kinds are
// platform-stable (logins/handles can be renamed; user/channel IDs
// cannot).
export type MonitoredCreator =
  | {
      platform: 'twitch';
      twitchUserId: string;
      twitchLogin: string;
      displayName: string;
      profileImageUrl: string | null;
      addedAt: number;
      enabled: boolean;
      // Optional impostor-detection metadata captured at register
      // time. Not populated for entries from before 2026-05-04;
      // refresh via the "↻ 再取得" button. We do NOT auto-refresh
      // these on every poll (per spec — register-time snapshot).
      followerCount?: number | null;
      accountCreatedAt?: string;
    }
  | {
      platform: 'youtube';
      youtubeChannelId: string;     // UCxxx... — stable across renames
      youtubeHandle: string | null; // @xxx — may be missing for legacy channels
      displayName: string;
      profileImageUrl: string | null;
      addedAt: number;
      enabled: boolean;
      subscriberCount?: number | null;
      accountCreatedAt?: string;
    };

// Stable per-entry identifier. Both platforms use a guaranteed-unique
// platform-stable ID, but the field name differs — this helper keeps
// IPC + UI code from juggling discriminated property access.
export function monitoredCreatorKey(c: MonitoredCreator): string {
  return c.platform === 'twitch' ? c.twitchUserId : c.youtubeChannelId;
}

export const DEFAULT_CONFIG: AppConfig = {
  transcriptionContext: DEFAULT_CONTEXT,
  collaborationMode: false,
  expectedSpeakerCount: null,
  urlDownloadAccepted: false,
  defaultDownloadDir: null,
  defaultDownloadQuality: 'best',
  lastDownloadUrl: null,
  dataCollectionEnabled: false,
  ytdlpCookiesBrowser: 'none',
  ytdlpCookiesFile: null,
  ytdlpCookiesFileYoutube: null,
  ytdlpCookiesFileTwitch: null,
  twitchClientId: null,
  monitoredCreators: [],
  streamMonitorEnabled: false,
  closeToTray: true,
  startOnBoot: false,
  startMinimized: false,
  recordingEnabled: false,
  recordingDir: null,
  recordingQuality: 'best',
  recordingVodFallback: true,
  recordingDisclaimerAccepted: false,
  preventSleepDuringRecording: true,
  searchMinFollowers: 200_000,
};

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT,
  YTDLP_COOKIES_BROWSER_VALUES,
  type AppConfig,
  type MonitoredCreator,
  type TranscriptionContext,
  type YtdlpCookiesBrowser,
} from '../common/config';

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');

const stringField = (raw: unknown): string =>
  typeof raw === 'string' ? raw : '';

function normaliseContext(raw: unknown): TranscriptionContext {
  if (raw == null || typeof raw !== 'object') return DEFAULT_CONTEXT;
  const o = raw as Record<string, unknown>;
  return {
    gameTitle: stringField(o['gameTitle']),
    characters: stringField(o['characters']),
    catchphrases: stringField(o['catchphrases']),
    notes: stringField(o['notes']),
  };
}

// Coerce on-disk speaker count into the documented domain. Valid values are
// `null` (auto), `2` / `3` / `4` / `5`, or `6` (the "6+" sentinel). Anything
// else — negative, zero, fractional, > 6 — collapses to null so we never
// send a malformed `diarization_config` to Gladia.
function normaliseSpeakerCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  if (n >= 2 && n <= 6) return n;
  return null;
}

// Coerce on-disk cookie-browser value into the documented domain.
// Anything else — typo, removed-in-future-version sentinel, etc. —
// collapses to 'none' so a corrupted config can't poison every yt-dlp
// run.
function normaliseCookiesBrowser(raw: unknown): YtdlpCookiesBrowser {
  if (typeof raw !== 'string') return 'none';
  return (YTDLP_COOKIES_BROWSER_VALUES as string[]).includes(raw)
    ? (raw as YtdlpCookiesBrowser)
    : 'none';
}

// Trim + non-empty + string check for a cookies.txt path stored on
// disk. Empty string from prior buggy save? null. Whitespace-only? null.
// Anything else passes through to be validated at use time.
function normaliseCookiesPath(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

// Coerce on-disk monitoredCreators into the typed shape. Drops
// malformed entries (missing platform / id) rather than failing the
// whole load — we'd rather lose a corrupted entry than block startup.
//
// Migrations:
//   - X1 (Twitch-only) shape: `{ platform: 'twitch', userId, login, ... }`
//     → translated to `{ platform: 'twitch', twitchUserId, twitchLogin, ... }`
//     The old fields are still recognised so existing user data
//     survives the upgrade. Once load + save round-trips, the file is
//     re-written in the new shape and the legacy fields disappear on
//     next load.
//   - YouTube entries: new shape, no migration needed.
//
// Dedup is per (platform, key) pair — same person on both platforms
// is allowed (and intentional, see MonitoredCreator's docstring).
function normaliseMonitoredCreators(raw: unknown): MonitoredCreator[] {
  if (!Array.isArray(raw)) return [];
  const out: MonitoredCreator[] = [];
  const seen = new Set<string>(); // `${platform}:${id}`

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const platform = o['platform'];
    const displayName = typeof o['displayName'] === 'string' ? o['displayName'] : null;
    if (!displayName) continue;
    const profileImageUrl = typeof o['profileImageUrl'] === 'string' ? o['profileImageUrl'] : null;
    const addedAt =
      typeof o['addedAt'] === 'number' && Number.isFinite(o['addedAt'])
        ? (o['addedAt'] as number)
        : Date.now();
    const enabled = typeof o['enabled'] === 'boolean' ? (o['enabled'] as boolean) : true;

    if (platform === 'twitch') {
      // Accept both the new (`twitchUserId`/`twitchLogin`) and the X1
      // legacy (`userId`/`login`) field names.
      const twitchUserId =
        typeof o['twitchUserId'] === 'string' ? (o['twitchUserId'] as string)
          : typeof o['userId'] === 'string' ? (o['userId'] as string)
            : null;
      const twitchLogin =
        typeof o['twitchLogin'] === 'string' ? (o['twitchLogin'] as string)
          : typeof o['login'] === 'string' ? (o['login'] as string)
            : null;
      if (!twitchUserId || !twitchLogin) continue;
      const key = `twitch:${twitchUserId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const followerCount =
        typeof o['followerCount'] === 'number' ? (o['followerCount'] as number) : null;
      const accountCreatedAt =
        typeof o['accountCreatedAt'] === 'string' ? (o['accountCreatedAt'] as string) : '';
      out.push({
        platform: 'twitch',
        twitchUserId,
        twitchLogin,
        displayName,
        profileImageUrl,
        addedAt,
        enabled,
        followerCount,
        accountCreatedAt,
      });
      continue;
    }

    if (platform === 'youtube') {
      const youtubeChannelId = typeof o['youtubeChannelId'] === 'string' ? (o['youtubeChannelId'] as string) : null;
      const youtubeHandle = typeof o['youtubeHandle'] === 'string' ? (o['youtubeHandle'] as string) : null;
      if (!youtubeChannelId) continue;
      const key = `youtube:${youtubeChannelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const subscriberCount =
        typeof o['subscriberCount'] === 'number' ? (o['subscriberCount'] as number) : null;
      const accountCreatedAt =
        typeof o['accountCreatedAt'] === 'string' ? (o['accountCreatedAt'] as string) : '';
      out.push({
        platform: 'youtube',
        youtubeChannelId,
        youtubeHandle,
        displayName,
        profileImageUrl,
        addedAt,
        enabled,
        subscriberCount,
        accountCreatedAt,
      });
      continue;
    }
    // Unknown platform → drop silently.
  }
  return out;
}

// Migration note: a legacy `whisperModelPath` field may exist on disk from
// the pre-Gemini build. We silently drop it.
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      transcriptionContext: normaliseContext(parsed['transcriptionContext']),
      // Pre-collaboration-toggle configs lack the field — fall back to the
      // safer `false` (solo) so existing installs default to the cheaper
      // request shape rather than silently flipping their behaviour.
      collaborationMode: typeof parsed['collaborationMode'] === 'boolean'
        ? (parsed['collaborationMode'] as boolean)
        : DEFAULT_CONFIG.collaborationMode,
      expectedSpeakerCount: normaliseSpeakerCount(parsed['expectedSpeakerCount']),
      urlDownloadAccepted: !!parsed['urlDownloadAccepted'],
      defaultDownloadDir: typeof parsed['defaultDownloadDir'] === 'string'
        ? (parsed['defaultDownloadDir'] as string)
        : path.join(app.getPath('userData'), 'Downloads', 'jikkyou-cut'),
      defaultDownloadQuality: typeof parsed['defaultDownloadQuality'] === 'string'
        ? (parsed['defaultDownloadQuality'] as string)
        : 'best',
      lastDownloadUrl: typeof parsed['lastDownloadUrl'] === 'string'
        ? (parsed['lastDownloadUrl'] as string)
        : null,
      // Pre-flag configs lack the field — fall back to false so existing
      // installs do not silently begin consuming YouTube quota.
      dataCollectionEnabled: typeof parsed['dataCollectionEnabled'] === 'boolean'
        ? (parsed['dataCollectionEnabled'] as boolean)
        : DEFAULT_CONFIG.dataCollectionEnabled,
      ytdlpCookiesBrowser: normaliseCookiesBrowser(parsed['ytdlpCookiesBrowser']),
      ytdlpCookiesFile: normaliseCookiesPath(parsed['ytdlpCookiesFile']),
      ytdlpCookiesFileYoutube: normaliseCookiesPath(parsed['ytdlpCookiesFileYoutube']),
      ytdlpCookiesFileTwitch: normaliseCookiesPath(parsed['ytdlpCookiesFileTwitch']),
      twitchClientId:
        typeof parsed['twitchClientId'] === 'string' && parsed['twitchClientId'].trim() !== ''
          ? (parsed['twitchClientId'] as string).trim()
          : null,
      monitoredCreators: normaliseMonitoredCreators(parsed['monitoredCreators']),
      streamMonitorEnabled:
        typeof parsed['streamMonitorEnabled'] === 'boolean'
          ? (parsed['streamMonitorEnabled'] as boolean)
          : DEFAULT_CONFIG.streamMonitorEnabled,
      closeToTray:
        typeof parsed['closeToTray'] === 'boolean'
          ? (parsed['closeToTray'] as boolean)
          : DEFAULT_CONFIG.closeToTray,
      startOnBoot:
        typeof parsed['startOnBoot'] === 'boolean'
          ? (parsed['startOnBoot'] as boolean)
          : DEFAULT_CONFIG.startOnBoot,
      startMinimized:
        typeof parsed['startMinimized'] === 'boolean'
          ? (parsed['startMinimized'] as boolean)
          : DEFAULT_CONFIG.startMinimized,
      recordingEnabled:
        typeof parsed['recordingEnabled'] === 'boolean'
          ? (parsed['recordingEnabled'] as boolean)
          : DEFAULT_CONFIG.recordingEnabled,
      recordingDir:
        typeof parsed['recordingDir'] === 'string' && parsed['recordingDir'].trim() !== ''
          ? (parsed['recordingDir'] as string)
          : null,
      recordingQuality:
        parsed['recordingQuality'] === '1080p' || parsed['recordingQuality'] === '720p' || parsed['recordingQuality'] === 'best'
          ? parsed['recordingQuality']
          : DEFAULT_CONFIG.recordingQuality,
      recordingVodFallback:
        typeof parsed['recordingVodFallback'] === 'boolean'
          ? (parsed['recordingVodFallback'] as boolean)
          : DEFAULT_CONFIG.recordingVodFallback,
      recordingDisclaimerAccepted:
        typeof parsed['recordingDisclaimerAccepted'] === 'boolean'
          ? (parsed['recordingDisclaimerAccepted'] as boolean)
          : DEFAULT_CONFIG.recordingDisclaimerAccepted,
      preventSleepDuringRecording:
        typeof parsed['preventSleepDuringRecording'] === 'boolean'
          ? (parsed['preventSleepDuringRecording'] as boolean)
          : DEFAULT_CONFIG.preventSleepDuringRecording,
      searchMinFollowers:
        typeof parsed['searchMinFollowers'] === 'number' && parsed['searchMinFollowers'] >= 0
          ? (parsed['searchMinFollowers'] as number)
          : DEFAULT_CONFIG.searchMinFollowers,
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      defaultDownloadDir: path.join(app.getPath('userData'), 'Downloads', 'jikkyou-cut'),
    };
  }
}

export async function saveConfig(
  partial: Partial<AppConfig>,
): Promise<AppConfig> {
  const current = await loadConfig();
  const next: AppConfig = {
    transcriptionContext: {
      ...current.transcriptionContext,
      ...(partial.transcriptionContext ?? {}),
    },
    collaborationMode:
      partial.collaborationMode != null
        ? partial.collaborationMode
        : current.collaborationMode,
    // Note `=== undefined` rather than `!= null`: callers should be able to
    // explicitly pass `null` to switch back to auto-detect, which would
    // otherwise be swallowed by a `!= null` check.
    expectedSpeakerCount:
      partial.expectedSpeakerCount !== undefined
        ? normaliseSpeakerCount(partial.expectedSpeakerCount)
        : current.expectedSpeakerCount,
    urlDownloadAccepted:
      partial.urlDownloadAccepted !== undefined
        ? partial.urlDownloadAccepted
        : current.urlDownloadAccepted,
    defaultDownloadDir:
      partial.defaultDownloadDir !== undefined
        ? partial.defaultDownloadDir
        : current.defaultDownloadDir,
    defaultDownloadQuality:
      partial.defaultDownloadQuality !== undefined
        ? partial.defaultDownloadQuality
        : current.defaultDownloadQuality,
    lastDownloadUrl:
      partial.lastDownloadUrl !== undefined
        ? partial.lastDownloadUrl
        : current.lastDownloadUrl,
    dataCollectionEnabled:
      partial.dataCollectionEnabled !== undefined
        ? partial.dataCollectionEnabled
        : current.dataCollectionEnabled,
    ytdlpCookiesBrowser:
      partial.ytdlpCookiesBrowser !== undefined
        ? normaliseCookiesBrowser(partial.ytdlpCookiesBrowser)
        : current.ytdlpCookiesBrowser,
    // `=== undefined` so the caller can explicitly clear the path by
    // passing `null` (returns the field to the no-cookies-file state).
    // Empty string is normalised to null too so a stray onChange on an
    // empty input doesn't leak through.
    ytdlpCookiesFile:
      partial.ytdlpCookiesFile !== undefined
        ? normaliseCookiesPath(partial.ytdlpCookiesFile)
        : current.ytdlpCookiesFile,
    ytdlpCookiesFileYoutube:
      partial.ytdlpCookiesFileYoutube !== undefined
        ? normaliseCookiesPath(partial.ytdlpCookiesFileYoutube)
        : current.ytdlpCookiesFileYoutube,
    ytdlpCookiesFileTwitch:
      partial.ytdlpCookiesFileTwitch !== undefined
        ? normaliseCookiesPath(partial.ytdlpCookiesFileTwitch)
        : current.ytdlpCookiesFileTwitch,
    twitchClientId:
      partial.twitchClientId !== undefined
        ? (typeof partial.twitchClientId === 'string' && partial.twitchClientId.trim() !== ''
            ? partial.twitchClientId.trim()
            : null)
        : current.twitchClientId,
    // monitoredCreators is mutated through dedicated IPC handlers
    // (addMonitoredCreator / removeMonitoredCreator / setCreatorEnabled)
    // not bulk save, but we still honour the field if a partial save
    // happens to include it — useful for tests + import/export workflows.
    monitoredCreators:
      partial.monitoredCreators !== undefined
        ? normaliseMonitoredCreators(partial.monitoredCreators)
        : current.monitoredCreators,
    streamMonitorEnabled:
      partial.streamMonitorEnabled !== undefined
        ? !!partial.streamMonitorEnabled
        : current.streamMonitorEnabled,
    closeToTray:
      partial.closeToTray !== undefined
        ? !!partial.closeToTray
        : current.closeToTray,
    startOnBoot:
      partial.startOnBoot !== undefined
        ? !!partial.startOnBoot
        : current.startOnBoot,
    startMinimized:
      partial.startMinimized !== undefined
        ? !!partial.startMinimized
        : current.startMinimized,
    recordingEnabled:
      partial.recordingEnabled !== undefined
        ? !!partial.recordingEnabled
        : current.recordingEnabled,
    recordingDir:
      partial.recordingDir !== undefined
        ? (typeof partial.recordingDir === 'string' && partial.recordingDir.trim() !== ''
            ? partial.recordingDir
            : null)
        : current.recordingDir,
    recordingQuality:
      partial.recordingQuality === '1080p' || partial.recordingQuality === '720p' || partial.recordingQuality === 'best'
        ? partial.recordingQuality
        : current.recordingQuality,
    recordingVodFallback:
      partial.recordingVodFallback !== undefined
        ? !!partial.recordingVodFallback
        : current.recordingVodFallback,
    recordingDisclaimerAccepted:
      partial.recordingDisclaimerAccepted !== undefined
        ? !!partial.recordingDisclaimerAccepted
        : current.recordingDisclaimerAccepted,
    preventSleepDuringRecording:
      partial.preventSleepDuringRecording !== undefined
        ? !!partial.preventSleepDuringRecording
        : current.preventSleepDuringRecording,
    searchMinFollowers:
      typeof partial.searchMinFollowers === 'number' && partial.searchMinFollowers >= 0
        ? partial.searchMinFollowers
        : current.searchMinFollowers,
  };
  const p = getConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

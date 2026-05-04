import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { readCollectionLog } from './dataCollection/logReader';
import { collectionLogPath } from './dataCollection/logger';
import { getGeminiKeyUsage, getQuotaPerKeyToday, openDb } from './dataCollection/database';
import { hashApiKey } from './utils';
import { estimateCreator, listSeedCreatorsForPicker } from './dataCollection/estimateCreator';
import { runPatternAnalysis } from './dataCollection/analyzer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registerMediaScheme, handleMediaProtocol } from './mediaProtocol';
import { openVideoFileDialog, openDirectoryDialog, openCookiesFileDialog, validateCookiesFile } from './fileDialog';
import { buildMenu } from './menu';
import { loadConfig, saveConfig } from './config';
import * as secureStorage from './secureStorage';
import * as gladia from './gladia';
import * as project from './project';
import * as exportModule from './export';
import * as fonts from './fonts';
import * as subtitleSettings from './subtitleSettings';
import * as urlDownload from './urlDownload';
import * as commentAnalysis from './commentAnalysis';
import * as aiSummary from './aiSummary';
import * as gemini from './gemini';
import * as twitchHelix from './twitchHelix';
import * as creatorSearch from './creatorSearch';
import * as recentVideos from './recentVideos';
import { streamMonitor } from './streamMonitor';
import { streamRecorder } from './streamRecorder';
import * as powerSave from './powerSave';
import {
  createTray,
  destroyTray,
  showFirstHideBalloon,
  updateTrayLiveCount,
} from './tray';
import { monitoredCreatorKey } from '../common/config';
import { extractAudioToTemp } from './audioExtraction';
import { promises as fsPromises } from 'node:fs';
import { dataCollectionManager } from './dataCollection';
import { seedOrUpdateCreators } from './dataCollection/seedCreators';
import { runMigrations } from './dataCollection/migrations';
import * as creatorList from './dataCollection/creatorList';
import type { AppConfig } from '../common/config';
import type {
  CommentAnalysisStartArgs,
  ExportStartArgs,
  GeminiAnalysisPhase,
  GeminiAnalysisStartArgs,
  SubtitleSettings,
  TranscriptCue,
  TranscriptionStartArgs,
} from '../common/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

// 段階 X3.5 — `close` event hooks intercept the X-button to hide into
// the tray. The actual quit path runs through `actuallyQuit()` which
// flips this flag so the next close event passes through.
let isQuitting = false;

// CLI flag passed by the auto-launch login item. When true, the
// initial window is created hidden — only the tray icon is visible
// until the user clicks it.
const launchedMinimized = process.argv.includes('--minimized');

// Synchronous mirror of `AppConfig.closeToTray`. The window's close
// handler runs synchronously and can't await loadConfig(), so we
// snapshot the value at boot + on every settings:save IPC.
let cachedCloseToTray = true;

// Apply or revert Windows' login-item registration. Idempotent:
// Electron's setLoginItemSettings overwrites whatever was registered
// for this exe, so calling it on boot is safe even when nothing
// changed. macOS + Linux ignore (Electron's API works on macOS too,
// but spec scopes this feature Windows-only).
function applyLoginItemSettings(opts: { startOnBoot: boolean; startMinimized: boolean }): void {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: opts.startOnBoot,
    args: opts.startMinimized ? ['--minimized'] : [],
  });
}

// 段階 X3.5 — single-instance lock. requesting must happen BEFORE
// app.whenReady() races other code; we put it at module top-level so
// a second instance bails the earliest possible time.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  // Another jikkyou-cut is already running. Quit ourselves so the
  // existing instance wins; the `second-instance` handler over there
  // surfaces the existing window.
  app.quit();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function actuallyQuit(): void {
  isQuitting = true;
  app.quit();
}

registerMediaScheme();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'jikkyou-cut',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 段階 X2 — give the stream-monitor a handle to push events.
  // Updated again on every window recreate (e.g. macOS reopen).
  streamMonitor.attachWindow(mainWindow);
  streamRecorder.attachWindow(mainWindow);

  // 段階 X3.5 — intercept the X button on Windows when closeToTray is
  // enabled. The decision must be synchronous because Electron's
  // `close` event needs `preventDefault()` called before the handler
  // returns; we read from `cachedCloseToTray` instead of awaiting the
  // config file. The cache is refreshed on every settings:save and
  // at app boot.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (process.platform !== 'win32') return;
    if (!cachedCloseToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    showFirstHideBalloon();
  });
  mainWindow.on('closed', () => {
    streamMonitor.attachWindow(null);
    mainWindow = null;
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// Short-lived parsed import payload, keyed by absolute path of the
// JSON the user selected. Held in main-side state so the renderer
// doesn't have to round-trip plaintext keys through the import flow.
const pendingImports = new Map<string, secureStorage.ApiKeyBackup>();

function registerIpcHandlers() {
  ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow) return null;
    return openVideoFileDialog(mainWindow);
  });
  ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null;
    return openDirectoryDialog(mainWindow);
  });
  ipcMain.handle('dialog:openCookiesFile', async () => {
    if (!mainWindow) return null;
    return openCookiesFileDialog(mainWindow);
  });
  ipcMain.handle('cookiesFile:validate', async (_e, absPath: string) => {
    if (typeof absPath !== 'string' || absPath.trim() === '') {
      return { exists: false, sizeBytes: 0, extension: '' };
    }
    return validateCookiesFile(absPath);
  });

  // settings (non-secret)
  ipcMain.handle('settings:get', () => loadConfig());
  ipcMain.handle('settings:save', async (_e, partial: Partial<AppConfig>) => {
    const next = await saveConfig(partial);
    // 段階 X3.5 — refresh tray-related caches whenever any settings
    // round-trip happens. Cheaper than wiring per-field side-effects;
    // the saves themselves are infrequent (user-initiated checkboxes).
    cachedCloseToTray = next.closeToTray;
    applyLoginItemSettings({
      startOnBoot: next.startOnBoot,
      startMinimized: next.startMinimized,
    });
    return next;
  });

  // API key — raw key only crosses the boundary inbound.
  ipcMain.handle('apiKey:has', () => secureStorage.hasSecret());
  ipcMain.handle('apiKey:set', async (_e, key: string) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('APIキーが空です');
    }
    await secureStorage.saveSecret(key);
  });
  ipcMain.handle('apiKey:clear', () => secureStorage.deleteSecret());
  ipcMain.handle('apiKey:validate', (_e, key: string) =>
    gladia.validateApiKey(key),
  );

  // Anthropic API key (AI title summarisation, BYOK)
  ipcMain.handle('anthropicApiKey:has', () => secureStorage.hasAnthropicSecret());
  ipcMain.handle('anthropicApiKey:set', async (_e, key: string) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('APIキーが空です');
    }
    await secureStorage.saveAnthropicSecret(key);
  });
  ipcMain.handle('anthropicApiKey:clear', () => secureStorage.deleteAnthropicSecret());
  ipcMain.handle('anthropicApiKey:validate', (_e, key: string) =>
    aiSummary.validateAnthropicKey(key),
  );

  // transcription
  ipcMain.handle('transcription:start', async (_e, args: TranscriptionStartArgs) => {
    const apiKey = await secureStorage.loadSecret();
    if (!apiKey) throw new Error('APIキーが設定されていません');
    const config = await loadConfig();
    return gladia.transcribe({
      videoFilePath: args.videoFilePath,
      durationSec: args.durationSec,
      apiKey,
      context: config.transcriptionContext,
      // The renderer is the source of truth for the toggle, but we accept
      // legacy callers too — fall back to the persisted config so an old
      // renderer build (without the field) still gets the user's saved
      // preference instead of an unintended `false`.
      collaborationMode:
        typeof args.collaborationMode === 'boolean'
          ? args.collaborationMode
          : config.collaborationMode,
      // Same legacy-fallback story as collaborationMode. `null` is a valid
      // value (auto-detect), so we discriminate on `=== undefined`.
      expectedSpeakerCount:
        args.expectedSpeakerCount !== undefined
          ? args.expectedSpeakerCount
          : config.expectedSpeakerCount,
      onProgress: (p) => {
        mainWindow?.webContents.send('transcription:progress', p);
      },
    });
  });
  ipcMain.handle('transcription:cancel', () => gladia.cancelTranscription());

  // project file
  ipcMain.handle('project:load', (_e, videoFilePath: string) =>
    project.loadProject(videoFilePath),
  );
  ipcMain.handle(
    'project:save',
    (_e, videoFilePath: string, cues: TranscriptCue[], activePresetId?: string) =>
      project.saveProject(videoFilePath, cues, activePresetId),
  );
  ipcMain.handle('project:clear', (_e, videoFilePath: string) =>
    project.clearProject(videoFilePath),
  );

  // export
  ipcMain.handle('export:start', async (_e, args: ExportStartArgs) =>
    exportModule.startExport({
      videoFilePath: args.videoFilePath,
      regions: args.regions,
      cues: args.cues,
      videoWidth: args.videoWidth,
      videoHeight: args.videoHeight,
      onProgress: (p) => {
        mainWindow?.webContents.send('export:progress', p);
      },
    }),
  );
  ipcMain.handle('export:cancel', () => exportModule.cancelExport());
  ipcMain.handle('shell:revealInFolder', (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  // fonts (subtitle font management — Phase A)
  ipcMain.handle('fonts:listAvailable', () => fonts.listAvailableFonts());
  ipcMain.handle('fonts:listInstalled', () => fonts.listInstalledFonts());
  ipcMain.handle('fonts:download', (_e, families: string[]) =>
    fonts.downloadFonts(families, (family, status, error) => {
      mainWindow?.webContents.send('fonts:downloadProgress', {
        family,
        status,
        ...(error != null && { error }),
      });
    }),
  );
  ipcMain.handle('fonts:remove', (_e, family: string) =>
    fonts.removeFont(family),
  );

  // subtitle settings
  ipcMain.handle('subtitleSettings:load', () =>
    subtitleSettings.loadSubtitleSettings(),
  );
  ipcMain.handle(
    'subtitleSettings:save',
    (_e, settings: SubtitleSettings) =>
      subtitleSettings.saveSubtitleSettings(settings),
  );
  ipcMain.on('window:setTitle', (_e, title: string) => {
    if (mainWindow) {
      mainWindow.setTitle(title ? `jikkyou-cut - ${title}` : 'jikkyou-cut');
    }
  });

  // URL download. The cookiesBrowser setting is read from on-disk
  // config at the start of every DL — no caching — so the user's
  // SettingsDialog choice takes effect immediately on the next URL
  // submission without an app restart.
  ipcMain.handle('urlDownload:start', async (_e, args) => {
    const cfg = await loadConfig();
    return urlDownload.downloadVideo({
      ...args,
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
      onProgress: (p) => {
        mainWindow?.webContents.send('urlDownload:progress', p);
      },
    });
  });
  ipcMain.handle('urlDownload:cancel', () => urlDownload.cancelDownload());

  // Stage 2 — audio-first / video-background split. Each runs in its
  // own yt-dlp subprocess with its own progress channel. The renderer
  // typically calls them sequentially (await audio → fire-and-forget
  // video) so AI-extract gates only on the fast audio path.
  ipcMain.handle('urlDownload:startAudioOnly', async (_e, args) => {
    const cfg = await loadConfig();
    return urlDownload.downloadAudioOnly({
      ...args,
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
      onProgress: (p) => {
        mainWindow?.webContents.send('urlDownload:audioProgress', p);
      },
    });
  });
  ipcMain.handle('urlDownload:cancelAudio', () => urlDownload.cancelAudioDownload());
  ipcMain.handle('urlDownload:startVideoOnly', async (_e, args) => {
    const cfg = await loadConfig();
    return urlDownload.downloadVideoOnly({
      ...args,
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
      onProgress: (p) => {
        mainWindow?.webContents.send('urlDownload:videoProgress', p);
      },
    });
  });
  ipcMain.handle('urlDownload:cancelVideo', () => urlDownload.cancelVideoDownload());

  // 2026-05-04 — Lightweight metadata pre-fetch. Returns
  // { durationSec, title } from yt-dlp --skip-download. Renderer fires
  // this in parallel with audio/video DLs so comment analysis can kick
  // off as soon as duration is known (instead of waiting for audio to
  // resolve, which on Twitch VOD is the full HLS stream length).
  ipcMain.handle('urlDownload:fetchMetadata', async (_e, args: { url: string }) => {
    const cfg = await loadConfig();
    return urlDownload.fetchUrlMetadata({
      url: args.url,
      cookiesBrowser: cfg.ytdlpCookiesBrowser,
      cookiesFile: cfg.ytdlpCookiesFile,
      cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
      cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
    });
  });

  // Comment analysis(yt-dlp チャットリプレイ + playboard 視聴者数 + スコア)
  ipcMain.handle(
    'commentAnalysis:start',
    async (_e, args: CommentAnalysisStartArgs) => {
      console.log('[comment-debug] IPC entry:', JSON.stringify(args));
      const cfg = await loadConfig();
      try {
        const result = await commentAnalysis.analyzeComments(
          args,
          (p) => {
            console.log('[comment-debug] progress:', p.phase, p.percent);
            mainWindow?.webContents.send('commentAnalysis:progress', p);
          },
          {
            cookiesBrowser: cfg.ytdlpCookiesBrowser,
            cookiesFile: cfg.ytdlpCookiesFile,
            cookiesFileYoutube: cfg.ytdlpCookiesFileYoutube,
            cookiesFileTwitch: cfg.ytdlpCookiesFileTwitch,
          },
        );
        console.log(
          '[comment-debug] returning to renderer:',
          `messages=${result.allMessages.length}, hasViewerStats=${result.hasViewerStats},`,
          `buckets=${result.buckets.length}, durationSec=${result.videoDurationSec}`,
        );
        return result;
      } catch (err) {
        console.error('[comment-debug] IPC threw:', err instanceof Error ? err.stack : err);
        throw err;
      }
    },
  );
  ipcMain.handle('commentAnalysis:cancel', () => {
    console.log('[comment-debug] cancel IPC called');
    return commentAnalysis.cancelAnalysis();
  });

  // AI segment-title summarisation (Anthropic Claude Haiku)
  ipcMain.handle(
    'aiSummary:generate',
    async (_e, args: { videoKey: string; segments: aiSummary.SummarySegment[] }) => {
      return aiSummary.generateSegmentTitles(args.videoKey, args.segments, (done, total) => {
        mainWindow?.webContents.send('aiSummary:progress', { done, total });
      });
    },
  );
  ipcMain.handle('aiSummary:cancel', () => aiSummary.cancelAll());

  // Stage 6a — preload entry point for the global pattern snapshot.
  // Called by the renderer at URL-input time so the file is already
  // hydrated when the user clicks "auto-extract". The autoExtract
  // orchestrator still loads internally for safety / local-drop
  // flows, so this endpoint is purely opportunistic.
  ipcMain.handle('aiSummary:loadGlobalPatterns', () => aiSummary.loadGlobalPatterns());

  // ---- API key hybrid backup + export/import (2026-05-04) ----------------
  // Defends against DPAPI master-key rotation losing every .bin at once
  // (we lost 50 Gemini keys to that in May 2026). The hybrid layer in
  // secureStorage already mirrors every save into a Documents-side
  // plaintext JSON; these handlers expose status + manual transfer.
  ipcMain.handle('apiKeysBackup:getStatus', () => secureStorage.getBackupStatus());
  ipcMain.handle('apiKeysBackup:openFolder', () => {
    void shell.openPath(secureStorage.backupFolderPath());
  });
  ipcMain.handle('apiKeysBackup:revealFile', async () => {
    const status = await secureStorage.getBackupStatus();
    if (status.exists) {
      shell.showItemInFolder(status.filePath);
    } else {
      void shell.openPath(secureStorage.backupFolderPath());
    }
  });
  ipcMain.handle('apiKeysBackup:export', async () => {
    const { dialog } = await import('electron');
    const cfg = await loadConfig();
    const today = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow ?? undefined as unknown as BrowserWindow, {
      title: 'API キーをエクスポート',
      defaultPath: `jikkyou-cut-api-keys-${today}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const data = await secureStorage.buildExport({
      twitchClientId: cfg.twitchClientId ?? null,
    });
    await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
    const counts = {
      gemini: data.keys.gemini?.length ?? 0,
      youtube: data.keys.youtube?.length ?? 0,
      gladia: !!data.keys.gladia,
      anthropic: !!data.keys.anthropic,
      twitchClientId: !!data.keys.twitchClientId,
      twitchClientSecret: !!data.keys.twitchClientSecret,
    };
    return { ok: true, filePath: result.filePath, counts };
  });
  ipcMain.handle('apiKeysBackup:importPreview', async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog(mainWindow ?? undefined as unknown as BrowserWindow, {
      title: 'API キーをインポート',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = result.filePaths[0]!;
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (err) {
      return { ok: false, error: 'ファイル読み込みに失敗しました: ' + (err instanceof Error ? err.message : String(err)) };
    }
    try {
      const cfg = await loadConfig();
      const parsed = await secureStorage.parseImport(raw, {
        twitchClientId: cfg.twitchClientId ?? null,
      });
      // Stash parsed payload keyed by file path so the apply step can
      // re-use it without round-tripping through the renderer (the
      // renderer never holds plaintext keys longer than necessary).
      pendingImports.set(filePath, parsed.data);
      return { ok: true, filePath, plan: parsed.plan };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(
    'apiKeysBackup:importApply',
    async (_e, args: { filePath: string; mode: 'merge' | 'replace' }) => {
      const data = pendingImports.get(args.filePath);
      if (!data) {
        return { ok: false, error: 'インポート対象が失効しました。再度プレビューしてください' };
      }
      try {
        const out = await secureStorage.applyImport(data, args.mode);
        if (out.twitchClientId !== 'unchanged') {
          await saveConfig({ twitchClientId: out.twitchClientId });
          twitchHelix.clearTokenCache();
        }
        pendingImports.delete(args.filePath);
        return { ok: true, applied: out.applied };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // YouTube Data API key BYOK (multi-slot for quota rotation).
  ipcMain.handle('youtubeApiKeys:hasKeys', () => secureStorage.hasYoutubeApiKeys());
  ipcMain.handle('youtubeApiKeys:getKeyCount', () => secureStorage.countYoutubeApiKeys());
  // getKeys returns plaintext keys to renderer — see comment in
  // common/types.ts for the rationale. Used by the multi-key editor
  // to render existing keys as removable chips.
  ipcMain.handle('youtubeApiKeys:getKeys', () => secureStorage.loadYoutubeApiKeys());
  ipcMain.handle('youtubeApiKeys:setKeys', async (_e, keys: string[]) => {
    if (!Array.isArray(keys)) throw new Error('keys must be string[]');
    await secureStorage.saveYoutubeApiKeys(keys);
  });
  ipcMain.handle('youtubeApiKeys:clear', () => secureStorage.clearYoutubeApiKeys());

  // Creator targeting list (per-user JSON, no encryption).
  ipcMain.handle('creators:list', () => creatorList.loadCreatorList());
  ipcMain.handle('creators:add', (_e, name: string, channelId: string | null) =>
    creatorList.addCreator(name, channelId),
  );
  ipcMain.handle('creators:remove', (_e, name: string) => creatorList.removeCreator(name));

  // Data-collection manager (background pipeline).
  ipcMain.handle('dataCollection:getStats', async () => {
    const snap = dataCollectionManager.getStatsSnapshot();
    const cfg = await loadConfig();
    return { ...snap, isEnabled: cfg.dataCollectionEnabled };
  });
  ipcMain.handle('dataCollection:triggerNow', () => dataCollectionManager.triggerNow());
  ipcMain.handle('dataCollection:pause', () => dataCollectionManager.pause());
  ipcMain.handle('dataCollection:resume', () => dataCollectionManager.resume());
  ipcMain.handle('dataCollection:cancelCurrent', () => dataCollectionManager.cancelCurrentBatch());
  ipcMain.handle('dataCollection:isEnabled', async () => {
    const cfg = await loadConfig();
    return cfg.dataCollectionEnabled;
  });
  ipcMain.handle('dataCollection:setEnabled', async (_e, enabled: boolean) => {
    await saveConfig({ dataCollectionEnabled: enabled });
    if (enabled) {
      // Best-effort start. start() is a no-op if no API keys exist,
      // so the toggle still works for users who haven't entered keys
      // yet — they'll just see "未起動" until they configure keys.
      await dataCollectionManager.start();
    } else {
      // Stop the in-flight cycle so the user's "off" intent takes
      // effect immediately instead of after the current batch.
      dataCollectionManager.pause();
    }
  });
  ipcMain.handle(
    'dataCollection:estimateCreator',
    (_e, args: { videoTitle: string; channelName?: string }) => {
      return estimateCreator(openDb(), args);
    },
  );
  ipcMain.handle('dataCollection:listSeedCreators', () => {
    return listSeedCreatorsForPicker(openDb());
  });
  ipcMain.handle('dataCollection:runPatternAnalysis', () => {
    return runPatternAnalysis();
  });

  // ---- Twitch Helix (段階 X1: auto-record series) ------------------------
  // Client ID is plaintext (public per Twitch's developer console). The
  // Client Secret never crosses the IPC boundary in plaintext after
  // it's been saved — handlers return only presence flags.
  ipcMain.handle('twitch:getClientCredentials', async () => {
    const cfg = await loadConfig();
    return {
      clientId: cfg.twitchClientId,
      hasSecret: await secureStorage.hasTwitchSecret(),
    };
  });
  ipcMain.handle(
    'twitch:setClientCredentials',
    async (_e, args: { clientId: string; clientSecret: string }) => {
      const id = typeof args?.clientId === 'string' ? args.clientId.trim() : '';
      const sec = typeof args?.clientSecret === 'string' ? args.clientSecret.trim() : '';
      if (!id) return { ok: false, error: 'Client ID が必要です' };
      if (!sec) return { ok: false, error: 'Client Secret が必要です' };
      try {
        await saveConfig({ twitchClientId: id });
        await secureStorage.saveTwitchSecret(sec);
        // Mirror the plaintext clientId into the backup so export/import
        // round-trips capture both halves of the credential pair.
        await secureStorage.updateTwitchClientIdInBackup(id);
        // Drop any cached token from the previous credentials so the
        // next API call obtains a fresh one for the new pair.
        twitchHelix.clearTokenCache();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle('twitch:clearClientCredentials', async () => {
    await saveConfig({ twitchClientId: null });
    await secureStorage.deleteTwitchSecret();
    await secureStorage.updateTwitchClientIdInBackup(null);
    twitchHelix.clearTokenCache();
  });
  ipcMain.handle('twitch:testCredentials', async () => {
    const cfg = await loadConfig();
    const sec = await secureStorage.loadTwitchSecret();
    if (!cfg.twitchClientId || !sec) {
      return { ok: false, error: 'Client ID / Secret が未設定です' };
    }
    try {
      await twitchHelix.getAccessToken(cfg.twitchClientId, sec);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // ---- Creator search (Gemini + Twitch + YouTube profile lookup) ---------
  ipcMain.handle('creatorSearch:askGemini', async (_e, query: string) => {
    if (typeof query !== 'string') throw new Error('askGemini: query must be a string');
    return creatorSearch.askGemini(query);
  });
  ipcMain.handle('creatorSearch:fetchTwitchProfile', async (_e, login: string) => {
    if (typeof login !== 'string' || !login.trim()) return null;
    const cfg = await loadConfig();
    const sec = await secureStorage.loadTwitchSecret();
    if (!cfg.twitchClientId || !sec) {
      throw new Error('Twitch Client ID / Secret が未設定です。設定 → Twitch 認証で入力してください');
    }
    return creatorSearch.fetchTwitchProfile(cfg.twitchClientId, sec, login);
  });
  ipcMain.handle(
    'creatorSearch:fetchYouTubeProfile',
    async (_e, args: { handle?: string | null; channelId?: string | null }) => {
      if (!args) return null;
      return creatorSearch.fetchYouTubeProfile({
        handle: typeof args.handle === 'string' ? args.handle : null,
        channelId: typeof args.channelId === 'string' ? args.channelId : null,
      });
    },
  );

  // 2026-05-04 — Hybrid search: Gemini primary + API fallback. The
  // single endpoint replaces the askGemini → fetchTwitch / fetchYouTube
  // dance the renderer used to do. Keeping the old endpoints around
  // because they're still useful for the manual-input fallback paths.
  ipcMain.handle(
    'creatorSearch:searchAll',
    async (_e, args: { query: string; minFollowersOverride?: number | null } | string) => {
      // Backwards-compatible: old renderer builds may pass a bare string.
      const query = typeof args === 'string' ? args : args?.query;
      const override = typeof args === 'object' && args !== null
        ? args.minFollowersOverride
        : undefined;
      if (typeof query !== 'string') return null;
      const cfg = await loadConfig();
      const sec = await secureStorage.loadTwitchSecret();
      // Override (used by the "lower threshold" relaxation buttons)
      // takes precedence over AppConfig. Negative / undefined → fall
      // back to AppConfig. Explicit 0 = disable filter for this query.
      const minFollowers =
        typeof override === 'number' && override >= 0
          ? override
          : (cfg.searchMinFollowers ?? 200_000);
      return creatorSearch.searchCreators({
        query,
        twitchClientId: cfg.twitchClientId ?? null,
        twitchClientSecret: sec,
        minFollowers,
      });
    },
  );

  // ---- Monitored-creators CRUD (platform-agnostic) -----------------------
  ipcMain.handle('monitoredCreators:list', async () => {
    const cfg = await loadConfig();
    return cfg.monitoredCreators;
  });
  ipcMain.handle('monitoredCreators:add', async (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('monitoredCreators:add: invalid args');
    const o = raw as Record<string, unknown>;
    const displayName = typeof o['displayName'] === 'string' ? o['displayName'] : '';
    const profileImageUrl = typeof o['profileImageUrl'] === 'string' ? o['profileImageUrl'] : null;
    const platform = o['platform'];
    const cfg = await loadConfig();
    let entry;
    let dedupKey: string;
    if (platform === 'twitch') {
      const twitchUserId = typeof o['twitchUserId'] === 'string' ? o['twitchUserId'] : '';
      const twitchLogin = typeof o['twitchLogin'] === 'string' ? o['twitchLogin'] : '';
      if (!twitchUserId || !twitchLogin || !displayName) {
        throw new Error('monitoredCreators:add: missing twitch fields');
      }
      dedupKey = twitchUserId;
      const existing = cfg.monitoredCreators.find(
        (c) => c.platform === 'twitch' && c.twitchUserId === twitchUserId,
      );
      const followerCount =
        typeof o['followerCount'] === 'number' ? (o['followerCount'] as number) : null;
      const accountCreatedAt =
        typeof o['accountCreatedAt'] === 'string' ? (o['accountCreatedAt'] as string) : '';
      entry = {
        platform: 'twitch' as const,
        twitchUserId,
        twitchLogin,
        displayName,
        profileImageUrl,
        addedAt: existing?.addedAt ?? Date.now(),
        enabled: existing?.enabled ?? true,
        followerCount,
        accountCreatedAt,
      };
    } else if (platform === 'youtube') {
      const youtubeChannelId = typeof o['youtubeChannelId'] === 'string' ? o['youtubeChannelId'] : '';
      const youtubeHandle = typeof o['youtubeHandle'] === 'string' ? o['youtubeHandle'] : null;
      if (!youtubeChannelId || !displayName) {
        throw new Error('monitoredCreators:add: missing youtube fields');
      }
      dedupKey = youtubeChannelId;
      const existing = cfg.monitoredCreators.find(
        (c) => c.platform === 'youtube' && c.youtubeChannelId === youtubeChannelId,
      );
      const subscriberCount =
        typeof o['subscriberCount'] === 'number' ? (o['subscriberCount'] as number) : null;
      const accountCreatedAt =
        typeof o['accountCreatedAt'] === 'string' ? (o['accountCreatedAt'] as string) : '';
      entry = {
        platform: 'youtube' as const,
        youtubeChannelId,
        youtubeHandle,
        displayName,
        profileImageUrl,
        addedAt: existing?.addedAt ?? Date.now(),
        enabled: existing?.enabled ?? true,
        subscriberCount,
        accountCreatedAt,
      };
    } else {
      throw new Error(`monitoredCreators:add: unsupported platform "${String(platform)}"`);
    }
    // Idempotent: replace in-place if present, else append.
    const next = cfg.monitoredCreators.some(
      (c) => c.platform === entry.platform && monitoredCreatorKey(c) === dedupKey,
    )
      ? cfg.monitoredCreators.map((c) =>
          c.platform === entry.platform && monitoredCreatorKey(c) === dedupKey ? entry : c,
        )
      : [...cfg.monitoredCreators, entry];
    const saved = await saveConfig({ monitoredCreators: next });
    return saved.monitoredCreators;
  });
  ipcMain.handle(
    'monitoredCreators:remove',
    async (_e, args: { platform: 'twitch' | 'youtube'; key: string }) => {
      if (!args?.platform || !args?.key) throw new Error('monitoredCreators:remove: invalid args');
      const cfg = await loadConfig();
      const next = cfg.monitoredCreators.filter(
        (c) => !(c.platform === args.platform && monitoredCreatorKey(c) === args.key),
      );
      const saved = await saveConfig({ monitoredCreators: next });
      return saved.monitoredCreators;
    },
  );
  ipcMain.handle(
    'monitoredCreators:setEnabled',
    async (_e, args: { platform: 'twitch' | 'youtube'; key: string; enabled: boolean }) => {
      if (!args?.platform || !args?.key) throw new Error('monitoredCreators:setEnabled: invalid args');
      const cfg = await loadConfig();
      const next = cfg.monitoredCreators.map((c) =>
        c.platform === args.platform && monitoredCreatorKey(c) === args.key
          ? { ...c, enabled: !!args.enabled }
          : c,
      );
      const saved = await saveConfig({ monitoredCreators: next });
      return saved.monitoredCreators;
    },
  );
  ipcMain.handle(
    'monitoredCreators:refetchTwitch',
    async (_e, args: { twitchUserId: string }) => {
      if (!args?.twitchUserId) throw new Error('refetchTwitch: twitchUserId required');
      const cfg = await loadConfig();
      const target = cfg.monitoredCreators.find(
        (c) => c.platform === 'twitch' && c.twitchUserId === args.twitchUserId,
      );
      if (!target || target.platform !== 'twitch') {
        return { ok: false, error: ' 該当する Twitch 登録が見つかりません' };
      }
      const sec = await secureStorage.loadTwitchSecret();
      if (!cfg.twitchClientId || !sec) {
        return { ok: false, error: 'Twitch 認証情報が未設定です(設定 → Twitch 認証)' };
      }
      try {
        const fresh = await twitchHelix.searchUserByLogin(
          cfg.twitchClientId,
          sec,
          target.twitchLogin,
        );
        if (!fresh) {
          return {
            ok: false,
            error: `ログイン名 "${target.twitchLogin}" のユーザが見つかりません(改名 / 削除 / スペルミスの可能性)`,
          };
        }
        // Best-effort follower count refresh too — same caveat as
        // creatorSearch.fetchTwitchProfile (most app-only tokens
        // can't read /helix/channels/followers and we land on null).
        const followerCount = await twitchHelix.getTwitchFollowerCount(
          cfg.twitchClientId,
          sec,
          fresh.id,
        );
        // Replace the stale entry. Preserve enabled + addedAt; refresh
        // userId / login / displayName / profileImageUrl + follower /
        // createdAt from Twitch.
        const updatedEntry = {
          platform: 'twitch' as const,
          twitchUserId: fresh.id,
          twitchLogin: fresh.login,
          displayName: fresh.displayName,
          profileImageUrl: fresh.profileImageUrl,
          addedAt: target.addedAt,
          enabled: target.enabled,
          followerCount,
          accountCreatedAt: fresh.createdAt,
        };
        // dedup if the new userId already exists as another entry
        // (rare: user was registered twice). filter out the stale one
        // by old userId, then upsert by new userId.
        const next = cfg.monitoredCreators
          .filter((c) => !(c.platform === 'twitch' && c.twitchUserId === args.twitchUserId))
          .filter((c) => !(c.platform === 'twitch' && c.twitchUserId === fresh.id));
        next.push(updatedEntry);
        const saved = await saveConfig({ monitoredCreators: next });
        const updatedFromSaved = saved.monitoredCreators.find(
          (c) => c.platform === 'twitch' && c.twitchUserId === fresh.id,
        );
        console.log(
          `[refetch-twitch] ${target.twitchLogin}: ${args.twitchUserId} → ${fresh.id}` +
            (args.twitchUserId === fresh.id ? ' (no change)' : ' (UPDATED)'),
        );
        return { ok: true, updated: updatedFromSaved };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // ---- Stream-monitor (段階 X2) ------------------------------------------
  ipcMain.handle('streamMonitor:getStatus', () => streamMonitor.getStatus());
  ipcMain.handle('streamMonitor:setEnabled', async (_e, enabled: boolean) => {
    await saveConfig({ streamMonitorEnabled: !!enabled });
    if (enabled) {
      streamMonitor.start();
    } else {
      streamMonitor.stop();
    }
    return streamMonitor.getStatus();
  });
  ipcMain.handle('streamMonitor:pollNow', async () => {
    await streamMonitor.pollNow();
    return streamMonitor.getStatus();
  });

  // ---- Stream-recorder (段階 X3+X4) -------------------------------------
  ipcMain.handle('streamRecorder:list', () => streamRecorder.list());
  ipcMain.handle('streamRecorder:stop', async (_e, args: { creatorKey: string }) => {
    if (!args?.creatorKey) throw new Error('streamRecorder:stop: creatorKey required');
    await streamRecorder.stopByCreatorKey(args.creatorKey);
  });
  ipcMain.handle('streamRecorder:delete', async (_e, args: { recordingId: string }) => {
    if (!args?.recordingId) throw new Error('streamRecorder:delete: recordingId required');
    await streamRecorder.deleteRecording(args.recordingId);
  });
  ipcMain.handle('streamRecorder:getRecordingDir', () => streamRecorder.getRecordingDir());
  ipcMain.handle('streamRecorder:revealInFolder', async (_e, args: { recordingId: string }) => {
    if (!args?.recordingId) return;
    const list = await streamRecorder.list();
    const target = list.find((m) => m.recordingId === args.recordingId);
    if (!target) return;
    // Open the containing folder. Prefer the live or vod file as the
    // selected item so Explorer highlights it.
    const fname = target.files.vod ?? target.files.live;
    if (fname) {
      shell.showItemInFolder(path.join(target.folder, fname));
    } else {
      void shell.openPath(target.folder);
    }
  });

  // ---- Gemini multi-key + audio analysis (Task 1) ------------------------
  ipcMain.handle('gemini:hasApiKey', () => secureStorage.hasGeminiApiKeys());
  ipcMain.handle('gemini:getKeyCount', () => secureStorage.countGeminiApiKeys());
  ipcMain.handle('gemini:getKeys', () => secureStorage.loadGeminiApiKeys());
  ipcMain.handle('gemini:setKeys', async (_e, keys: string[]) => {
    if (!Array.isArray(keys)) throw new Error('keys must be string[]');
    await secureStorage.saveGeminiApiKeys(keys);
  });
  ipcMain.handle('gemini:clear', () => secureStorage.clearGeminiApiKeys());
  ipcMain.handle('gemini:validateApiKey', async (_e, key: string) => {
    const ok = await gemini.validateApiKey(key);
    return ok ? { ok: true } : { ok: false, error: 'API キーの検証に失敗しました' };
  });

  // Orchestrates extract → cache check → upload → analyse → cache write.
  // Emits 'extracting' / 'uploading' / 'understanding' / 'parsing' on the
  // 'gemini:progress' channel so the renderer can update its modal.
  ipcMain.handle('gemini:analyzeVideo', async (_e, args: GeminiAnalysisStartArgs) => {
    const cached = await gemini.readCache(args.videoFilePath);
    if (cached) {
      // Cache hits skip the entire pipeline. Emit a 'parsing' tick so
      // the modal completes its progress bar visibly rather than
      // popping straight to the result.
      mainWindow?.webContents.send('gemini:progress', 'parsing' as GeminiAnalysisPhase);
      return cached;
    }

    mainWindow?.webContents.send('gemini:progress', 'extracting' as GeminiAnalysisPhase);
    const extractAc = new AbortController();
    const audioPath = await extractAudioToTemp({
      videoFilePath: args.videoFilePath,
      durationSec: args.durationSec,
      signal: extractAc.signal,
      onRatio: () => { /* fine-grained ratio not surfaced for this flow */ },
      filenamePrefix: 'jcut-gemini-audio-',
    });

    try {
      const result = await gemini.runAnalysis(
        audioPath,
        args.videoTitle,
        args.durationSec,
        (phase) => {
          mainWindow?.webContents.send('gemini:progress', phase satisfies GeminiAnalysisPhase);
        },
      );
      await gemini.writeCache(args.videoFilePath, result);
      return result;
    } finally {
      // Clean up the temp audio file regardless of success/failure.
      await fsPromises.rm(audioPath, { force: true }).catch(() => { /* best-effort */ });
    }
  });
  ipcMain.handle('gemini:cancelAnalysis', () => gemini.cancelAnalysis());

  // Per-key usage snapshot for the API management quota panel. Same
  // ordering as the saved keys so the renderer can label rows
  // "キー 1 / キー 2 / ...". todayLimit is the gemini-2.5-flash free-
  // tier RPD (500); revisit when the model selection changes.
  const GEMINI_DAILY_RPD = 500;
  ipcMain.handle('gemini:getKeyUsages', async () => {
    const keys = await secureStorage.loadGeminiApiKeys();
    return keys.map((k) => {
      const keyHash = hashApiKey(k);
      const usage = getGeminiKeyUsage(keyHash);
      return {
        keyHash,
        todayCount: usage.todayCount,
        todayLimit: GEMINI_DAILY_RPD,
        lastError: usage.lastError,
      };
    });
  });

  // Collection log viewer.
  ipcMain.handle('collectionLog:read', (_e, limit?: number) =>
    readCollectionLog(typeof limit === 'number' ? limit : 5000),
  );
  ipcMain.handle('collectionLog:openInExplorer', () => {
    void shell.openPath(collectionLogPath());
  });
  ipcMain.handle('collectionLog:getQuotaPerKey', () => getQuotaPerKeyToday());

  // 2026-05-04 — Recent-videos feed for the load-phase home screen.
  // Unified list of auto-recorded streams + URL-downloaded VODs
  // within the last `maxAgeHours`. Renderer polls every 60s.
  ipcMain.handle('recentVideos:list', async (_e, maxAgeHours: number) => {
    const hours = typeof maxAgeHours === 'number' && maxAgeHours > 0 ? maxAgeHours : 24;
    return recentVideos.listRecentVideos(hours);
  });

  // 1-button auto-extract orchestrator (Task 2). Pipeline:
  //   1. cache-check        → emit "started" tick for the modal
  //   2. audio-extract      → ffmpeg pulls 16 kHz mono mp3
  //   3. gemini             → Gemini 2.5 Flash structural understanding
  //   4. detect/refine/titles → existing autoExtractClipCandidates path,
  //                              now Gemini-aware (highlights folded
  //                              into the Claude refine prompt)
  // Failure handling: a missing Gemini key OR Gemini analysis failure
  // degrades to the comment-only path (M1.5b behaviour) — the modal
  // shows the gemini step as ⊘ skipped instead of progressing.
  ipcMain.handle(
    'aiSummary:autoExtract',
    async (
      _e,
      args: Parameters<typeof aiSummary.autoExtractClipCandidates>[0] & {
        videoFilePath?: string;
        audioFilePath?: string;
      },
    ) => {
      const send = (p: { phase: string; percent: number; skipped?: boolean }) => {
        mainWindow?.webContents.send('aiSummary:autoExtractProgress', p);
      };

      // Stage 2 — `audioFilePath` short-circuits the audio-extract
      // step (the renderer's audio-first DL produced an mp3/m4a
      // already). `videoFilePath` is the legacy / local-drop fallback;
      // the orchestrator runs ffmpeg on it. Either is required for
      // Gemini, but Gemini itself is optional (key absent → skipped).
      const preExtractedAudio = args.audioFilePath ?? null;
      const videoFilePath = args.videoFilePath ?? args.videoKey;
      const videoTitle = args.videoTitle ?? (preExtractedAudio ?? videoFilePath).split(/[\\/]/).pop() ?? videoFilePath;

      send({ phase: 'cache-check', percent: 0 });

      let geminiHighlights: typeof args.geminiHighlights = undefined;
      let geminiTimeline: typeof args.geminiTimeline = undefined;

      // Try Gemini cache first. Missing key OR cache miss + analysis
      // failure both degrade to comment-only.
      const geminiKeyCount = await secureStorage.countGeminiApiKeys();
      if (geminiKeyCount === 0) {
        // No Gemini key — degrade silently. Modal shows the step as skipped.
        send({ phase: 'gemini', percent: 100, skipped: true });
      } else {
        // Cache key prefers videoKey (renderer typically sends sessionId
        // for URL-DL flows / filePath for local-drop flows). The same
        // value flows through to refineCacheKey downstream.
        const cachedGemini = await gemini.readCache(args.videoKey);
        if (cachedGemini) {
          geminiHighlights = cachedGemini.highlights;
          geminiTimeline = cachedGemini.timelineSummary;
          send({ phase: 'gemini', percent: 100 });
        } else {
          // Need to extract (or use pre-extracted) + analyse. Wrap in
          // try/catch so any failure falls back to comment-only.
          let audioPath: string | null = null;
          let audioPathOwned = false; // true when we created the temp file ourselves
          try {
            if (preExtractedAudio) {
              // Stage 2 fast path — the renderer's audio-first DL gave
              // us an audio file already. Skip ffmpeg; do not delete
              // afterwards (the renderer owns the file lifetime).
              send({ phase: 'audio-extract', percent: 100, skipped: true });
              audioPath = preExtractedAudio;
            } else {
              send({ phase: 'audio-extract', percent: 0 });
              const extractAc = new AbortController();
              audioPath = await extractAudioToTemp({
                videoFilePath,
                durationSec: args.videoDurationSec,
                signal: extractAc.signal,
                onRatio: (r) => {
                  send({ phase: 'audio-extract', percent: Math.round(r * 100) });
                },
                filenamePrefix: 'jcut-gemini-audio-',
              });
              audioPathOwned = true;
            }
            send({ phase: 'gemini', percent: 0 });
            const result = await gemini.runAnalysis(
              audioPath,
              videoTitle,
              args.videoDurationSec,
              () => {
                // gemini.runAnalysis emits its own fine-grained phases
                // (uploading/understanding/parsing); the orchestrator
                // collapses them into a single 'gemini' macro step.
              },
            );
            await gemini.writeCache(args.videoKey, result);
            geminiHighlights = result.highlights;
            geminiTimeline = result.timelineSummary;
            send({ phase: 'gemini', percent: 100 });
          } catch (err) {
            console.warn('[auto-extract] Gemini analysis failed, continuing comment-only:', err);
            send({ phase: 'gemini', percent: 100, skipped: true });
          } finally {
            if (audioPath && audioPathOwned) {
              await fsPromises.rm(audioPath, { force: true }).catch(() => {});
            }
          }
        }
      }

      // Delegate to the existing pipeline for detect / refine / titles.
      // refine prompt now folds in geminiHighlights/geminiTimeline.
      return aiSummary.autoExtractClipCandidates(
        {
          ...args,
          videoTitle,
          geminiHighlights,
          geminiTimeline,
        },
        (p) => send(p),
      );
    },
  );
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  handleMediaProtocol();
  buildMenu({ getMainWindow: () => mainWindow, onQuit: actuallyQuit });
  registerIpcHandlers();
  createWindow();

  // 段階 X3.5 — auto-launch flag + tray. We honour the launchedMinimized
  // CLI flag here so the user's "start at boot, minimized" preference
  // produces a tray-only app on login. The window is still created
  // (so renderer state is live) but immediately hidden.
  if (launchedMinimized && mainWindow && process.platform === 'win32') {
    mainWindow.hide();
  }
  createTray({
    getMainWindow: () => mainWindow,
    showMainWindow,
    openMonitoredCreators: () => {
      showMainWindow();
      // Defer to next tick so the window is fully visible before we
      // ask the renderer to swap phase — otherwise the swap fires
      // against a hidden window and can race React's hydration.
      setTimeout(() => {
        mainWindow?.webContents.send('menu:openMonitoredCreators');
      }, 0);
    },
    quit: actuallyQuit,
  });

  // 2026-05-04 — boot-time API-key backup sync. Runs early so any
  // subsequent code path that loads keys benefits from auto-recovery
  // (e.g. dataCollectionManager.start() below). Idempotent: only
  // fills slots that aren't already in the backup.
  try {
    const cfgEarly = await loadConfig();
    await secureStorage.ensureBackupInitialized({
      twitchClientId: cfgEarly.twitchClientId ?? null,
    });
  } catch (err) {
    console.warn('[secureStorage] backup init failed (non-fatal):', err);
  }

  // Run any pending DB migrations BEFORE the seed step touches the
  // database. Migration 001 splits clip uploaders out of the creators
  // table — running it first guarantees getStats / upsertCreator etc.
  // see the post-migration schema. Idempotent via PRAGMA user_version,
  // creates a timestamped backup of the .db file before mutating.
  try {
    const result = await runMigrations();
    console.log('[migration] result:', result);
  } catch (err) {
    console.warn('[migration] failed:', err);
  }

  // Seed-or-update creators.json (idempotent diff-merge — adds names
  // that aren't yet present and backfills missing group tags, but
  // never removes a hand-edited entry or overwrites a resolved
  // channelId). This must run before the manager touches the list so
  // the first batch already sees the full curated targeting set.
  try {
    await seedOrUpdateCreators();
  } catch (err) {
    console.warn('[data-collection] seed step failed:', err);
  }

  // Background data-collection. Gated by the persisted master switch
  // so a fresh install does NOT start consuming quota until the user
  // explicitly opts in. The manager itself also no-ops without keys,
  // but checking the flag here keeps logs honest about *why* nothing
  // is running.
  const cfg = await loadConfig();
  if (cfg.dataCollectionEnabled) {
    void dataCollectionManager.start();
  } else {
    console.log('[data-collection] auto-start skipped (dataCollectionEnabled=false)');
  }

  // 段階 X3.5 — boot-time wiring: cache closeToTray, register / unregister
  // the Windows login item, hook the streamMonitor → tray bridge.
  cachedCloseToTray = cfg.closeToTray;
  applyLoginItemSettings({
    startOnBoot: cfg.startOnBoot,
    startMinimized: cfg.startMinimized,
  });
  // Subscribe to the same status events the renderer listens to. We
  // do it here instead of inside StreamMonitor itself because the
  // tray is platform-specific (Windows-only) and we don't want to
  // pollute the monitor with platform branching.
  streamMonitor.subscribeStatus((status) => {
    updateTrayLiveCount({
      liveCount: status.liveStreams.length,
      showMainWindow,
      openMonitoredCreators: () => {
        showMainWindow();
        setTimeout(() => {
          mainWindow?.webContents.send('menu:openMonitoredCreators');
        }, 0);
      },
      quit: actuallyQuit,
    });
  });

  // 段階 X3+X4 — auto-record subscriptions MUST be registered BEFORE
  // streamMonitor.start() kicks off the first poll. Otherwise a race
  // condition: the first poll detects already-live creators (case E
  // — they were broadcasting before the app launched), fires
  // 'started' events synchronously through `send`, and finds an
  // empty startedListeners set. Subsequent polls produce no diff
  // change for those same creators, so the events never fire again
  // and recording silently never begins. (2026-05-04 emergency fix.)
  streamRecorder.attachWindow(mainWindow);
  await streamRecorder.boot();
  streamMonitor.subscribeStreamStarted((info) => {
    void streamRecorder.onStreamStarted(info);
  });
  streamMonitor.subscribeStreamEnded((args) => {
    void streamRecorder.onStreamEnded(args);
  });

  // 段階 X2 — auto-start the live-stream poller if the user opted in
  // last session. Keeps the registered-channels page's "live" badges
  // up to date from the moment the app opens. Stays off for fresh
  // installs (default false in DEFAULT_CONFIG).
  if (cfg.streamMonitorEnabled) {
    streamMonitor.start();
  } else {
    console.log('[stream-monitor] auto-start skipped (streamMonitorEnabled=false)');
  }

  // 段階 X3.5 — handle a second-instance launch (user double-clicks
  // the exe while we're already running). Surface the existing window
  // instead of starting a parallel app.
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 段階 X3.5 — when closeToTray is on, the main window only HIDES on
  // X click, so window-all-closed never fires through that path. But
  // a real "destroyed" event (window programmatically closed, IPC
  // crash, etc.) still emits this. Only quit if the user has
  // explicitly invoked actuallyQuit() — otherwise stay alive in the
  // tray.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', () => {
  // Mark quitting so the next `close` event passes through cleanly
  // (e.g. the user invoked Quit via the system tray, which calls
  // actuallyQuit but the close event for the visible window arrives
  // afterwards).
  isQuitting = true;
  // 2026-05-04 emergency fix — kill any in-flight recording
  // subprocesses + persist their metadata as 'failed' BEFORE the
  // process exits. Without this, yt-dlp.exe children survive parent
  // death (Windows spawn default), accumulating as zombies (~10
  // observed across one overnight test). Sync because before-quit
  // is the last hook before the OS tears the process down.
  try {
    streamRecorder.shutdownSync();
  } catch (err) {
    console.warn('[shutdown] streamRecorder.shutdownSync failed:', err);
  }
});

app.on('will-quit', () => {
  // Tear down OS-level resources. Tray icons survive process exit on
  // Windows for a few seconds otherwise (until the shell notices the
  // owning HWND is gone), which looks like a leak.
  destroyTray();
  // Release any held power-save blockers. The OS reclaims them on
  // process exit anyway, but explicit cleanup keeps `powercfg
  // /requests` clean during dev iteration.
  powerSave.releaseAll();
});

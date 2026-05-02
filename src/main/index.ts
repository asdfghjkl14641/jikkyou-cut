import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { readCollectionLog } from './dataCollection/logReader';
import { collectionLogPath } from './dataCollection/logger';
import { getQuotaPerKeyToday } from './dataCollection/database';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registerMediaScheme, handleMediaProtocol } from './mediaProtocol';
import { openVideoFileDialog, openDirectoryDialog } from './fileDialog';
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
import { dataCollectionManager } from './dataCollection';
import { seedOrUpdateCreators } from './dataCollection/seedCreators';
import * as creatorList from './dataCollection/creatorList';
import type { AppConfig } from '../common/config';
import type {
  CommentAnalysisStartArgs,
  ExportStartArgs,
  SubtitleSettings,
  TranscriptCue,
  TranscriptionStartArgs,
} from '../common/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

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

  mainWindow.on('closed', () => {
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

function registerIpcHandlers() {
  ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow) return null;
    return openVideoFileDialog(mainWindow);
  });
  ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null;
    return openDirectoryDialog(mainWindow);
  });

  // settings (non-secret)
  ipcMain.handle('settings:get', () => loadConfig());
  ipcMain.handle('settings:save', (_e, partial: Partial<AppConfig>) =>
    saveConfig(partial),
  );

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

  // URL download
  ipcMain.handle('urlDownload:start', async (_e, args) => {
    return urlDownload.downloadVideo({
      ...args,
      onProgress: (p) => {
        mainWindow?.webContents.send('urlDownload:progress', p);
      },
    });
  });
  ipcMain.handle('urlDownload:cancel', () => urlDownload.cancelDownload());

  // Comment analysis(yt-dlp チャットリプレイ + playboard 視聴者数 + スコア)
  ipcMain.handle(
    'commentAnalysis:start',
    async (_e, args: CommentAnalysisStartArgs) => {
      return commentAnalysis.analyzeComments(args, (p) => {
        mainWindow?.webContents.send('commentAnalysis:progress', p);
      });
    },
  );
  ipcMain.handle('commentAnalysis:cancel', () => commentAnalysis.cancelAnalysis());

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

  // Collection log viewer.
  ipcMain.handle('collectionLog:read', (_e, limit?: number) =>
    readCollectionLog(typeof limit === 'number' ? limit : 5000),
  );
  ipcMain.handle('collectionLog:openInExplorer', () => {
    void shell.openPath(collectionLogPath());
  });
  ipcMain.handle('collectionLog:getQuotaPerKey', () => getQuotaPerKeyToday());

  // 1-button auto-extract: peak detection → AI refine → title generation.
  // Owns its own progress channel ('aiSummary:autoExtractProgress') so the
  // 3-phase progress bar in ClipSelectView doesn't get cross-talk from
  // the manual title-generation flow above.
  ipcMain.handle(
    'aiSummary:autoExtract',
    async (_e, args: Parameters<typeof aiSummary.autoExtractClipCandidates>[0]) => {
      return aiSummary.autoExtractClipCandidates(args, (p) => {
        mainWindow?.webContents.send('aiSummary:autoExtractProgress', p);
      });
    },
  );
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  handleMediaProtocol();
  buildMenu(() => mainWindow);
  registerIpcHandlers();
  createWindow();

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

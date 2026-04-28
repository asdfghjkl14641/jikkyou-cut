import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registerMediaScheme, handleMediaProtocol } from './mediaProtocol';
import { openVideoFileDialog } from './fileDialog';
import { buildMenu } from './menu';
import { loadConfig, saveConfig } from './config';
import * as secureStorage from './secureStorage';
import * as gemini from './gemini';
import * as project from './project';
import * as exportModule from './export';
import type { AppConfig } from '../common/config';
import type {
  ExportStartArgs,
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
    gemini.validateApiKey(key),
  );

  // transcription
  ipcMain.handle('transcription:start', async (_e, args: TranscriptionStartArgs) => {
    const apiKey = await secureStorage.loadSecret();
    if (!apiKey) throw new Error('APIキーが設定されていません');
    const config = await loadConfig();
    return gemini.transcribe({
      videoFilePath: args.videoFilePath,
      durationSec: args.durationSec,
      apiKey,
      context: config.transcriptionContext,
      onProgress: (p) => {
        mainWindow?.webContents.send('transcription:progress', p);
      },
    });
  });
  ipcMain.handle('transcription:cancel', () => gemini.cancelTranscription());

  // project file
  ipcMain.handle('project:load', (_e, videoFilePath: string) =>
    project.loadProject(videoFilePath),
  );
  ipcMain.handle(
    'project:save',
    (_e, videoFilePath: string, cues: TranscriptCue[]) =>
      project.saveProject(videoFilePath, cues),
  );
  ipcMain.handle('project:clear', (_e, videoFilePath: string) =>
    project.clearProject(videoFilePath),
  );

  // export
  ipcMain.handle('export:start', async (_e, args: ExportStartArgs) =>
    exportModule.startExport({
      videoFilePath: args.videoFilePath,
      regions: args.regions,
      onProgress: (p) => {
        mainWindow?.webContents.send('export:progress', p);
      },
    }),
  );
  ipcMain.handle('export:cancel', () => exportModule.cancelExport());
  ipcMain.handle('shell:revealInFolder', (_e, p: string) => {
    shell.showItemInFolder(p);
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  handleMediaProtocol();
  buildMenu(() => mainWindow);
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registerMediaScheme, handleMediaProtocol } from './mediaProtocol';
import { openVideoFileDialog, openModelFileDialog } from './fileDialog';
import { buildMenu } from './menu';
import { loadConfig, saveConfig } from './config';
import { startTranscription, cancelTranscription } from './whisper';
import type { AppConfig } from '../common/config';
import type { TranscriptionStartArgs } from '../common/types';

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

  ipcMain.handle('dialog:openModel', async () => {
    if (!mainWindow) return null;
    return openModelFileDialog(mainWindow);
  });

  ipcMain.handle('settings:get', () => loadConfig());
  ipcMain.handle('settings:save', (_e, partial: Partial<AppConfig>) =>
    saveConfig(partial),
  );

  ipcMain.handle('transcription:start', async (_e, args: TranscriptionStartArgs) => {
    const config = await loadConfig();
    if (!config.whisperModelPath) {
      throw new Error('Whisperモデルが設定されていません');
    }
    return startTranscription({
      videoFilePath: args.videoFilePath,
      modelPath: config.whisperModelPath,
      durationSec: args.durationSec,
      onProgress: (p) => {
        mainWindow?.webContents.send('transcription:progress', p);
      },
    });
  });

  ipcMain.handle('transcription:cancel', () => cancelTranscription());
}

app.whenReady().then(() => {
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

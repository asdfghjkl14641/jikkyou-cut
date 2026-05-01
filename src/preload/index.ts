import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ExportProgress,
  FontDownloadProgress,
  IpcApi,
  TranscriptionProgress,
  UrlDownloadProgress,
} from '../common/types';

const onChannel = (channel: string) => (cb: () => void) => {
  const listener = () => cb();
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const api: IpcApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenuOpenFile: onChannel('menu:openFile'),
  onMenuOpenSettings: onChannel('menu:openSettings'),
  onMenuOpenOperations: onChannel('menu:openOperations'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  hasApiKey: () => ipcRenderer.invoke('apiKey:has'),
  setApiKey: (key) => ipcRenderer.invoke('apiKey:set', key),
  clearApiKey: () => ipcRenderer.invoke('apiKey:clear'),
  validateApiKey: (key) => ipcRenderer.invoke('apiKey:validate', key),

  startTranscription: (args) => ipcRenderer.invoke('transcription:start', args),
  cancelTranscription: () => ipcRenderer.invoke('transcription:cancel'),
  onTranscriptionProgress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: TranscriptionProgress,
    ) => cb(p);
    ipcRenderer.on('transcription:progress', listener);
    return () => {
      ipcRenderer.removeListener('transcription:progress', listener);
    };
  },

  loadProject: (videoFilePath) =>
    ipcRenderer.invoke('project:load', videoFilePath),
  saveProject: (videoFilePath, cues, activePresetId) =>
    ipcRenderer.invoke('project:save', videoFilePath, cues, activePresetId),
  clearProject: (videoFilePath) =>
    ipcRenderer.invoke('project:clear', videoFilePath),

  startExport: (args) => ipcRenderer.invoke('export:start', args),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ExportProgress) =>
      cb(p);
    ipcRenderer.on('export:progress', listener);
    return () => {
      ipcRenderer.removeListener('export:progress', listener);
    };
  },
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p),

  fonts: {
    listAvailable: () => ipcRenderer.invoke('fonts:listAvailable'),
    listInstalled: () => ipcRenderer.invoke('fonts:listInstalled'),
    download: (families) => ipcRenderer.invoke('fonts:download', families),
    remove: (family) => ipcRenderer.invoke('fonts:remove', family),
  },

  subtitleSettings: {
    load: () => ipcRenderer.invoke('subtitleSettings:load'),
    save: (settings) => ipcRenderer.invoke('subtitleSettings:save', settings),
  },

  onFontDownloadProgress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: FontDownloadProgress,
    ) => cb(p);
    ipcRenderer.on('fonts:downloadProgress', listener);
    return () => {
      ipcRenderer.removeListener('fonts:downloadProgress', listener);
    };
  },
  setWindowTitle: (title) => ipcRenderer.send('window:setTitle', title),

  urlDownload: {
    start: (args) => ipcRenderer.invoke('urlDownload:start', args),
    cancel: () => ipcRenderer.invoke('urlDownload:cancel'),
    onProgress: (cb) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        p: UrlDownloadProgress,
      ) => cb(p);
      ipcRenderer.on('urlDownload:progress', listener);
      return () => {
        ipcRenderer.removeListener('urlDownload:progress', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

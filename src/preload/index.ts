import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ExportProgress,
  IpcApi,
  TranscriptionProgress,
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
  saveProject: (videoFilePath, cues) =>
    ipcRenderer.invoke('project:save', videoFilePath, cues),
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
};

contextBridge.exposeInMainWorld('api', api);

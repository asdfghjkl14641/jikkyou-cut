import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi, TranscriptionProgress } from '../common/types';

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
};

contextBridge.exposeInMainWorld('api', api);

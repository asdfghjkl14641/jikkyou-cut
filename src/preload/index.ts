import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi } from '../common/types';

const onChannel = (channel: string) => (cb: () => void) => {
  const listener = () => cb();
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const api: IpcApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openModelFileDialog: () => ipcRenderer.invoke('dialog:openModel'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenuOpenFile: onChannel('menu:openFile'),
  onMenuOpenSettings: onChannel('menu:openSettings'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  startTranscription: (args) => ipcRenderer.invoke('transcription:start', args),
  cancelTranscription: () => ipcRenderer.invoke('transcription:cancel'),
  onTranscriptionProgress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: Parameters<typeof cb>[0],
    ) => cb(p);
    ipcRenderer.on('transcription:progress', listener);
    return () => {
      ipcRenderer.removeListener('transcription:progress', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi } from '../common/types';

const api: IpcApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenuOpenFile: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('menu:openFile', listener);
    return () => {
      ipcRenderer.removeListener('menu:openFile', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

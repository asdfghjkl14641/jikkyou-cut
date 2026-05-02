import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CommentAnalysisProgress,
  ExportProgress,
  FontDownloadProgress,
  IpcApi,
  AiSummaryProgress,
  AutoExtractProgress,
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
  onMenuOpenApiManagement: onChannel('menu:openApiManagement'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  hasApiKey: () => ipcRenderer.invoke('apiKey:has'),
  setApiKey: (key) => ipcRenderer.invoke('apiKey:set', key),
  clearApiKey: () => ipcRenderer.invoke('apiKey:clear'),
  validateApiKey: (key) => ipcRenderer.invoke('apiKey:validate', key),

  hasAnthropicApiKey: () => ipcRenderer.invoke('anthropicApiKey:has'),
  setAnthropicApiKey: (key) => ipcRenderer.invoke('anthropicApiKey:set', key),
  clearAnthropicApiKey: () => ipcRenderer.invoke('anthropicApiKey:clear'),
  validateAnthropicApiKey: (key) => ipcRenderer.invoke('anthropicApiKey:validate', key),

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

  commentAnalysis: {
    start: (args) => ipcRenderer.invoke('commentAnalysis:start', args),
    cancel: () => ipcRenderer.invoke('commentAnalysis:cancel'),
    onProgress: (cb) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        p: CommentAnalysisProgress,
      ) => cb(p);
      ipcRenderer.on('commentAnalysis:progress', listener);
      return () => {
        ipcRenderer.removeListener('commentAnalysis:progress', listener);
      };
    },
  },

  aiSummary: {
    generate: (args) => ipcRenderer.invoke('aiSummary:generate', args),
    cancel: () => ipcRenderer.invoke('aiSummary:cancel'),
    onProgress: (cb) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        p: AiSummaryProgress,
      ) => cb(p);
      ipcRenderer.on('aiSummary:progress', listener);
      return () => {
        ipcRenderer.removeListener('aiSummary:progress', listener);
      };
    },
    autoExtract: (args) => ipcRenderer.invoke('aiSummary:autoExtract', args),
    onAutoExtractProgress: (cb) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        p: AutoExtractProgress,
      ) => cb(p);
      ipcRenderer.on('aiSummary:autoExtractProgress', listener);
      return () => {
        ipcRenderer.removeListener('aiSummary:autoExtractProgress', listener);
      };
    },
  },

  dataCollection: {
    getStats: () => ipcRenderer.invoke('dataCollection:getStats'),
    triggerNow: () => ipcRenderer.invoke('dataCollection:triggerNow'),
    pause: () => ipcRenderer.invoke('dataCollection:pause'),
    resume: () => ipcRenderer.invoke('dataCollection:resume'),
    cancelCurrent: () => ipcRenderer.invoke('dataCollection:cancelCurrent'),
    isEnabled: () => ipcRenderer.invoke('dataCollection:isEnabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('dataCollection:setEnabled', enabled),
  },

  youtubeApiKeys: {
    hasKeys: () => ipcRenderer.invoke('youtubeApiKeys:hasKeys'),
    getKeyCount: () => ipcRenderer.invoke('youtubeApiKeys:getKeyCount'),
    getKeys: () => ipcRenderer.invoke('youtubeApiKeys:getKeys'),
    setKeys: (keys) => ipcRenderer.invoke('youtubeApiKeys:setKeys', keys),
    clear: () => ipcRenderer.invoke('youtubeApiKeys:clear'),
  },

  creators: {
    list: () => ipcRenderer.invoke('creators:list'),
    add: (name, channelId) => ipcRenderer.invoke('creators:add', name, channelId),
    remove: (name) => ipcRenderer.invoke('creators:remove', name),
  },

  collectionLog: {
    read: (limit) => ipcRenderer.invoke('collectionLog:read', limit),
    openInExplorer: () => ipcRenderer.invoke('collectionLog:openInExplorer'),
    getQuotaPerKey: () => ipcRenderer.invoke('collectionLog:getQuotaPerKey'),
  },
};

contextBridge.exposeInMainWorld('api', api);

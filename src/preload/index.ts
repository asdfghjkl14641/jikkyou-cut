import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CommentAnalysisProgress,
  ExportProgress,
  FontDownloadProgress,
  GeminiAnalysisPhase,
  IpcApi,
  AiSummaryProgress,
  AutoExtractProgress,
  LiveStreamInfo,
  RecordingMetadata,
  StreamMonitorStatus,
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
  openCookiesFileDialog: () => ipcRenderer.invoke('dialog:openCookiesFile'),
  validateCookiesFile: (path) => ipcRenderer.invoke('cookiesFile:validate', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenuOpenFile: onChannel('menu:openFile'),
  onMenuOpenSettings: onChannel('menu:openSettings'),
  onMenuOpenOperations: onChannel('menu:openOperations'),
  onMenuOpenApiManagement: onChannel('menu:openApiManagement'),
  onMenuOpenMonitoredCreators: onChannel('menu:openMonitoredCreators'),

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

  twitch: {
    getClientCredentials: () => ipcRenderer.invoke('twitch:getClientCredentials'),
    setClientCredentials: (args) => ipcRenderer.invoke('twitch:setClientCredentials', args),
    clearClientCredentials: () => ipcRenderer.invoke('twitch:clearClientCredentials'),
    testCredentials: () => ipcRenderer.invoke('twitch:testCredentials'),
  },

  creatorSearch: {
    askGemini: (query) => ipcRenderer.invoke('creatorSearch:askGemini', query),
    fetchTwitchProfile: (login) => ipcRenderer.invoke('creatorSearch:fetchTwitchProfile', login),
    fetchYouTubeProfile: (args) => ipcRenderer.invoke('creatorSearch:fetchYouTubeProfile', args),
    searchAll: (args) => ipcRenderer.invoke('creatorSearch:searchAll', args),
  },

  monitoredCreators: {
    list: () => ipcRenderer.invoke('monitoredCreators:list'),
    add: (creator) => ipcRenderer.invoke('monitoredCreators:add', creator),
    remove: (args) => ipcRenderer.invoke('monitoredCreators:remove', args),
    setEnabled: (args) => ipcRenderer.invoke('monitoredCreators:setEnabled', args),
    refetchTwitch: (args) => ipcRenderer.invoke('monitoredCreators:refetchTwitch', args),
  },

  streamRecorder: {
    list: () => ipcRenderer.invoke('streamRecorder:list'),
    stop: (args) => ipcRenderer.invoke('streamRecorder:stop', args),
    delete: (args) => ipcRenderer.invoke('streamRecorder:delete', args),
    getRecordingDir: () => ipcRenderer.invoke('streamRecorder:getRecordingDir'),
    revealInFolder: (args) => ipcRenderer.invoke('streamRecorder:revealInFolder', args),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, meta: RecordingMetadata) => cb(meta);
      ipcRenderer.on('streamRecorder:progress', listener);
      return () => { ipcRenderer.removeListener('streamRecorder:progress', listener); };
    },
  },

  streamMonitor: {
    getStatus: () => ipcRenderer.invoke('streamMonitor:getStatus'),
    setEnabled: (enabled) => ipcRenderer.invoke('streamMonitor:setEnabled', enabled),
    pollNow: () => ipcRenderer.invoke('streamMonitor:pollNow'),
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, status: StreamMonitorStatus) => cb(status);
      ipcRenderer.on('streamMonitor:status', listener);
      return () => { ipcRenderer.removeListener('streamMonitor:status', listener); };
    },
    onStreamStarted: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, info: LiveStreamInfo) => cb(info);
      ipcRenderer.on('streamMonitor:started', listener);
      return () => { ipcRenderer.removeListener('streamMonitor:started', listener); };
    },
    onStreamEnded: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, args: { creatorKey: string }) => cb(args);
      ipcRenderer.on('streamMonitor:ended', listener);
      return () => { ipcRenderer.removeListener('streamMonitor:ended', listener); };
    },
  },

  gemini: {
    hasApiKey: () => ipcRenderer.invoke('gemini:hasApiKey'),
    getKeyCount: () => ipcRenderer.invoke('gemini:getKeyCount'),
    getKeys: () => ipcRenderer.invoke('gemini:getKeys'),
    setKeys: (keys) => ipcRenderer.invoke('gemini:setKeys', keys),
    clear: () => ipcRenderer.invoke('gemini:clear'),
    validateApiKey: (key) => ipcRenderer.invoke('gemini:validateApiKey', key),
    analyzeVideo: (args) => ipcRenderer.invoke('gemini:analyzeVideo', args),
    cancelAnalysis: () => ipcRenderer.invoke('gemini:cancelAnalysis'),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, phase: GeminiAnalysisPhase) =>
        cb(phase);
      ipcRenderer.on('gemini:progress', listener);
      return () => {
        ipcRenderer.removeListener('gemini:progress', listener);
      };
    },
    getKeyUsages: () => ipcRenderer.invoke('gemini:getKeyUsages'),
  },

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
    startAudioOnly: (args) => ipcRenderer.invoke('urlDownload:startAudioOnly', args),
    cancelAudio: () => ipcRenderer.invoke('urlDownload:cancelAudio'),
    onAudioProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: UrlDownloadProgress) => cb(p);
      ipcRenderer.on('urlDownload:audioProgress', listener);
      return () => ipcRenderer.removeListener('urlDownload:audioProgress', listener);
    },
    startVideoOnly: (args) => ipcRenderer.invoke('urlDownload:startVideoOnly', args),
    fetchMetadata: (args) => ipcRenderer.invoke('urlDownload:fetchMetadata', args),
    cancelVideo: () => ipcRenderer.invoke('urlDownload:cancelVideo'),
    onVideoProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: UrlDownloadProgress) => cb(p);
      ipcRenderer.on('urlDownload:videoProgress', listener);
      return () => ipcRenderer.removeListener('urlDownload:videoProgress', listener);
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
    loadGlobalPatterns: () => ipcRenderer.invoke('aiSummary:loadGlobalPatterns'),
  },

  dataCollection: {
    getStats: () => ipcRenderer.invoke('dataCollection:getStats'),
    triggerNow: () => ipcRenderer.invoke('dataCollection:triggerNow'),
    pause: () => ipcRenderer.invoke('dataCollection:pause'),
    resume: () => ipcRenderer.invoke('dataCollection:resume'),
    cancelCurrent: () => ipcRenderer.invoke('dataCollection:cancelCurrent'),
    isEnabled: () => ipcRenderer.invoke('dataCollection:isEnabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('dataCollection:setEnabled', enabled),
    estimateCreator: (args) => ipcRenderer.invoke('dataCollection:estimateCreator', args),
    listSeedCreators: () => ipcRenderer.invoke('dataCollection:listSeedCreators'),
    runPatternAnalysis: () => ipcRenderer.invoke('dataCollection:runPatternAnalysis'),
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

  recentVideos: {
    list: (maxAgeHours) => ipcRenderer.invoke('recentVideos:list', maxAgeHours),
  },

  apiKeysBackup: {
    getStatus: () => ipcRenderer.invoke('apiKeysBackup:getStatus'),
    openFolder: () => ipcRenderer.invoke('apiKeysBackup:openFolder'),
    revealFile: () => ipcRenderer.invoke('apiKeysBackup:revealFile'),
    exportToFile: () => ipcRenderer.invoke('apiKeysBackup:export'),
    importPreview: () => ipcRenderer.invoke('apiKeysBackup:importPreview'),
    importApply: (args) => ipcRenderer.invoke('apiKeysBackup:importApply', args),
  },
};

contextBridge.exposeInMainWorld('api', api);

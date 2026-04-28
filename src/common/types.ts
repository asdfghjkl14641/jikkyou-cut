import type { AppConfig } from './config';

export type TranscriptCue = {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  // Edit state — `deleted: true` means the cue (and its underlying video
  // region) is marked for removal. Persisted with the project file.
  deleted: boolean;
};

export type TranscriptionResult = {
  language: string;
  cues: TranscriptCue[];
  srtFilePath: string;
  generatedAt: number;
};

export type TranscriptionPhase = 'extracting' | 'uploading' | 'transcribing';

export type TranscriptionProgress = {
  phase: TranscriptionPhase;
  // 0..1 when known (extracting, uploading)
  ratio?: number;
  // accumulated seconds when ratio is unknown (transcribing)
  elapsedSec?: number;
};

export type TranscriptionStartArgs = {
  videoFilePath: string;
  durationSec: number;
};

export type ApiKeyValidationResult = {
  valid: boolean;
  error?: string;
};

// Distinguishes user-cancelled runs from real errors.
export const TRANSCRIPTION_CANCELLED = 'TRANSCRIPTION_CANCELLED';
export const EXPORT_CANCELLED = 'EXPORT_CANCELLED';

export type ExportRegion = {
  startSec: number;
  endSec: number;
};

export type ExportStartArgs = {
  videoFilePath: string;
  regions: ExportRegion[];
};

export type ExportProgress = {
  ratio: number; // 0..1
  elapsedSec: number;
  speed?: number;
};

export type ExportResult = {
  outputPath: string;
  sizeBytes: number;
  durationSec: number; // total kept duration
  generatedAt: number;
};

export type IpcApi = {
  // file dialogs
  openFileDialog: () => Promise<string | null>;
  getPathForFile: (file: File) => string;

  // menu events
  onMenuOpenFile: (cb: () => void) => () => void;
  onMenuOpenSettings: (cb: () => void) => () => void;

  // settings (non-secret)
  getSettings: () => Promise<AppConfig>;
  saveSettings: (partial: Partial<AppConfig>) => Promise<AppConfig>;

  // API key (secret) — raw key only crosses the boundary inbound.
  // The renderer can never read the stored key back.
  hasApiKey: () => Promise<boolean>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  validateApiKey: (key: string) => Promise<ApiKeyValidationResult>;

  // transcription
  startTranscription: (args: TranscriptionStartArgs) => Promise<TranscriptionResult>;
  cancelTranscription: () => Promise<void>;
  onTranscriptionProgress: (
    cb: (p: TranscriptionProgress) => void,
  ) => () => void;

  // project file (`<basename>.jcut.json` next to the video)
  loadProject: (videoFilePath: string) => Promise<TranscriptCue[] | null>;
  saveProject: (videoFilePath: string, cues: TranscriptCue[]) => Promise<void>;
  clearProject: (videoFilePath: string) => Promise<void>;

  // export
  startExport: (args: ExportStartArgs) => Promise<ExportResult>;
  cancelExport: () => Promise<void>;
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void;
  revealInFolder: (path: string) => Promise<void>;
};

import type { AppConfig } from './config';

export type TranscriptCue = {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
};

export type TranscriptionResult = {
  modelPath: string;
  language: string;
  cues: TranscriptCue[];
  srtFilePath: string;
  generatedAt: number;
};

export type TranscriptionProgress = {
  outTimeMicros: number;
  durationMicros: number;
  speed?: number;
};

export type TranscriptionStartArgs = {
  videoFilePath: string;
  durationSec: number;
};

// Distinguishes user-cancelled runs from real errors so the UI can suppress error banners.
export const TRANSCRIPTION_CANCELLED = 'TRANSCRIPTION_CANCELLED';

export type IpcApi = {
  openFileDialog: () => Promise<string | null>;
  openModelFileDialog: () => Promise<string | null>;
  getPathForFile: (file: File) => string;
  onMenuOpenFile: (cb: () => void) => () => void;
  onMenuOpenSettings: (cb: () => void) => () => void;

  getSettings: () => Promise<AppConfig>;
  saveSettings: (partial: Partial<AppConfig>) => Promise<AppConfig>;

  startTranscription: (args: TranscriptionStartArgs) => Promise<TranscriptionResult>;
  cancelTranscription: () => Promise<void>;
  onTranscriptionProgress: (
    cb: (p: TranscriptionProgress) => void,
  ) => () => void;
};

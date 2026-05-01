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
  // Whether this cue's text should be burned into the output video as a
  // subtitle. Defaults to `true` for new cues and for projects loaded from
  // pre-subtitle jcut.json files (back-compat). Persisted.
  showSubtitle: boolean;
  // Diarization label from the ASR (e.g. "speaker_0"). Undefined when the
  // engine produced no speaker info or only one speaker. Persisted.
  speaker?: string;
  // Optional style override for this specific cue (Phase B-3 extension point)
  styleOverride?: SpeakerStyle;
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
  // When true, request Gladia diarization (speaker separation). The
  // renderer reads this from the persisted `AppConfig.collaborationMode`
  // (mirrored into the editor store). Solo recordings should pass `false`
  // so the API skips the heavier diarization pass.
  collaborationMode: boolean;
  // Hint for Gladia diarization. `null` = auto-detect (no
  // `diarization_config` sent). `2..5` = sent as `number_of_speakers` (the
  // user knows the exact count). `6` = the "6+" bucket, sent as
  // `min_speakers: 6` (no upper bound). Ignored when `collaborationMode`
  // is false.
  expectedSpeakerCount: number | null;
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
  // Full cue list with `deleted` / `showSubtitle` flags. Required by the
  // main process to (re-)derive kept regions for subtitle timecode mapping
  // and to know which cues to render. The renderer also passes derived
  // `regions` in its own field above to keep the existing concat path
  // wire-format stable.
  cues: TranscriptCue[];
  // Intrinsic dimensions (videoWidth/Height from `<video>`) — used as
  // PlayResX/PlayResY in the generated ASS so libass scales subtitle text
  // relative to the actual video, not a hard-coded reference frame.
  videoWidth: number;
  videoHeight: number;
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

export type ProjectFile = {
  version: number;
  videoFileName: string;
  language: string;
  generatedAt: number;
  cues: TranscriptCue[];
  activePresetId?: string;
};

// ---- Subtitle types --------------------------------------------------------

export type SubtitlePosition = 'bottom' | 'top' | 'middle';

export type SubtitleShadow = {
  enabled: boolean;
  color: string; // HEX (e.g. "#000000")
  offsetPx: number; // 1..10
};

export type SpeakerStyle = {
  speakerId: string; // "speaker_0", "speaker_1", ... or "default"
  speakerName: string; // User-visible name (e.g., "みのる", "デフォルト")
  fontFamily: string; // e.g. "Noto Sans JP"
  fontSize: number; // px (default 48)
  textColor: string; // HEX
  outlineColor: string; // HEX
  outlineWidth: number; // px (1..10)
  shadow: SubtitleShadow;
  position: SubtitlePosition;
};

export type SpeakerPreset = {
  id: string; // nanoid
  name: string; // User-visible preset name
  speakerStyles: SpeakerStyle[];
  createdAt: number;
  updatedAt: number;
};

export type StylePreset = {
  id: string;            // nanoid
  name: string;          // "強調", "ささやき", "叫び", "ナレーション" 等
  style: Omit<SpeakerStyle, 'speakerId' | 'speakerName'>;  // フォント・色・縁・影・位置
};

// Deprecated: kept for migration only. Will be removed in future.
export type SubtitleStyle = {
  id: string; // nanoid
  name: string; // user-visible label
  fontFamily: string; // e.g. "Noto Sans JP" — must match an installed font family
  fontSize: number; // px (default 48)
  textColor: string; // HEX
  outlineColor: string; // HEX
  outlineWidth: number; // px (1..10)
  shadow: SubtitleShadow;
  position: SubtitlePosition;
  isBuiltin: boolean; // true → user cannot delete or fully overwrite
};

export type SubtitleSettings = {
  enabled: boolean; // master ON/OFF for the subtitle feature
  presets: SpeakerPreset[];
  activePresetId: string | null;
  stylePresets: StylePreset[]; // テンション別スタイル
  // Kept for backward compatibility during migration
  activeStyleId?: string;
  styles?: SubtitleStyle[];
};

// ---- Font management -------------------------------------------------------

export type FontSource = 'builtin' | 'google-fonts' | 'user';

export type InstalledFont = {
  family: string; // CSS family name
  filePath: string; // absolute path to the .ttf/.otf
  fileName: string; // bare filename
  source: FontSource;
};

export type AvailableFont = {
  family: string;
  category: string; // e.g. "japanese", "japanese-display"
  url: string; // canonical Google Fonts specimen URL (for documentation)
  installed: boolean;
};

export type FontDownloadStatus = 'starting' | 'done' | 'failed';

export type FontDownloadProgress = {
  family: string;
  status: FontDownloadStatus;
  error?: string;
};

export type DownloadResult = {
  succeeded: string[]; // family names that wrote a file
  failed: { family: string; error: string }[];
};

export type IpcApi = {
  // file dialogs
  openFileDialog: () => Promise<string | null>;
  getPathForFile: (file: File) => string;

  // menu events
  onMenuOpenFile: (cb: () => void) => () => void;
  onMenuOpenSettings: (cb: () => void) => () => void;
  onMenuOpenOperations: (cb: () => void) => () => void;

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
  loadProject: (videoFilePath: string) => Promise<ProjectFile | null>;
  saveProject: (videoFilePath: string, cues: TranscriptCue[], activePresetId?: string) => Promise<void>;
  clearProject: (videoFilePath: string) => Promise<void>;

  // export
  startExport: (args: ExportStartArgs) => Promise<ExportResult>;
  cancelExport: () => Promise<void>;
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void;
  revealInFolder: (path: string) => Promise<void>;

  // fonts (Phase A: subtitle font management)
  fonts: {
    listAvailable: () => Promise<AvailableFont[]>;
    listInstalled: () => Promise<InstalledFont[]>;
    download: (families: string[]) => Promise<DownloadResult>;
    remove: (family: string) => Promise<void>;
  };

  // subtitle settings (style presets + master switch)
  subtitleSettings: {
    load: () => Promise<SubtitleSettings>;
    save: (settings: SubtitleSettings) => Promise<void>;
  };

  // Per-family progress while a `fonts.download` is in flight.
  onFontDownloadProgress: (
    cb: (p: FontDownloadProgress) => void,
  ) => () => void;

  setWindowTitle: (title: string) => void;
};

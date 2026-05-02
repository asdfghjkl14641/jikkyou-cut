import type { AppConfig } from './config';
import { ReactionCategory } from './commentAnalysis/keywords';
export type { ReactionCategory } from './commentAnalysis/keywords';

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

export type UrlDownloadProgress = {
  percent: number;
  speed: string;
  eta: string;
};

// ---- Comment analysis -----------------------------------------------------

// Single chat message in unified mid-form. yt-dlp's per-platform raw shapes
// (YouTube `replayChatItemAction.*` JSONL, Twitch `comments[]` JSON) are
// converted into this so the scoring stage doesn't care which platform
// the data came from.
export type ChatMessage = {
  timeSec: number;
  text: string;
  author: string;
  platform: 'youtube' | 'twitch';
};

// Per-bucket viewer count. `count` is concurrent viewers at `timeSec`.
// playboard.co is the current data source; samples may be sparse (a few
// hundred over a 4 hour stream) so the scoring stage interpolates to the
// nearest bucket.
export type ViewerSample = { timeSec: number; count: number };

export type ViewerStats = {
  samples: ViewerSample[];
  // 'unavailable' when playboard returned nothing usable — scoring will
  // run in the 2-element (density + keyword) mode and the renderer can
  // dim the viewer-growth row in the tooltip.
  source: 'playboard' | 'unavailable';
  fetchedAt: string;
};

export type CommentAnalysisProgress = {
  phase: 'chat' | 'viewers' | 'scoring';
  percent: number;
};

export type CommentAnalysisStartArgs = {
  videoFilePath: string;
  // Source URL that the video was downloaded from. Required: chat replay
  // and viewer stats both need the original platform URL. For local-file
  // sessions (no URL) the renderer should not call analysis at all.
  sourceUrl: string;
  durationSec: number;
};

// Stage 1 output: raw per-bucket aggregates (no scoring applied yet). The
// main process produces these once per analysis run; the renderer reuses
// them to recompute `ScoreSample[]` whenever the user moves the W
// (rolling-window-size) slider — without an IPC round-trip.
export type RawBucket = {
  timeSec: number;                              // bucket start
  commentCount: number;                          // messages in this bucket
  keywordHits: number;                           // total reaction-keyword matches
  categoryHits: Record<ReactionCategory, number>;// per-category raw counts
  messages: ChatMessage[];                       // messages that fell into this bucket
  // Concurrent viewer count interpolated from playboard samples. `null`
  // when no viewer stats are available — distinct from `0` (which would
  // mean "playboard says nobody was watching" — almost never true).
  viewerCount: number | null;
};

// Stage 2 output: rolling-window score for one window-start position. One
// `ScoreSample` per bucket-start (samples slide bucket-by-bucket). Computed
// in the renderer via `computeRollingScores(buckets, windowSec, ...)`.
export type ScoreSample = {
  timeSec: number;          // window start (== bucket[i].timeSec)
  windowSec: number;        // W used to compute this sample
  // All five components are normalised 0..1.
  density: number;          // avg commentCount across W, normalised by global window-avg max
  keyword: number;          // avg keywordHits across W, normalised by global window-avg max
  continuity: number;       // fraction of buckets with commentCount >= global median
  peak: number;             // max(commentCount) in W / global max(commentCount)
  retention: number;        // min/max viewer count in W (0.5 fallback when no samples in W)
  total: number;            // weighted composite, 0..1
  dominantCategory: ReactionCategory | null;
  // Raw per-category sums across the window. Tooltip / PeakDetailPanel
  // render these directly as "笑い: 12 件" — no further normalisation.
  categoryHits: Record<ReactionCategory, number>;
  // Total messages in the window. Stored to avoid the tooltip having to
  // sum buckets on every hover.
  messageCount: number;
};


export type CommentAnalysis = {
  videoDurationSec: number;
  bucketSizeSec: number;
  // Stage 1 result: per-bucket raw aggregates. Score samples are derived
  // from these in the renderer with the user-controlled W.
  buckets: RawBucket[];
  // Pre-flattened, time-sorted list of every chat message in the video.
  // Mirrors what's in `buckets[i].messages` joined together — kept here
  // so the LiveCommentFeed can binary-search by time without re-walking
  // buckets on every currentSec tick. Same array reference as the
  // bucket entries: messages aren't duplicated, both views point at the
  // same ChatMessage objects.
  allMessages: ChatMessage[];
  // Source-of-truth flags so the UI can show "視聴者データなし" badges
  // when playboard didn't return anything, and so the renderer can
  // switch the scoring weights accordingly.
  hasViewerStats: boolean;
  chatMessageCount: number;
  generatedAt: string;
};

export type UrlDownloadArgs = {
  url: string;
  quality: string;
  outputDir: string;
};

// ---- AI summary (Anthropic Claude Haiku) ---------------------------------

export type AiSummarySegment = {
  id: string;
  startSec: number;
  endSec: number;
  messages: ChatMessage[];
};

export type AiSummaryResult = {
  segmentId: string;
  title: string | null;
  error?: string;
};

export type AiSummaryProgress = {
  done: number;
  total: number;
};

export type AiSummaryStartArgs = {
  // Discriminator for the on-disk cache file. Caller can use videoId,
  // file path basename, or any stable string.
  videoKey: string;
  segments: AiSummarySegment[];
};

// ---- Auto-extract (Stage 1 algorithm + Stage 2 AI refine + Stage 4 titles) ----

// Args for the renderer → main "go find me clips" call. Buckets cross
// the IPC boundary along with the video metadata so the main process
// can do Stage 1 (peak detection) without bouncing back to renderer
// for the rolling-score data.
export type AutoExtractStartArgs = {
  videoKey: string;
  buckets: RawBucket[];
  windowSec: number;
  hasViewerStats: boolean;
  videoDurationSec: number;
  // 3..5 typically. The orchestrator caps internally if the candidate
  // pool is smaller (you don't get a 5th segment from a video with
  // only 3 distinct peaks).
  targetCount: number;
};

// Phase 1 → 2 → 4 progress. `percent` is per-phase, not overall — the
// renderer renders it as a 3-step progress bar.
export type AutoExtractProgress = {
  phase: 'detect' | 'refine' | 'titles';
  percent: number;
};

export type AutoExtractResult = {
  // Ready-to-add segments (no `id` — caller assigns via addClipSegment).
  segments: Array<Omit<ClipSegment, 'id'>>;
  // Optional warning surface if the AI step degraded to fallback. The
  // renderer can show a toast like "AI 精査に失敗、スコア順で採用しました".
  warning?: string;
};

// One clip segment in the user's selection list. Replaces the singular
// `clipRange` — the editor now produces highlight-compilation–style
// outputs with 1..20 segments separated by eyecatches.
export type ClipSegment = {
  id: string;
  startSec: number;
  endSec: number;
  // null = the segment hasn't been titled yet (AI title generation will
  // fill these in a future task). UI shows a faint placeholder.
  title: string | null;
  // Carried from the score sample at add-time so the segment bar on the
  // waveform can be coloured even after the user drags its bounds away
  // from the original peak.
  dominantCategory: ReactionCategory | null;
};

// Auto-generated divider between consecutive clip segments. `eyecatches[i]`
// sits between `clipSegments[i]` and `clipSegments[i + 1]` — so the array
// is always exactly `max(0, clipSegments.length - 1)` long.
export type Eyecatch = {
  id: string;
  // User-editable label shown on the actual eyecatch frame later. Defaults
  // to "場面 N" but the user can rename per-divider.
  text: string;
  durationSec: number;
  // When true, the divider is rendered as a direct cut (no eyecatch frame).
  // The data slot persists so toggling back doesn't lose the text.
  skip: boolean;
};

export type IpcApi = {
  // file dialogs
  openFileDialog: () => Promise<string | null>;
  openDirectoryDialog: () => Promise<string | null>;
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

  // Anthropic API key — used by the AI segment-title summariser. Same
  // BYOK pattern as Gladia, separate slot so the user can rotate them
  // independently.
  hasAnthropicApiKey: () => Promise<boolean>;
  setAnthropicApiKey: (key: string) => Promise<void>;
  clearAnthropicApiKey: () => Promise<void>;
  validateAnthropicApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;

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

  urlDownload: {
    start: (args: UrlDownloadArgs) => Promise<{ filePath: string; title: string }>;
    cancel: () => Promise<void>;
    onProgress: (cb: (p: UrlDownloadProgress) => void) => () => void;
  };

  commentAnalysis: {
    start: (args: CommentAnalysisStartArgs) => Promise<CommentAnalysis>;
    cancel: () => Promise<void>;
    onProgress: (cb: (p: CommentAnalysisProgress) => void) => () => void;
  };

  aiSummary: {
    generate: (args: AiSummaryStartArgs) => Promise<AiSummaryResult[]>;
    cancel: () => Promise<void>;
    onProgress: (cb: (p: AiSummaryProgress) => void) => () => void;
    // 1 ボタンで Stage 1 (アルゴリズム peak 検出) → Stage 2 (AI 精査)
    // → Stage 4 (タイトル生成) を一気通貫。区間追加までやって ClipSegment
    // 形状の配列(idなし)を返す。renderer は addClipSegment ループで
    // store に流し込むだけ。
    autoExtract: (args: AutoExtractStartArgs) => Promise<AutoExtractResult>;
    onAutoExtractProgress: (cb: (p: AutoExtractProgress) => void) => () => void;
  };

  // Background data-collection pipeline (Phase 1 — accumulation only).
  // The renderer reads stats / triggers manual runs / pauses; it never
  // sees raw API keys.
  dataCollection: {
    getStats: () => Promise<{
      videoCount: number;
      creatorCount: number;
      quotaUsedToday: number;
      isRunning: boolean;
      lastCollectedAt: string | null;
    }>;
    triggerNow: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
  };
  youtubeApiKeys: {
    hasKeys: () => Promise<boolean>;
    getKeyCount: () => Promise<number>;
    setKeys: (keys: string[]) => Promise<void>;
    clear: () => Promise<void>;
  };
  creators: {
    list: () => Promise<Array<{ name: string; channelId: string | null }>>;
    add: (name: string, channelId: string | null) => Promise<void>;
    remove: (name: string) => Promise<void>;
  };
};

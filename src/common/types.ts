import type { AppConfig, MonitoredCreator } from './config';
// Re-export so renderer code that imports from common/types only
// still gets the recording types in one place.
// (declared lower in this file)
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
  // 2026-05-04 — videoFilePath is no longer used by analyzeComments
  // (chat replay + viewer stats both work from sourceUrl alone, the
  // bucket aggregation only needs durationSec). Marked optional so the
  // renderer can fire comment analysis BEFORE audio DL resolves —
  // critical for Twitch VODs where audio = full HLS length. Local-
  // file sessions can pass it as a stable identifier; URL flows can
  // omit.
  videoFilePath?: string;
  // Source URL that the video was downloaded from. Required: chat replay
  // and viewer stats both need the original platform URL. For local-file
  // sessions (no URL) the renderer should not call analysis at all.
  sourceUrl: string;
  durationSec: number;
};

// Stage 6a — store-resident lifecycle for the comment-analysis pipeline.
// Pre-stage 6a this lived as React local state inside ClipSelectView,
// which meant the analysis kicked off only after that view mounted
// (post audio-DL). Hoisting it lets App.tsx fire the IPC the moment
// the URL DL flow has its sessionId / sourceUrl / durationSec, in
// parallel with the video DL.
export type CommentAnalysisLoadStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; phase: 'chat' | 'viewers' | 'scoring' }
  | { kind: 'ready'; analysis: CommentAnalysis }
  | { kind: 'error'; message: string };

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

// Stage 2 — split URL download into two independent paths so the
// renderer can unblock UI as soon as audio is available, while the
// (much larger) video download continues in the background.
export type AudioOnlyDownloadArgs = {
  url: string;
  outputDir: string;
};

export type AudioOnlyDownloadResult = {
  audioFilePath: string;
  sessionId: string;            // see deriveSessionId() in urlDownload.ts
  durationSec: number;
  videoTitle: string;
};

export type VideoOnlyDownloadArgs = {
  url: string;
  quality: string;
  outputDir: string;
  // 2026-05-04 — Optional. When omitted, the main process derives the
  // sessionId from the URL (same logic as deriveSessionId). Lets the
  // renderer fire audio + video DLs in true parallel without waiting
  // for `startAudioOnly` to resolve first (Twitch VODs sit on a
  // multi-minute audio DL where YouTube finishes in seconds).
  sessionId?: string;
};

export type VideoOnlyDownloadResult = {
  videoFilePath: string;
  sessionId: string;
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
  // Reserved for future use. M1.5b retired the per-creator prompt
  // path in favour of a single global.json pattern feed, so these
  // fields are no longer consumed — but kept on the wire so renderer
  // callers don't need a coordinated change when they come back.
  videoTitle?: string;
  channelName?: string;
  // Stage 2 — when the renderer has a pre-extracted audio file
  // available (from the audio-first DL path), the orchestrator skips
  // its own audio extraction step and feeds this file straight into
  // Gemini. videoFilePath is only used as a fallback when audioFilePath
  // is absent (legacy / local-drop flow).
  audioFilePath?: string;
  videoFilePath?: string;
};

// Output of the renderer→main estimation IPC. Same shape as the main-
// internal CreatorEstimation; redefined here to keep main internals out
// of the cross-process wire type.
export type CreatorEstimation = {
  creatorName: string | null;
  creatorGroup: string | null;
  source: 'channel-match' | 'title-match' | 'unknown';
};

// ---- Gemini audio analysis (Task 1) --------------------------------------

export type GeminiHighlightCandidate = {
  startSec: number;
  endSec: number;
  reason: string;
  contentType: string;       // 'laugh' | 'surprise' | 'reaction' | 'narrative' | 'other'
  confidence: number;        // 0..1
};

export type GeminiTimelineSegment = {
  startSec: number;
  endSec: number;
  description: string;
};

export type GeminiAnalysisResult = {
  totalDurationSec: number;
  timelineSummary: GeminiTimelineSegment[];
  highlights: GeminiHighlightCandidate[];
  transcriptHints?: string;
};

// 4 phases. The 'extracting' phase is emitted by the IPC handler before
// it hands off to gemini.runAnalysis (which only sees uploading →
// understanding → parsing).
export type GeminiAnalysisPhase = 'extracting' | 'uploading' | 'understanding' | 'parsing';

export type GeminiAnalysisStartArgs = {
  videoFilePath: string;
  videoTitle: string;
  durationSec: number;
};

// Per-key usage snapshot for the API management UI. `keyHash` is the
// sha256 prefix of the actual key — keys themselves never cross the
// IPC boundary in this struct. `todayCount` counts successful
// generateContent calls since UTC midnight; `lastError` is the most
// recent 429/401 timestamp within the last 24 hours (null when
// healthy).
export type GeminiKeyUsage = {
  keyHash: string;
  todayCount: number;
  todayLimit: number;
  lastError: string | null;
};

// Phase 2a — output summary for the "パターン分析を実行" button. The
// detailed per-creator / per-group / global JSON shapes live in main
// and are written to disk only; only this counts-summary crosses IPC.
export type PatternAnalysisResult = {
  // 2026-05-03 M1.5b — global.json is the AI-prompt feed; the per-
  // creator / per-group JSONs are kept as residual code for future
  // Phase 2 extensions but no longer fed into the prompt directly.
  globalGenerated: boolean;
  globalAnalyzed: number;
  generatedCreators: string[];
  skippedCreators: number;
  generatedGroups: string[];
};

// Phase progress. Task 2 expanded the set from the original
// detect/refine/titles trio to include the orchestration steps that
// now run before AI refine: cache lookup, audio extraction, Gemini
// structural understanding. `percent` is per-phase. `skipped` marks
// the Gemini step when the key is missing / analysis fails — the
// modal renders that phase struck through instead of progressing.
export type AutoExtractProgress = {
  phase: 'cache-check' | 'audio-extract' | 'gemini' | 'detect' | 'refine' | 'titles';
  percent: number;
  skipped?: boolean;
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
  // Provenance for the segment. Optional so old persisted projects load
  // unchanged — undefined is treated as 'manual' at the rendering layer.
  // 'auto-extract' marks segments produced by autoExtractClipCandidates
  // and unlocks the Sparkles badge / reason tooltip in ClipSegmentsList.
  aiSource?: 'auto-extract' | 'manual';
  // Why the AI picked this segment (Stage 2 refine output). Surfaced as
  // a hover tooltip on auto-extract cards.
  aiReason?: string;
  // 0..1 confidence from the AI. Reserved for a future UI hook (M1.5+);
  // currently captured-when-available, never displayed.
  aiConfidence?: number;
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

// Result of `validateCookiesFile`. Renderer composes user-facing
// warnings from this — never the file contents (security).
export type CookiesFileValidation = {
  exists: boolean;
  sizeBytes: number;
  extension: string;
};

// 段階 X2 — live-stream snapshot mirrored to the renderer. Same shape
// for both platforms; `platform` discriminates the optional fields.
// `creatorKey` is the platform-stable id (twitchUserId / youtubeChannelId).
export type LiveStreamInfo = {
  platform: 'twitch' | 'youtube';
  creatorKey: string;
  displayName: string;
  title: string;
  startedAt: string;
  detectedAt: number;
  videoId?: string;
  streamId?: string;
  thumbnailUrl?: string;
  url: string;
};

export type StreamMonitorStatus = {
  enabled: boolean;
  isRunning: boolean;
  lastPollAt: number | null;
  nextPollAt: number | null;
  liveStreams: LiveStreamInfo[];
};

// 段階 X3+X4 — auto-record metadata mirrored to the renderer.
//
// Status lifecycle:
//   recording      : the live capture (yt-dlp / streamlink) is running
//   live-ended     : streamMonitor:ended fired, live capture closed cleanly,
//                    waiting for the platform to publish a VOD
//   vod-fetching   : VOD URL resolved, yt-dlp is downloading the archive
//   completed      : VOD captured (or VOD fallback disabled and live finished)
//   failed         : recording / VOD fetch failed; the partial files (if any)
//                    are kept so the user can inspect them
export type RecordingStatus =
  | 'recording'
  | 'live-ended'
  | 'vod-fetching'
  | 'completed'
  | 'failed';

export type RecordingMetadata = {
  // Stable across the recording lifecycle. Composed of (creatorKey,
  // startedAt) so two recordings of the same creator are
  // distinguishable.
  recordingId: string;
  platform: 'twitch' | 'youtube';
  creatorKey: string;
  displayName: string;
  title: string;
  startedAt: string; // ISO 8601
  endedAt: string | null;
  // Whichever URL streamMonitor handed us at start time. For Twitch
  // this is the channel page (live); for YouTube the watch URL.
  sourceUrl: string;
  // Files written under <recordingDir>/<platform>/<sanitised-creator>/.
  // Stored as filenames only — the absolute path is reconstructed from
  // recordingDir + the (platform, creator) folder layout.
  files: {
    live: string | null;
    vod: string | null;
  };
  fileSizeBytes: {
    live: number | null;
    vod: number | null;
  };
  // 2026-05-04 — When yt-dlp exits early but the upstream stream is
  // STILL live, the recorder respawns yt-dlp and writes to a new
  // segment file. `liveSegments` lists every segment captured (in
  // chronological order), `liveSegmentSizes` is the parallel byte
  // count, `restartCount` is the count of restarts (= segments-1).
  // For recordings that only ever had one segment these fields are
  // omitted to keep the JSON tidy and back-compat with pre-fix
  // metadata. `files.live` always points to the latest / active
  // segment so existing renderer code keeps working.
  liveSegments?: string[];
  liveSegmentSizes?: number[];
  restartCount?: number;
  status: RecordingStatus;
  // Last error message when status === 'failed'. Untouched otherwise.
  errorMessage?: string;
  // The folder the files live in (absolute path). Convenience for the
  // renderer so it doesn't reconstruct paths client-side.
  folder: string;
};

export type RecordingProgressEvent = {
  recordingId: string;
  status: RecordingStatus;
  fileSizeBytes: { live: number | null; vod: number | null };
  errorMessage?: string;
};

export type IpcApi = {
  // file dialogs
  openFileDialog: () => Promise<string | null>;
  openDirectoryDialog: () => Promise<string | null>;
  openCookiesFileDialog: () => Promise<string | null>;
  validateCookiesFile: (path: string) => Promise<CookiesFileValidation>;
  getPathForFile: (file: File) => string;

  // menu events
  onMenuOpenFile: (cb: () => void) => () => void;
  onMenuOpenSettings: (cb: () => void) => () => void;
  onMenuOpenOperations: (cb: () => void) => () => void;
  onMenuOpenApiManagement: (cb: () => void) => () => void;
  onMenuOpenMonitoredCreators: (cb: () => void) => () => void;

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

  // 段階 X1 — Twitch Helix credentials. Client ID lives in AppConfig
  // (plaintext, public info), Client Secret is DPAPI-encrypted in main
  // and never returned to the renderer. The actual user-search /
  // stream-status endpoints route through `creatorSearch` and (later
  // 段階 X2) the polling worker.
  twitch: {
    getClientCredentials: () => Promise<{ clientId: string | null; hasSecret: boolean }>;
    setClientCredentials: (args: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; error?: string }>;
    clearClientCredentials: () => Promise<void>;
    // Verifies the stored credentials by hitting the OAuth endpoint.
    // Distinct from setClientCredentials so the user can re-test
    // existing credentials without retyping the secret.
    testCredentials: () => Promise<{ ok: boolean; error?: string }>;
  };

  // 段階 X1 (revised) — name-based creator lookup for the registration
  // UI. Three steps: ask Gemini → resolve concrete profiles in
  // parallel → present cards. Each step is a separate IPC so the
  // renderer can show progress between them.
  creatorSearch: {
    askGemini: (query: string) => Promise<{
      twitch: { login: string; confidence: 'high' | 'medium' | 'low' } | null;
      youtube: {
        handle: string;
        channelName: string;
        confidence: 'high' | 'medium' | 'low';
      } | null;
    }>;
    fetchTwitchProfile: (login: string) => Promise<{
      userId: string;
      login: string;
      displayName: string;
      profileImageUrl: string;
      createdAt: string;
      followerCount: number | null;
    } | null>;
    fetchYouTubeProfile: (args: {
      handle?: string | null;
      channelId?: string | null;
    }) => Promise<{
      channelId: string;
      channelName: string;
      handle: string | null;
      profileImageUrl: string | null;
      createdAt: string;
      subscriberCount: number | null;
    } | null>;
    // 2026-05-04 — Hybrid search: Gemini primary + API fallback. One
    // call returns multi-candidate arrays per platform plus the data
    // source so the UI can show provenance ("✓ Gemini 推測" vs
    // "⚠ API 検索結果"). Replaces the renderer's prior askGemini →
    // fetchTwitch / fetchYouTube dance.
    //
    // `minFollowersOverride`: optional in-flight override for the
    // AppConfig.searchMinFollowers threshold. Used by the "lower
    // threshold for this search only" relaxation buttons; passing 0
    // disables the filter for the call without mutating the persisted
    // setting.
    searchAll: (args: { query: string; minFollowersOverride?: number | null }) => Promise<HybridSearchResult>;
  };

  // 段階 X3+X4 — auto-record CRUD + progress events. Recording itself
  // is fully main-side (yt-dlp / streamlink subprocesses); this
  // surface exists for the renderer's recordings list UI + the
  // "open in editor" handoff.
  streamRecorder: {
    list: () => Promise<RecordingMetadata[]>;
    stop: (args: { creatorKey: string }) => Promise<void>;
    delete: (args: { recordingId: string }) => Promise<void>;
    getRecordingDir: () => Promise<string>;
    revealInFolder: (args: { recordingId: string }) => Promise<void>;
    onProgress: (cb: (meta: RecordingMetadata) => void) => () => void;
  };

  // 段階 X2 — live-stream polling controls. The polling worker lives
  // in main; this surface exposes start/stop + the current live set
  // + event subscriptions for UI feedback. Heavy lifting (Helix
  // streams.list batch, YouTube RSS + videos.list?liveStreamingDetails)
  // is internal; the renderer just gets normalised LiveStreamInfo.
  streamMonitor: {
    getStatus: () => Promise<StreamMonitorStatus>;
    setEnabled: (enabled: boolean) => Promise<StreamMonitorStatus>;
    pollNow: () => Promise<StreamMonitorStatus>;
    onStatus: (cb: (status: StreamMonitorStatus) => void) => () => void;
    onStreamStarted: (cb: (info: LiveStreamInfo) => void) => () => void;
    onStreamEnded: (cb: (args: { creatorKey: string }) => void) => () => void;
  };

  // 段階 X1 (revised) — platform-agnostic monitored-creators CRUD.
  // The renderer round-trips the full list after each mutation, both
  // for simplicity and because the array stays small (realistic
  // ceiling: 50 entries).
  monitoredCreators: {
    list: () => Promise<MonitoredCreator[]>;
    add: (creator:
      | {
          platform: 'twitch';
          twitchUserId: string;
          twitchLogin: string;
          displayName: string;
          profileImageUrl: string | null;
          followerCount?: number | null;
          accountCreatedAt?: string;
        }
      | {
          platform: 'youtube';
          youtubeChannelId: string;
          youtubeHandle: string | null;
          displayName: string;
          profileImageUrl: string | null;
          subscriberCount?: number | null;
          accountCreatedAt?: string;
        }
    ) => Promise<MonitoredCreator[]>;
    remove: (args: { platform: 'twitch' | 'youtube'; key: string }) => Promise<MonitoredCreator[]>;
    setEnabled: (args: { platform: 'twitch' | 'youtube'; key: string; enabled: boolean }) => Promise<MonitoredCreator[]>;
    // 2026-05-04 fix — re-resolve a Twitch creator's user_id from
    // their stored login. Used when the helix/streams polling stops
    // returning a known-live creator: the cause is usually a stale
    // user_id (renamed account, or wrong-handle registration from
    // the X1 Gemini search). The renderer surfaces this as a "↻
    // 再取得" button per registered Twitch row.
    refetchTwitch: (args: { twitchUserId: string }) => Promise<{
      ok: boolean;
      error?: string;
      updated?: MonitoredCreator;
    }>;
  };

  // Gemini multi-key (Task 1: audio analysis). On-disk shape mirrors
  // YouTube — a single DPAPI-encrypted JSON array of keys, rotated
  // round-robin in the gemini.ts client.
  gemini: {
    hasApiKey: () => Promise<boolean>;
    getKeyCount: () => Promise<number>;
    getKeys: () => Promise<string[]>;
    setKeys: (keys: string[]) => Promise<void>;
    clear: () => Promise<void>;
    validateApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
    analyzeVideo: (args: GeminiAnalysisStartArgs) => Promise<GeminiAnalysisResult>;
    cancelAnalysis: () => Promise<void>;
    onProgress: (cb: (phase: GeminiAnalysisPhase) => void) => () => void;
    // Per-key usage for the quota panel in API management. Returned
    // in the same order as the saved keys so the UI can map index 0
    // to "キー 1", index 1 to "キー 2", etc.
    getKeyUsages: () => Promise<GeminiKeyUsage[]>;
  };

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
    // Legacy single-shot DL (video + audio together). Kept for local-
    // file flows / fallbacks until stage 5 finalises the redesign.
    start: (args: UrlDownloadArgs) => Promise<{ filePath: string; title: string }>;
    cancel: () => Promise<void>;
    onProgress: (cb: (p: UrlDownloadProgress) => void) => () => void;
    // Stage 2 audio-first path. Audio completes in tens of seconds
    // for a 10h stream, unblocking AI extract while the video DL
    // continues in the background.
    startAudioOnly: (args: AudioOnlyDownloadArgs) => Promise<AudioOnlyDownloadResult>;
    cancelAudio: () => Promise<void>;
    onAudioProgress: (cb: (p: UrlDownloadProgress) => void) => () => void;
    startVideoOnly: (args: VideoOnlyDownloadArgs) => Promise<VideoOnlyDownloadResult>;
    // 2026-05-04 — Quick (1-3s) metadata pre-fetch via yt-dlp
    // --skip-download. Lets the renderer fire comment analysis in
    // parallel with audio/video DLs (instead of waiting for audio
    // to resolve to learn durationSec).
    fetchMetadata: (args: { url: string }) => Promise<{
      durationSec: number | null;
      title: string | null;
    }>;
    cancelVideo: () => Promise<void>;
    onVideoProgress: (cb: (p: UrlDownloadProgress) => void) => () => void;
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
    // Stage 6a — preload the global pattern snapshot at URL-input time
    // so AI extract sees it cached. Returned as `unknown` to keep
    // GlobalPatterns out of common types (its shape is only meaningful
    // to the main-side analyzer / refine prompt). Renderer stores the
    // value verbatim in editorStore — it never inspects the fields.
    loadGlobalPatterns: () => Promise<unknown>;
  };

  // Background data-collection pipeline (Phase 1 — accumulation only).
  // The renderer reads stats / triggers manual runs / pauses; it never
  // sees raw API keys.
  dataCollection: {
    getStats: () => Promise<{
      videoCount: number;
      // Seed creators only (= is_target=1). Migration 001 split clip
      // uploaders out into the uploaders table — they are no longer
      // counted here.
      creatorCount: number;
      // Distinct clip-uploader channels seen in collection results.
      // Tracked separately from creators so analytics can compare
      // seeded streamers vs the long-tail of fan-made clip channels.
      uploaderCount: number;
      quotaUsedToday: number;
      isRunning: boolean;
      // Mutually exclusive with isRunning. Both false ⇒ idle (no
      // keys / not started). Used by the Settings UI to show
      // 🟢 実行中 / ⏸ 停止中 / ⚫ 未起動 separately.
      isPaused: boolean;
      // Persisted master switch — survives app restart. Distinct
      // from isRunning/isPaused (which are session-only). When
      // false, auto-start at app launch is skipped.
      isEnabled: boolean;
      // True while a batch is currently mid-flight (whether scheduled
      // or fired by triggerNow). Drives the "1 回だけ取得" button's
      // disabled state and the "取得を停止" button's enabled state.
      isBatchActive: boolean;
      // Seconds until the next scheduled batch fires. null when no
      // timer is armed (idle / paused / batch currently active).
      nextBatchAtSec: number | null;
      lastCollectedAt: string | null;
    }>;
    triggerNow: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    // Stop the in-flight batch without changing isEnabled / pause
    // state. The regular schedule keeps ticking; the next cycle still
    // fires at its scheduled time.
    cancelCurrent: () => Promise<void>;
    isEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<void>;
    // Heuristic creator detection from video metadata. M1.5a — feeds
    // the AI auto-extract refine prompt and the picker UI's initial
    // selection. Returns { source: 'unknown' } when nothing matches.
    estimateCreator: (args: {
      videoTitle: string;
      channelName?: string;
    }) => Promise<CreatorEstimation>;
    // Seed creators for the picker dialog. Sorted by group then name.
    // Auto-discovered uploaders are NOT included.
    listSeedCreators: () => Promise<Array<{ name: string; group: string | null }>>;
    // Phase 2a — synchronous (sub-second) sweep over accumulated videos
    // that emits per-creator + per-group pattern JSON files into
    // userData/patterns/. Returns a summary for the Settings UI.
    runPatternAnalysis: () => Promise<PatternAnalysisResult>;
  };
  youtubeApiKeys: {
    hasKeys: () => Promise<boolean>;
    getKeyCount: () => Promise<number>;
    // Returns the actual key list to the renderer. Deliberate
    // relaxation of the "main holds plaintext, never returns" pattern
    // — needed so the multi-key editor can show what's already saved
    // when the user enters edit mode (otherwise saving overwrites
    // existing keys with whatever was typed in this session, since
    // the editor was always seeded with empty inputs).
    // Used ONLY by ApiManagementView's YouTube edit panel.
    getKeys: () => Promise<string[]>;
    setKeys: (keys: string[]) => Promise<void>;
    clear: () => Promise<void>;
  };
  creators: {
    list: () => Promise<Array<{ name: string; channelId: string | null }>>;
    add: (name: string, channelId: string | null) => Promise<void>;
    remove: (name: string) => Promise<void>;
  };

  // Collection log viewer.
  collectionLog: {
    read: (limit?: number) => Promise<Array<{
      timestamp: string;
      level: 'info' | 'warn' | 'error';
      message: string;
    }>>;
    openInExplorer: () => Promise<void>;
    // Per-key quota for the API management dialog. Empty array for
    // keys that haven't been used today.
    getQuotaPerKey: () => Promise<Array<{ keyIndex: number; unitsUsed: number }>>;
  };

  // 2026-05-04 — Recent-videos list for the load-phase home screen.
  // Returns auto-recorded streams + URL-downloaded VODs newer than
  // `maxAgeHours`, sorted newest-first. Empty list when neither
  // source has anything inside the window.
  recentVideos: {
    list: (maxAgeHours: number) => Promise<RecentVideo[]>;
  };

  // 2026-05-04 — API key hybrid backup + manual export/import. The
  // backup lives at ~/Documents/jikkyou-cut-backup/api-keys.json so a
  // future DPAPI master-key rotation can't permanently destroy keys.
  apiKeysBackup: {
    getStatus: () => Promise<ApiKeysBackupStatus>;
    openFolder: () => Promise<void>;
    revealFile: () => Promise<void>;
    exportToFile: () => Promise<ApiKeysExportResult>;
    importPreview: () => Promise<ApiKeysImportPreview>;
    importApply: (args: { filePath: string; mode: 'merge' | 'replace' }) => Promise<ApiKeysImportApplyResult>;
  };
};

// 2026-05-04 — Recent-videos feed for the load-phase home screen.
// Unifies auto-recorded streams + URL-downloaded VODs into one
// chronological list keyed by createdAt (newest first).
export interface RecentVideo {
  source: 'recording' | 'url-download';
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  createdAt: string; // ISO 8601
  // Recording-only metadata
  platform?: 'twitch' | 'youtube';
  channelDisplayName?: string;
  title?: string;
  recordingId?: string;
  recordingStatus?: RecordingStatus;
  // URL-download-only
  sourceUrl?: string;
  // Metadata & Thumbnails (Phase 2 extension)
  thumbnailPath?: string | null;   // Local file path (file://)
  thumbnailUrl?: string | null;    // Remote URL (from yt-dlp info.json)
}

// 2026-05-04 — Hybrid creator-search response. Per-platform candidate
// arrays + data-source enum. Cards in the array appear in
// recommended-display order (highest follower / subscriber count first
// for fallback, single Gemini hit when source='gemini').
export type CreatorCandidateSource = 'gemini' | 'api-fallback' | 'none';
export interface HybridSearchResult {
  twitch: Array<{
    userId: string;
    login: string;
    displayName: string;
    profileImageUrl: string;
    createdAt: string;
    followerCount: number | null;
  }>;
  youtube: Array<{
    channelId: string;
    channelName: string;
    handle: string | null;
    profileImageUrl: string | null;
    createdAt: string;
    subscriberCount: number | null;
  }>;
  source: { twitch: CreatorCandidateSource; youtube: CreatorCandidateSource };
  filteredOut: { twitch: number; youtube: number };
  thresholdApplied: number;
}

export interface ApiKeysBackupStatus {
  filePath: string;
  exists: boolean;
  lastBackupAt: string | null;
  counts: {
    gemini: number;
    youtube: number;
    gladia: boolean;
    anthropic: boolean;
    twitchClientId: boolean;
    twitchClientSecret: boolean;
  };
}

export type ApiKeysExportResult =
  | { ok: true; filePath: string; counts: ApiKeysBackupStatus['counts'] }
  | { ok: false; canceled?: boolean; error?: string };

export interface ApiKeysImportPlan {
  gemini: { incoming: number; current: number };
  youtube: { incoming: number; current: number };
  gladia: { incoming: boolean; current: boolean };
  anthropic: { incoming: boolean; current: boolean };
  twitchClientId: { incoming: string | null; current: string | null };
  twitchClientSecret: { incoming: boolean; current: boolean };
  invalid: Array<{ slot: string; reason: string }>;
}

export type ApiKeysImportPreview =
  | { ok: true; filePath: string; plan: ApiKeysImportPlan }
  | { ok: false; canceled?: boolean; error?: string };

export type ApiKeysImportApplyResult =
  | { ok: true; applied: Array<{ slot: string; count: number }> }
  | { ok: false; error: string };

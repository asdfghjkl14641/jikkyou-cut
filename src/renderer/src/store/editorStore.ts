import { create } from 'zustand';
import type {
  CommentAnalysisLoadStatus,
  ExportProgress,
  ExportResult,
  TranscriptCue,
  TranscriptionProgress,
  TranscriptionResult,
  SubtitleSettings,
  ProjectFile,
  SpeakerStyle,
  ClipSegment,
  Eyecatch,
} from '../../../common/types';

type TranscriptionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

type ExportStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

const HISTORY_LIMIT = 100;

type EditorPhase = 'load' | 'clip-select' | 'edit' | 'api-management' | 'monitored-creators';
// Phases that the user can return TO from a swap-in screen
// (api-management / monitored-creators). We exclude those swap-in
// phases themselves so the back button collapses cycles by clearing
// previousPhase on entry.
type RestorablePhase = Exclude<EditorPhase, 'api-management' | 'monitored-creators'>;

// Maximum number of clip segments the user can stack — set well above
// the realistic 10-or-so per highlight compilation so a determined user
// won't hit it accidentally, but capped so a misbehaving drag-handler
// or auto-suggest can't blow up the list.
export const MAX_CLIP_SEGMENTS = 20;
const DEFAULT_EYECATCH_DURATION_SEC = 1.5;

type EditorState = {
  phase: EditorPhase;
  // Where the back button on the API management screen returns to.
  // null means we're not on the API management phase. Set when entering
  // 'api-management', cleared when leaving it.
  previousPhase: RestorablePhase | null;
  // Multi-segment selection — replaces the old singular `clipRange`.
  // Always paired with `eyecatches` whose length is held at
  // `max(0, clipSegments.length - 1)` (one divider per gap between
  // adjacent segments). Rendering order in the UI follows the array
  // order; reordering is via `reorderClipSegments`.
  clipSegments: ClipSegment[];
  eyecatches: Eyecatch[];
  filePath: string | null;
  fileName: string | null;
  // Source URL the video was downloaded from (yt-dlp). Null for local
  // files dropped into DropZone — comment analysis is disabled in that
  // case because it has nothing to scrape.
  sourceUrl: string | null;
  // Stage 2 — audio-first DL produces this before the video file is
  // ready. Used by aiSummary auto-extract to skip ffmpeg's audio
  // extraction step. Null for local drops + after the video DL
  // catches up (the renderer keeps it around for cache continuity
  // but the video file is preferred for playback).
  audioFilePath: string | null;
  // Stable identifier shared by audio + video DLs of the same URL.
  // Cache keys (refine cache, gemini cache) prefer this over file
  // paths so audio→video transition keeps cache hits.
  sessionId: string | null;
  // Background video DL progress (during the audio-first window).
  // 'idle' = no DL active (local drop or post-completion). 'done' is
  // a permanent state for the session.
  videoDownloadStatus: {
    status: 'idle' | 'downloading' | 'done' | 'error';
    progress: number;
    error: string | null;
  };
  durationSec: number | null;
  // Captured from `<video>.videoWidth/Height` on `loadedmetadata`. Needed
  // by export so the burned-in subtitle script can use the actual video
  // resolution as `PlayResX/PlayResY` — using a guessed 1920x1080 makes the
  // text size mismatch when the video is e.g. 1280x720 (1.5x bigger than
  // intended). null until metadata loads.
  videoWidth: number | null;
  videoHeight: number | null;
  // Live playback position. Updated ~60 Hz by VideoPlayer's rAF loop while
  // playing; updated once on seek/pause/load.
  currentSec: number;

  transcription: null | TranscriptionResult;
  cues: TranscriptCue[];
  selectedIds: Set<string>;

  // The visual cursor / range anchor. Stays put while shift-extending.
  focusedIndex: number | null;
  // The active end of the range. Equal to focusedIndex outside of shift ops.
  headIndex: number | null;

  // Undo / redo stacks of `cues` snapshots.
  past: TranscriptCue[][];
  future: TranscriptCue[][];

  transcriptionStatus: TranscriptionStatus;
  transcriptionProgress: TranscriptionProgress | null;
  transcriptionError: string | null;

  exportStatus: ExportStatus;
  exportProgress: ExportProgress | null;
  exportResult: ExportResult | null;
  exportError: string | null;

  // Preview mode: while ON, playback auto-skips deleted regions so the user
  // experiences the editor's projected output without rendering it.
  previewMode: boolean;

  // Bumped on every video seek. Components that want to react specifically
  // to "the user just seeked" (vs. ordinary playback drift) subscribe to
  // this counter — useEffect on `seekNonce` fires reliably once per seek
  // without the noise of currentSec changes during normal playback.
  seekNonce: number;

  // phase lifecycle
  setPhase: (phase: EditorPhase) => void;
  // Push current phase onto previousPhase and switch to api-management.
  // Idempotent: calling while already on api-management is a no-op.
  openApiManagement: () => void;
  // Pop previousPhase back into phase. Falls back to 'load' if there's
  // no recorded source (e.g. cold-launched into api-management which
  // we don't currently allow).
  closeApiManagement: () => void;
  // 段階 X1 — same swap-in pattern as api-management. The previous
  // editing phase (load/clip-select/edit) is preserved, and the back
  // button restores it. clip-select/edit specifically: the user's
  // current video file + segments survive untouched while they
  // register/unregister streamers.
  openMonitoredCreators: () => void;
  closeMonitoredCreators: () => void;

  // Clip-segment lifecycle. Mutations on `clipSegments` automatically
  // resize `eyecatches` to N-1, preserving slot text where possible.
  addClipSegment: (segment: Omit<ClipSegment, 'id'>) => { ok: true; id: string } | { ok: false; reason: 'limit' | 'duplicate' };
  removeClipSegment: (id: string) => void;
  updateClipSegment: (id: string, patch: Partial<Omit<ClipSegment, 'id'>>) => void;
  reorderClipSegments: (orderedIds: string[]) => void;
  clearAllSegments: () => void;
  updateEyecatch: (id: string, patch: Partial<Omit<Eyecatch, 'id'>>) => void;

  // file lifecycle
  setFile: (absPath: string) => void;
  setSourceUrl: (url: string | null) => void;
  clearFile: () => void;
  setDuration: (sec: number) => void;
  setVideoDimensions: (w: number, h: number) => void;
  setCurrentSec: (sec: number) => void;

  // Stage 2 — entry point for the audio-first URL DL flow. Transitions
  // to clip-select WITHOUT a video filePath (renderer shows the DL
  // overlay until setVideoFilePath fills it in).
  enterClipSelectFromUrl: (args: {
    audioFilePath: string;
    sessionId: string;
    sourceUrl: string;
    durationSec: number;
    fileName: string;
  }) => void;
  // Background video DL completion. Adds filePath to the existing
  // clip-select session WITHOUT resetting clipSegments / cues / etc —
  // the user may have already started picking clips off the audio.
  setVideoFilePath: (videoFilePath: string) => void;
  setVideoDownloadProgress: (progress: number) => void;
  setVideoDownloadFailure: (error: string) => void;

  // transcription lifecycle
  startTranscription: () => void;
  setTranscriptionProgress: (p: TranscriptionProgress) => void;
  succeedTranscription: (result: TranscriptionResult) => void;
  failTranscription: (msg: string) => void;
  cancelTranscription: () => void;
  resetTranscription: () => void;

  // restore from a saved project file (no history)
  restoreFromProject: (project: ProjectFile) => void;

  // selection
  selectByIndex: (index: number) => void;
  moveFocus: (delta: number) => void;
  extendSelectionTo: (index: number) => void;
  extendSelectionBy: (delta: number) => void;
  selectAll: () => void;

  // editing
  toggleDeletedOnSelection: () => void;
  resetAllDeleted: () => void;

  // undo / redo
  undo: () => void;
  redo: () => void;

  // export lifecycle
  startExportState: () => void;
  setExportProgress: (p: ExportProgress) => void;
  succeedExport: (result: ExportResult) => void;
  failExport: (msg: string) => void;
  cancelExportState: () => void;
  resetExportState: () => void;

  setPreviewMode: (on: boolean) => void;
  bumpSeekNonce: () => void;

  subtitleSettings: SubtitleSettings | null;
  loadSubtitleSettings: () => Promise<void>;
  updateSubtitleSettings: (settings: SubtitleSettings) => void;
  setActivePresetId: (presetId: string) => void;
  toggleCueSubtitle: (cueId: string) => void;
  updateCueSpeaker: (cueId: string, newSpeakerId: string | undefined) => void;
  updateCueStyleOverride: (cueId: string, style: SpeakerStyle | undefined) => void;

  // Collaboration mode (Gladia diarization toggle). Mirrors the persisted
  // `AppConfig.collaborationMode` — App.tsx hydrates on mount, the setter
  // writes both the in-memory state and the disk config so the choice
  // survives restart.
  collaborationMode: boolean;
  setCollaborationMode: (mode: boolean) => void;

  // Speaker-count hint for diarization. `null` = auto-detect, otherwise
  // 2..6 (6 is the "6+" sentinel sent as `min_speakers: 6`). Persisted via
  // `AppConfig.expectedSpeakerCount`.
  expectedSpeakerCount: number | null;
  setExpectedSpeakerCount: (count: number | null) => void;

  // View mode for cue list
  viewMode: 'linear' | 'speaker-column';
  setViewMode: (mode: 'linear' | 'speaker-column') => void;

  // Rolling-window size (seconds) for the comment-analysis graph. The
  // user picks 30..300 in 30s steps via WindowSizeSlider; the renderer
  // recomputes ScoreSample[] off the persisted RawBucket[] each time
  // this changes. Resets to the default on every fresh file load —
  // intentionally not persisted to disk (prototype scope).
  analysisWindowSec: number;
  setAnalysisWindowSec: (sec: number) => void;

  // Stage 6a — comment-analysis status promoted from ClipSelectView's
  // local state to the store. This lets App.tsx fire the IPC at URL-
  // input time (parallel with audio + video DL) instead of waiting
  // for ClipSelectView to mount + trigger a useEffect.
  commentAnalysisStatus: CommentAnalysisLoadStatus;
  setCommentAnalysisStatus: (s: CommentAnalysisLoadStatus) => void;

  // Stage 6a — global pattern snapshot, preloaded at URL-input time.
  // Stored as `unknown` because its shape is only meaningful main-side;
  // the renderer treats it as opaque cargo. autoExtract still loads
  // internally on main, so this preload is purely for "ready when you
  // click the button" cosmetic instant-feel.
  globalPatterns: unknown | null;
  setGlobalPatterns: (p: unknown | null) => void;
};

const DEFAULT_ANALYSIS_WINDOW_SEC = 120;

const basename = (absPath: string): string => {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? absPath;
};

const cloneCues = (cues: TranscriptCue[]): TranscriptCue[] =>
  cues.map((c) => ({ ...c }));

const computeRangeIds = (
  cues: TranscriptCue[],
  focused: number | null,
  head: number | null,
): Set<string> => {
  if (focused == null) return new Set<string>();
  const a = focused;
  const b = head ?? focused;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out = new Set<string>();
  for (let i = lo; i <= hi; i += 1) {
    const cue = cues[i];
    if (cue) out.add(cue.id);
  }
  return out;
};

const clampIndex = (i: number, len: number): number =>
  Math.max(0, Math.min(len - 1, i));

// Cheap unique id for clip segments / eyecatches. We don't need
// cryptographic randomness here — the id only has to be unique within
// the live array, which has at most 20 entries.
const localId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const makeEyecatch = (index: number): Eyecatch => ({
  id: localId(),
  text: `場面 ${index + 2}`,
  durationSec: DEFAULT_EYECATCH_DURATION_SEC,
  skip: false,
});

// Resize the eyecatches array to track segment count. Existing slots
// are kept positionally so the user's edits don't churn unnecessarily;
// new slots appended at the end use the default `場面 N+2` text (the
// "+2" lines up with the segment number that comes after the gap).
function syncEyecatches(
  segmentsLen: number,
  current: Eyecatch[],
): Eyecatch[] {
  const target = Math.max(0, segmentsLen - 1);
  if (current.length === target) return current;
  if (current.length > target) return current.slice(0, target);
  const next = [...current];
  for (let i = current.length; i < target; i += 1) next.push(makeEyecatch(i));
  return next;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  phase: 'load',
  previousPhase: null,
  clipSegments: [],
  eyecatches: [],
  filePath: null,
  fileName: null,
  sourceUrl: null,
  audioFilePath: null,
  sessionId: null,
  videoDownloadStatus: { status: 'idle', progress: 0, error: null },
  durationSec: null,
  videoWidth: null,
  videoHeight: null,
  currentSec: 0,

  transcription: null,
  cues: [],
  selectedIds: new Set<string>(),
  focusedIndex: null,
  headIndex: null,

  past: [],
  future: [],

  transcriptionStatus: 'idle',
  transcriptionProgress: null,
  transcriptionError: null,

  exportStatus: 'idle',
  exportProgress: null,
  exportResult: null,
  exportError: null,

  previewMode: true,

  seekNonce: 0,

  subtitleSettings: null,

  collaborationMode: false,

  expectedSpeakerCount: null,

  viewMode: 'linear',

  analysisWindowSec: DEFAULT_ANALYSIS_WINDOW_SEC,

  commentAnalysisStatus: { kind: 'idle' },
  globalPatterns: null,

  setPhase: (phase) => set({ phase }),

  openApiManagement: () => {
    const cur = get().phase;
    if (cur === 'api-management') return;
    // If we're already on another swap-in phase (monitored-creators),
    // route via that screen's back button rather than chaining swaps.
    // previousPhase only ever holds editable phases, never swap-in
    // ones — see RestorablePhase.
    if (cur === 'monitored-creators') return;
    set({ phase: 'api-management', previousPhase: cur });
  },

  closeApiManagement: () => {
    const prev = get().previousPhase;
    set({ phase: prev ?? 'load', previousPhase: null });
  },

  openMonitoredCreators: () => {
    const cur = get().phase;
    if (cur === 'monitored-creators') return;
    // Don't overwrite previousPhase if we're transitioning from
    // api-management — that's also a swap-in phase and previousPhase
    // already holds the "real" original phase to return to. We skip
    // the open call entirely in that case so navigation stays
    // predictable.
    if (cur === 'api-management') return;
    set({ phase: 'monitored-creators', previousPhase: cur });
  },

  closeMonitoredCreators: () => {
    const prev = get().previousPhase;
    set({ phase: prev ?? 'load', previousPhase: null });
  },

  addClipSegment: (segment) => {
    const { clipSegments, eyecatches } = get();
    if (clipSegments.length >= MAX_CLIP_SEGMENTS) return { ok: false, reason: 'limit' };
    // Reject exact duplicates so the "add" button on PeakDetailPanel is
    // safe to spam — the user can dismiss the warning rather than ending
    // up with a list full of identical entries.
    const dup = clipSegments.some(
      (s) => Math.abs(s.startSec - segment.startSec) < 0.01 && Math.abs(s.endSec - segment.endSec) < 0.01,
    );
    if (dup) return { ok: false, reason: 'duplicate' };
    const id = localId();
    const next = [...clipSegments, { ...segment, id }];
    next.sort((a, b) => a.startSec - b.startSec);
    set({ clipSegments: next, eyecatches: syncEyecatches(next.length, eyecatches) });
    return { ok: true, id };
  },

  removeClipSegment: (id) => {
    const { clipSegments, eyecatches } = get();
    const idx = clipSegments.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const nextSegments = clipSegments.filter((s) => s.id !== id);
    // Drop the eyecatch that used to sit "just after" the removed
    // segment. For the last segment we drop the previous gap instead
    // (there's no "after" gap to remove).
    const eyecatchKill = Math.min(idx, eyecatches.length - 1);
    const trimmedEyecatches = eyecatchKill >= 0
      ? eyecatches.filter((_, i) => i !== eyecatchKill)
      : eyecatches;
    set({
      clipSegments: nextSegments,
      eyecatches: syncEyecatches(nextSegments.length, trimmedEyecatches),
    });
  },

  updateClipSegment: (id, patch) => {
    const { clipSegments } = get();
    set({
      clipSegments: clipSegments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  },

  reorderClipSegments: (orderedIds) => {
    const { clipSegments } = get();
    const byId = new Map(clipSegments.map((s) => [s.id, s] as const));
    const next: ClipSegment[] = [];
    for (const id of orderedIds) {
      const seg = byId.get(id);
      if (seg) next.push(seg);
    }
    // Append any segment whose id wasn't in the user-provided list — defensive
    // against UI bugs that drop ids during drag-and-drop.
    for (const seg of clipSegments) if (!orderedIds.includes(seg.id)) next.push(seg);
    set({ clipSegments: next });
  },

  clearAllSegments: () => set({ clipSegments: [], eyecatches: [] }),

  updateEyecatch: (id, patch) => {
    const { eyecatches } = get();
    set({
      eyecatches: eyecatches.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  },

  setFile: (absPath) => {
    const stack = (new Error().stack ?? '').split('\n').slice(1, 4).join(' | ');
    console.log('[comment-debug:store] setFile called: absPath=', absPath, 'caller=', stack);
    set({
      phase: 'clip-select',
      filePath: absPath,
      fileName: basename(absPath),
      // Always reset sourceUrl on fresh file load. The URL DL flow
      // re-promotes it via `setSourceUrl(url)` AFTER `setFile()`, so
      // local-file drops correctly leave it null and prior session
      // URLs don't leak into subsequent local-file sessions.
      sourceUrl: null,
      // Stage 2 audio-first state stays cleared for local drops.
      // enterClipSelectFromUrl is the dedicated entry for URL flows.
      audioFilePath: null,
      sessionId: null,
      videoDownloadStatus: { status: 'idle', progress: 0, error: null },
      durationSec: null,
      videoWidth: null,
      videoHeight: null,
      currentSec: 0,
      transcription: null,
      cues: [],
      selectedIds: new Set<string>(),
      focusedIndex: null,
      headIndex: null,
      past: [],
      future: [],
      transcriptionStatus: 'idle',
      transcriptionProgress: null,
      transcriptionError: null,
      exportStatus: 'idle',
      exportProgress: null,
      exportResult: null,
      exportError: null,
      viewMode: 'linear',
      clipSegments: [],
      eyecatches: [],
      analysisWindowSec: DEFAULT_ANALYSIS_WINDOW_SEC,
      // Local drop has no URL → comment analysis won't fire. Reset to
      // 'idle' so a stale 'ready' from a previous URL session doesn't
      // leak into the mock-display path. globalPatterns is global to
      // the app so it stays cached across file swaps.
      commentAnalysisStatus: { kind: 'idle' },
    });
  },

  setSourceUrl: (url) => set({ sourceUrl: url }),

  // URL-DL audio-first entry. Mirrors setFile's reset list (cues /
  // selection / history / status) but populates audio-only fields and
  // leaves filePath null — VideoPlayer is replaced by a DL overlay
  // until setVideoFilePath fires.
  enterClipSelectFromUrl: ({ audioFilePath, sessionId, sourceUrl, durationSec, fileName }) => {
    console.log(
      '[comment-debug:store] enterClipSelectFromUrl: sessionId=', sessionId,
      'audioFilePath=', audioFilePath,
      'durationSec=', durationSec,
      'fileName=', fileName,
    );
    set({
      phase: 'clip-select',
      filePath: null,
      fileName,
      sourceUrl,
      audioFilePath,
      sessionId,
      videoDownloadStatus: { status: 'downloading', progress: 0, error: null },
      durationSec,
      videoWidth: null,
      videoHeight: null,
      currentSec: 0,
      transcription: null,
      cues: [],
      selectedIds: new Set<string>(),
      focusedIndex: null,
      headIndex: null,
      past: [],
      future: [],
      transcriptionStatus: 'idle',
      transcriptionProgress: null,
      transcriptionError: null,
      exportStatus: 'idle',
      exportProgress: null,
      exportResult: null,
      exportError: null,
      viewMode: 'linear',
      clipSegments: [],
      eyecatches: [],
      analysisWindowSec: DEFAULT_ANALYSIS_WINDOW_SEC,
      // Stage 6a — App.tsx will flip this to 'loading' immediately
      // after this action returns. Pre-set 'idle' so any stale
      // 'ready'/'error' from a previous session doesn't bleed into
      // ClipSelectView's first render.
      commentAnalysisStatus: { kind: 'idle' },
    });
  },

  setVideoFilePath: (videoFilePath) =>
    set({
      filePath: videoFilePath,
      // Update displayed filename to the actual video file (yt-dlp's
      // %(title)s.%(ext)s template). Audio session keeps its name in
      // the audioFilePath but the user-facing label tracks the video.
      fileName: basename(videoFilePath),
      videoDownloadStatus: { status: 'done', progress: 1, error: null },
    }),

  setVideoDownloadProgress: (progress) =>
    set((s) => ({
      videoDownloadStatus: {
        // Progress events arriving after completion are no-ops — never
        // regress 'done' back to 'downloading'.
        status: s.videoDownloadStatus.status === 'done' ? 'done' : 'downloading',
        progress,
        error: null,
      },
    })),

  setVideoDownloadFailure: (error) =>
    set({
      videoDownloadStatus: { status: 'error', progress: 0, error },
    }),

  clearFile: () => {
    const stack = (new Error().stack ?? '').split('\n').slice(1, 4).join(' | ');
    console.log('[comment-debug:store] clearFile called: caller=', stack);
    set({
      phase: 'load',
      filePath: null,
      fileName: null,
      sourceUrl: null,
      audioFilePath: null,
      sessionId: null,
      videoDownloadStatus: { status: 'idle', progress: 0, error: null },
      durationSec: null,
      commentAnalysisStatus: { kind: 'idle' },
      videoWidth: null,
      videoHeight: null,
      currentSec: 0,
      transcription: null,
      cues: [],
      selectedIds: new Set<string>(),
      focusedIndex: null,
      headIndex: null,
      past: [],
      future: [],
      transcriptionStatus: 'idle',
      transcriptionProgress: null,
      transcriptionError: null,
      exportStatus: 'idle',
      exportProgress: null,
      exportResult: null,
      exportError: null,
      viewMode: 'linear',
      clipSegments: [],
      eyecatches: [],
      analysisWindowSec: DEFAULT_ANALYSIS_WINDOW_SEC,
    });
  },


  setDuration: (sec) => {
    // Two-tier guard:
    //   (1) reject 0 / NaN — early-buffering values from <video> /
    //       embed `getDuration()` would otherwise clobber a valid
    //       duration and collapse ClipSelectView's comment-analysis
    //       gate (`durationSec <= 0`), silently cancelling chat replay.
    //   (2) skip when an existing valid duration is within 5s of the
    //       new value. Audio probe gives sub-second precision (5740.18s);
    //       the embed player polling later returns the integer-rounded
    //       version (5741s). Both are correct, but accepting the second
    //       triggers a useEffect re-run that tears down the in-flight
    //       chat fetch — leading to the 2026-05-03 WinError-32 cascade.
    const stack = (new Error().stack ?? '').split('\n').slice(1, 6).join(' | ');
    const current = get().durationSec;
    const finite = Number.isFinite(sec) && sec > 0;
    const drifted = finite && current != null && current > 0 && Math.abs(current - sec) < 5;
    console.log(
      `[comment-debug:store] setDuration called: sec=${sec}, current=${current}, accept=${
        finite && !drifted
      } (finite=${finite}, drifted=${drifted})`,
    );
    console.log('[comment-debug:store] setDuration caller:', stack);
    if (!finite) return;
    if (drifted) return;
    set({ durationSec: sec });
  },

  setVideoDimensions: (w, h) => {
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      set({ videoWidth: Math.round(w), videoHeight: Math.round(h) });
    }
  },

  setCurrentSec: (sec) => {
    if (Number.isFinite(sec)) set({ currentSec: sec });
  },

  startTranscription: () =>
    set({
      transcriptionStatus: 'running',
      transcriptionProgress: null,
      transcriptionError: null,
      transcription: null,
      cues: [],
      selectedIds: new Set<string>(),
      focusedIndex: null,
      headIndex: null,
      past: [],
      future: [],
    }),

  setTranscriptionProgress: (p) => set({ transcriptionProgress: p }),

  succeedTranscription: (result) => {
    const cues = cloneCues(result.cues);
    const initialFocus = cues.length > 0 ? 0 : null;
    set({
      transcription: result,
      transcriptionStatus: 'success',
      transcriptionProgress: null,
      cues,
      selectedIds: cues[0]
        ? new Set<string>([cues[0].id])
        : new Set<string>(),
      focusedIndex: initialFocus,
      headIndex: initialFocus,
      past: [],
      future: [],
    });
  },

  failTranscription: (msg) =>
    set({
      transcriptionStatus: 'error',
      transcriptionError: msg,
      transcriptionProgress: null,
    }),

  cancelTranscription: () =>
    set({
      transcriptionStatus: 'cancelled',
      transcriptionProgress: null,
    }),

  resetTranscription: () =>
    set({
      transcription: null,
      transcriptionStatus: 'idle',
      transcriptionProgress: null,
      transcriptionError: null,
      cues: [],
      selectedIds: new Set<string>(),
      focusedIndex: null,
      headIndex: null,
      past: [],
      future: [],
    }),

  restoreFromProject: (incoming) => {
    const cues = cloneCues(incoming.cues);
    const initialFocus = cues.length > 0 ? 0 : null;
    
    // Update active preset if the project specified one
    const { subtitleSettings } = get();
    if (incoming.activePresetId && subtitleSettings) {
      // Check if the preset actually exists before setting it
      const presetExists = subtitleSettings.presets.some(p => p.id === incoming.activePresetId);
      if (presetExists) {
        set({
          subtitleSettings: {
            ...subtitleSettings,
            activePresetId: incoming.activePresetId,
          }
        });
      }
    }
    
    set({
      cues,
      selectedIds: cues[0]
        ? new Set<string>([cues[0].id])
        : new Set<string>(),
      focusedIndex: initialFocus,
      headIndex: initialFocus,
      // Loading from a saved project does not produce undoable history.
      past: [],
      future: [],
      // Mark the transcription as "success" so the UI shows the list rather
      // than the empty-state message.
      transcriptionStatus: 'success',
    });
  },

  selectByIndex: (index) => {
    const { cues } = get();
    if (index < 0 || index >= cues.length) return;
    const cue = cues[index];
    if (!cue) return;
    set({
      focusedIndex: index,
      headIndex: index,
      selectedIds: new Set<string>([cue.id]),
    });
  },

  moveFocus: (delta) => {
    const { cues, focusedIndex } = get();
    if (cues.length === 0) return;
    const base = focusedIndex ?? -1;
    const next = clampIndex(base + delta, cues.length);
    const cue = cues[next];
    if (!cue) return;
    set({
      focusedIndex: next,
      headIndex: next,
      selectedIds: new Set<string>([cue.id]),
    });
  },

  extendSelectionTo: (index) => {
    const { cues, focusedIndex } = get();
    if (cues.length === 0) return;
    const head = clampIndex(index, cues.length);
    const anchor = focusedIndex ?? head;
    set({
      focusedIndex: anchor,
      headIndex: head,
      selectedIds: computeRangeIds(cues, anchor, head),
    });
  },

  extendSelectionBy: (delta) => {
    const { cues, focusedIndex, headIndex } = get();
    if (cues.length === 0) return;
    const anchor = focusedIndex ?? 0;
    const currentHead = headIndex ?? anchor;
    const nextHead = clampIndex(currentHead + delta, cues.length);
    set({
      focusedIndex: anchor,
      headIndex: nextHead,
      selectedIds: computeRangeIds(cues, anchor, nextHead),
    });
  },

  selectAll: () => {
    const { cues } = get();
    if (cues.length === 0) return;
    const ids = new Set<string>();
    for (const c of cues) ids.add(c.id);
    set({
      focusedIndex: 0,
      headIndex: cues.length - 1,
      selectedIds: ids,
    });
  },

  toggleDeletedOnSelection: () => {
    const { cues, selectedIds, past } = get();
    if (selectedIds.size === 0) return;

    let allDeleted = true;
    for (const cue of cues) {
      if (selectedIds.has(cue.id) && !cue.deleted) {
        allDeleted = false;
        break;
      }
    }
    const nextDeleted = !allDeleted;

    const snapshot = cloneCues(cues);
    const nextCues = cues.map((c) =>
      selectedIds.has(c.id) ? { ...c, deleted: nextDeleted } : c,
    );

    const nextPast = [...past, snapshot];
    if (nextPast.length > HISTORY_LIMIT) nextPast.shift();

    set({
      cues: nextCues,
      past: nextPast,
      future: [],
    });
  },

  resetAllDeleted: () => {
    const { cues, past } = get();
    if (cues.every((c) => !c.deleted)) return;
    const snapshot = cloneCues(cues);
    const nextPast = [...past, snapshot];
    if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
    set({
      cues: cues.map((c) => (c.deleted ? { ...c, deleted: false } : c)),
      past: nextPast,
      future: [],
    });
  },

  undo: () => {
    const { past, future, cues } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({
      cues: prev,
      past: past.slice(0, -1),
      future: [...future, cues],
    });
  },

  redo: () => {
    const { past, future, cues } = get();
    const next = future[future.length - 1];
    if (!next) return;
    set({
      cues: next,
      past: [...past, cues],
      future: future.slice(0, -1),
    });
  },

  startExportState: () =>
    set({
      exportStatus: 'running',
      exportProgress: null,
      exportResult: null,
      exportError: null,
    }),

  setExportProgress: (p) => set({ exportProgress: p }),

  succeedExport: (result) =>
    set({
      exportStatus: 'success',
      exportResult: result,
      exportProgress: null,
    }),

  failExport: (msg) =>
    set({
      exportStatus: 'error',
      exportError: msg,
      exportProgress: null,
    }),

  cancelExportState: () =>
    set({
      exportStatus: 'cancelled',
      exportProgress: null,
    }),

  resetExportState: () =>
    set({
      exportStatus: 'idle',
      exportProgress: null,
      exportResult: null,
      exportError: null,
    }),

  setPreviewMode: (on) => set({ previewMode: on }),

  bumpSeekNonce: () => set((s) => ({ seekNonce: s.seekNonce + 1 })),

  loadSubtitleSettings: async () => {
    try {
      const settings = await window.api.subtitleSettings.load();
      set({ subtitleSettings: settings });
    } catch (err) {
      console.warn('[subtitleSettings] load failed:', err);
    }
  },

  updateSubtitleSettings: (settings) => {
    set({ subtitleSettings: settings });
    window.api.subtitleSettings.save(settings).catch((err) => {
      console.warn('[subtitleSettings] save failed:', err);
    });
  },

  setActivePresetId: (presetId) => {
    const { subtitleSettings } = get();
    if (!subtitleSettings) return;
    const nextSettings = { ...subtitleSettings, activePresetId: presetId };
    set({ subtitleSettings: nextSettings });
    window.api.subtitleSettings.save(nextSettings).catch((err) => {
      console.warn('[subtitleSettings] save failed:', err);
    });
  },

  toggleCueSubtitle: (cueId) => {
    const { cues, past } = get();
    const snapshot = cloneCues(cues);
    const nextCues = cues.map((c) =>
      c.id === cueId ? { ...c, showSubtitle: !c.showSubtitle } : c,
    );
    const nextPast = [...past, snapshot];
    if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
    set({
      cues: nextCues,
      past: nextPast,
      future: [],
    });
  },

  updateCueSpeaker: (cueId, newSpeakerId) => {
    const { cues, past } = get();
    const snapshot = cloneCues(cues);
    const nextCues = cues.map((c) =>
      c.id === cueId ? { ...c, speaker: newSpeakerId } : c,
    );
    const nextPast = [...past, snapshot];
    if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
    set({
      cues: nextCues,
      past: nextPast,
      future: [],
    });
  },

  updateCueStyleOverride: (cueId, style) => {
    const { cues, past } = get();
    const snapshot = cloneCues(cues);
    const nextCues = cues.map((c) => {
      if (c.id !== cueId) return c;
      const copy = { ...c };
      if (style) {
        copy.styleOverride = { ...style };
      } else {
        delete copy.styleOverride;
      }
      return copy;
    });
    const nextPast = [...past, snapshot];
    if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
    set({
      cues: nextCues,
      past: nextPast,
      future: [],
    });
  },

  setCollaborationMode: (mode) => {
    set({ collaborationMode: mode });
    // Fire-and-forget persistence. The user just clicked the toggle, so
    // the in-memory state should always reflect the latest click even if
    // the disk write fails — log and move on rather than rolling back.
    window.api
      .saveSettings({ collaborationMode: mode })
      .catch((err) => {
        console.warn('[settings] failed to persist collaborationMode:', err);
      });
  },

  setExpectedSpeakerCount: (count) => {
    set({ expectedSpeakerCount: count });
    // Same fire-and-forget pattern as setCollaborationMode. `null`
    // (auto-detect) is a meaningful value here, so we pass it through
    // verbatim — saveSettings discriminates on `=== undefined`, not
    // `!= null`.
    window.api
      .saveSettings({ expectedSpeakerCount: count })
      .catch((err) => {
        console.warn('[settings] failed to persist expectedSpeakerCount:', err);
      });
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  setAnalysisWindowSec: (sec) => {
    if (!Number.isFinite(sec)) return;
    // Clamp to the slider's documented domain so a stray external caller
    // can't push the value outside the UI's reach.
    const clamped = Math.max(30, Math.min(300, Math.round(sec)));
    set({ analysisWindowSec: clamped });
  },

  setCommentAnalysisStatus: (s) => {
    const cur = get().commentAnalysisStatus;
    const stack = (new Error().stack ?? '').split('\n').slice(1, 4).join(' | ');
    const detail =
      s.kind === 'ready'
        ? `messageCount=${s.analysis.allMessages.length}`
        : s.kind === 'error'
          ? `error=${s.message}`
          : '';
    console.log(
      `[comment-debug:store] setCommentAnalysisStatus: ${cur.kind} -> ${s.kind} ${detail} | sessionId=${get().sessionId} | caller=${stack}`,
    );
    set({ commentAnalysisStatus: s });
  },
  setGlobalPatterns: (p) => set({ globalPatterns: p }),
}));

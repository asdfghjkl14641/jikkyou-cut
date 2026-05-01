import { create } from 'zustand';
import type {
  ExportProgress,
  ExportResult,
  TranscriptCue,
  TranscriptionProgress,
  TranscriptionResult,
  SubtitleSettings,
  ProjectFile,
  SpeakerStyle,
} from '../../../common/types';

type TranscriptionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

type ExportStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

const HISTORY_LIMIT = 100;

type EditorState = {
  filePath: string | null;
  fileName: string | null;
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

  transcription: TranscriptionResult | null;
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

  // file lifecycle
  setFile: (absPath: string) => void;
  clearFile: () => void;
  setDuration: (sec: number) => void;
  setVideoDimensions: (w: number, h: number) => void;
  setCurrentSec: (sec: number) => void;

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
};

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

export const useEditorStore = create<EditorState>((set, get) => ({
  filePath: null,
  fileName: null,
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

  setFile: (absPath) =>
    set({
      filePath: absPath,
      fileName: basename(absPath),
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
    }),

  clearFile: () =>
    set({
      filePath: null,
      fileName: null,
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
    }),

  setDuration: (sec) => set({ durationSec: sec }),

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
}));

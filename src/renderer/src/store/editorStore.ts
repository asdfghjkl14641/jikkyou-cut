import { create } from 'zustand';
import type {
  TranscriptCue,
  TranscriptionProgress,
  TranscriptionResult,
} from '../../../common/types';

type TranscriptionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

const HISTORY_LIMIT = 100;

type EditorState = {
  filePath: string | null;
  fileName: string | null;
  durationSec: number | null;

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

  // file lifecycle
  setFile: (absPath: string) => void;
  clearFile: () => void;
  setDuration: (sec: number) => void;

  // transcription lifecycle
  startTranscription: () => void;
  setTranscriptionProgress: (p: TranscriptionProgress) => void;
  succeedTranscription: (result: TranscriptionResult) => void;
  failTranscription: (msg: string) => void;
  cancelTranscription: () => void;
  resetTranscription: () => void;

  // restore from a saved project file (no history)
  restoreFromProject: (cues: TranscriptCue[]) => void;

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

  setFile: (absPath) =>
    set({
      filePath: absPath,
      fileName: basename(absPath),
      durationSec: null,
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
    }),

  clearFile: () =>
    set({
      filePath: null,
      fileName: null,
      durationSec: null,
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
    }),

  setDuration: (sec) => set({ durationSec: sec }),

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
    const cues = cloneCues(incoming);
    const initialFocus = cues.length > 0 ? 0 : null;
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
}));

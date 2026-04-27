import { create } from 'zustand';
import type {
  TranscriptionProgress,
  TranscriptionResult,
} from '../../../common/types';

type TranscriptionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

type EditorState = {
  filePath: string | null;
  fileName: string | null;
  durationSec: number | null;

  transcription: TranscriptionResult | null;
  transcriptionStatus: TranscriptionStatus;
  transcriptionProgress: TranscriptionProgress | null;
  transcriptionError: string | null;

  setFile: (absPath: string) => void;
  clearFile: () => void;
  setDuration: (sec: number) => void;

  startTranscription: () => void;
  setTranscriptionProgress: (p: TranscriptionProgress) => void;
  succeedTranscription: (result: TranscriptionResult) => void;
  failTranscription: (msg: string) => void;
  cancelTranscription: () => void;
  resetTranscription: () => void;
};

const basename = (absPath: string): string => {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? absPath;
};

export const useEditorStore = create<EditorState>((set) => ({
  filePath: null,
  fileName: null,
  durationSec: null,

  transcription: null,
  transcriptionStatus: 'idle',
  transcriptionProgress: null,
  transcriptionError: null,

  setFile: (absPath) =>
    set({
      filePath: absPath,
      fileName: basename(absPath),
      durationSec: null,
      transcription: null,
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
    }),

  setTranscriptionProgress: (p) => set({ transcriptionProgress: p }),

  succeedTranscription: (result) =>
    set({
      transcription: result,
      transcriptionStatus: 'success',
      transcriptionProgress: null,
    }),

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
    }),
}));

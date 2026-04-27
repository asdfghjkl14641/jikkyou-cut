import { create } from 'zustand';

type EditorState = {
  filePath: string | null;
  fileName: string | null;
  setFile: (absPath: string) => void;
  clearFile: () => void;
};

const basename = (absPath: string): string => {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? absPath;
};

export const useEditorStore = create<EditorState>((set) => ({
  filePath: null,
  fileName: null,
  setFile: (absPath) => set({ filePath: absPath, fileName: basename(absPath) }),
  clearFile: () => set({ filePath: null, fileName: null }),
}));

export type IpcApi = {
  openFileDialog: () => Promise<string | null>;
  getPathForFile: (file: File) => string;
  onMenuOpenFile: (cb: () => void) => () => void;
};

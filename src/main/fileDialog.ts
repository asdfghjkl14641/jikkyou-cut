import { dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function openVideoFileDialog(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: '動画ファイルを開く',
    properties: ['openFile'],
    filters: [
      { name: '動画', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ts', 'm2ts'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

export async function openDirectoryDialog(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: 'ダウンロード保存先フォルダを選択',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

// Lightweight, non-blocking validation for a user-selected cookies.txt
// path. Returns structured info so the renderer can decide whether to
// alert / warn / proceed; we deliberately don't reject the path here
// because the user might point at a file they're about to create or
// have on a removable drive that's currently unmounted.
//
// Security: NEVER read or transmit file contents. Path + size + ext
// are all the renderer needs to compose the warning text.
export type CookiesFileValidation = {
  exists: boolean;
  // Bytes. 0 when missing or empty. Empty file is reported as
  // exists=true + sizeBytes=0 so the renderer can warn specifically
  // about that case.
  sizeBytes: number;
  // Lowercased, no leading dot. '' for paths without an extension.
  extension: string;
};

export async function validateCookiesFile(absPath: string): Promise<CookiesFileValidation> {
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) {
      // Directory or device — same UX as missing file.
      return { exists: false, sizeBytes: 0, extension: '' };
    }
    return {
      exists: true,
      sizeBytes: st.size,
      extension: path.extname(absPath).replace(/^\./, '').toLowerCase(),
    };
  } catch {
    return { exists: false, sizeBytes: 0, extension: '' };
  }
}

// Picker for the Netscape-format cookies.txt file used by yt-dlp's
// --cookies arg. Filter is .txt because the de-facto export format
// (Get cookies.txt LOCALLY etc.) writes that extension; "all files"
// is kept as a fallback because some exporters use .cookies or
// no extension at all.
export async function openCookiesFileDialog(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: 'クッキーファイル(cookies.txt)を選択',
    properties: ['openFile'],
    filters: [
      { name: 'クッキーファイル', extensions: ['txt'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

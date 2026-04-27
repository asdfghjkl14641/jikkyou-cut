import { dialog, type BrowserWindow } from 'electron';

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

export async function openModelFileDialog(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: 'Whisperモデルファイルを選択',
    properties: ['openFile'],
    filters: [
      { name: 'Whisperモデル (.bin)', extensions: ['bin'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

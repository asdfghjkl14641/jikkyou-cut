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

export async function openDirectoryDialog(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: 'ダウンロード保存先フォルダを選択',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

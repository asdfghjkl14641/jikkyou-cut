import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, ChildProcess } from 'child_process';
import type { UrlDownloadProgress } from '../common/types';

let currentProcess: ChildProcess | null = null;

function getYtDlpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'yt-dlp', 'yt-dlp.exe');
  } else {
    return path.join(app.getAppPath(), 'resources', 'yt-dlp', 'yt-dlp.exe');
  }
}

export async function downloadVideo(args: {
  url: string;
  quality: string;
  outputDir: string;
  onProgress: (progress: UrlDownloadProgress) => void;
}): Promise<{ filePath: string; title: string }> {
  // 画質に応じた format selector
  const formatMap: Record<string, string> = {
    'best': 'bestvideo+bestaudio/best',
    '2160': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
    '1440': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
    '1080': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
    'worst': 'worst',
  };
  
  const format = (formatMap[args.quality] || formatMap['best']) as string;
  
  // Ensure outputDir exists
  await fs.mkdir(args.outputDir, { recursive: true });

  // Use %(title)s.%(ext)s but restrict filenames to be safe.
  const template = '%(title)s.%(ext)s';
  const outputTemplate = `${args.outputDir}${path.sep}${template}`;

  const process: any = spawn(getYtDlpPath(), [
    args.url,
    '-f', format,
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--print', 'after_move:filepath', // To get the final file path
    '--print', 'title',               // To get the title
  ]);
  currentProcess = process;
  
  let outputFilePath: string | null = null;
  let videoTitle: string | null = null;
  
  process.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      // 進捗パース: "[download]  45.3% of 100.00MiB at 5.20MiB/s ETA 00:10"
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/);
      if (progressMatch && progressMatch[1] && progressMatch[2] && progressMatch[3]) {
        args.onProgress({
          percent: parseFloat(progressMatch[1]),
          speed: progressMatch[2],
          eta: progressMatch[3],
        });
        continue;
      }

      // If it's the title or filepath (printed at the end)
      if (!line.startsWith('[')) {
        if (!videoTitle) {
          videoTitle = line.trim();
        } else {
          outputFilePath = line.trim();
        }
      }
      
      // Fallback: check if it's already downloaded
      const alreadyDownloadedMatch = line.match(/\[download\]\s+(.+) has already been downloaded/);
      if (alreadyDownloadedMatch && alreadyDownloadedMatch[1]) {
        outputFilePath = alreadyDownloadedMatch[1];
      }

      // Fallback: Merger output
      const mergerMatch = line.match(/\[Merger\]\s+Merging formats into "(.+)"/);
      if (mergerMatch && mergerMatch[1]) {
        outputFilePath = mergerMatch[1];
      }
    }
  });
  
  process.stderr.on('data', (data: Buffer) => {
    console.warn('[yt-dlp stderr]', data.toString());
  });
  
  return new Promise((resolve, reject) => {
    process.on('exit', (code: number | null) => {
      currentProcess = null;
      if (code === 0 && outputFilePath) {
        resolve({ filePath: outputFilePath, title: videoTitle || path.basename(outputFilePath) });
      } else if (code === 0 && !outputFilePath) {
        reject(new Error('Download finished but output file path was not captured.'));
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    process.on('error', (err: Error) => {
      currentProcess = null;
      reject(err);
    });
  });
}

export async function cancelDownload(): Promise<void> {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}

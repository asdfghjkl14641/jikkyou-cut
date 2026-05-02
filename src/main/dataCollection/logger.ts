import { app } from 'electron';
import path from 'node:path';
import { promises as fs, mkdirSync } from 'node:fs';

// Append-only structured log for the Phase 1 data-collection pipeline.
// Format on disk:
//
//   2026-05-02T12:34:56.789Z [INFO]  batch start
//   2026-05-02T12:35:15.123Z [WARN]  yt-dlp failed: video unavailable (videoId=abc123)
//   2026-05-02T12:35:30.456Z [ERROR] API quota exceeded for key 3
//
// ISO 8601 UTC timestamp + bracketed level + plain message. Parsed by
// logReader.ts on the GUI side. Each log call also echoes to console
// so the dev terminal still shows everything in real time.
//
// File: userData/data-collection/collection.log. Appended to forever
// — rotation isn't in Phase 1 scope. At 100 lines per video × 10K
// videos that's ~100MB worst case, which is acceptable.

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const logFilePath = (): string =>
  path.join(app.getPath('userData'), 'data-collection', 'collection.log');

// Pre-create the directory once at module import time so the first
// write doesn't race with parallel logger calls. mkdirSync is fine
// here — single execution path on import, not in the hot loop.
try {
  mkdirSync(path.dirname(logFilePath()), { recursive: true });
} catch {
  // We'll surface any actual write failures via the catch in writeLine.
}

// Coalesce concurrent appends through a sequential promise chain.
// Otherwise interleaved fs.appendFile calls can produce torn lines on
// Windows when multiple log calls fire from concurrent yt-dlp/API
// callbacks within a single tick.
let writeQueue: Promise<void> = Promise.resolve();

function writeLine(line: string): void {
  writeQueue = writeQueue
    .then(() => fs.appendFile(logFilePath(), line + '\n', 'utf8'))
    .catch((err) => {
      // We do NOT log via the logger here — that would loop. Use stderr
      // directly so the user can at least see disk failures in the dev
      // terminal.
      console.error('[data-collection-log] failed to write log line:', err);
    });
}

function format(level: LogLevel, message: string): string {
  const ts = new Date().toISOString();
  // Pad INFO to match WARN/ERROR widths so columns stay aligned in a
  // fixed-pitch view.
  const tag = `[${level}]`.padEnd(7);
  return `${ts} ${tag} ${message}`;
}

export function logInfo(message: string): void {
  const line = format('INFO', message);
  console.log(`[data-collection] ${message}`);
  writeLine(line);
}

export function logWarn(message: string): void {
  const line = format('WARN', message);
  console.warn(`[data-collection] ${message}`);
  writeLine(line);
}

export function logError(message: string): void {
  const line = format('ERROR', message);
  console.error(`[data-collection] ${message}`);
  writeLine(line);
}

export const collectionLogPath = logFilePath;

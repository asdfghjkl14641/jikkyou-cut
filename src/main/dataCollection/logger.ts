import { app } from 'electron';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

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

// Synchronous append. The previous chained-promise design (2026-05-02
// pre-fix) deadlocked when a single fs.appendFile call never settled
// — typical Windows trigger is AV / OneDrive / Search indexer holding
// a transient exclusive lock. With the chain, one stuck head froze
// every subsequent write while the rest of the orchestrator (DB
// inserts via better-sqlite3, also sync) kept running, leaving the
// log file at 13:06Z while the DB grew at 16-26 videos/min.
//
// appendFileSync opens-writes-closes per call, atomically for a single
// line. No queue head to stall, no torn lines, and the per-call cost
// (~50-200µs) is dwarfed by the surrounding yt-dlp / API I/O. The
// event-loop block isn't a regression — better-sqlite3 already runs
// sync on the same loop.
function writeLine(line: string): void {
  try {
    appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch (err) {
    // Don't loop through the logger; stderr is enough for the dev
    // terminal. Don't re-throw — a log failure must not crash the
    // collection pipeline.
    console.error('[data-collection-log] failed to write log line:', err);
  }
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

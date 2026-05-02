import { promises as fs, existsSync } from 'node:fs';
import { collectionLogPath } from './logger';

// Reader / parser for the collection.log file. Used by the
// CollectionLogViewer panel via IPC. Returns the most recent N lines
// in chronological order (oldest first within the returned slice).

export type LogEntry = {
  timestamp: string;            // ISO 8601, copied verbatim
  level: 'info' | 'warn' | 'error';
  message: string;
};

// Matches both the canonical format we write now AND the older
// `[data-collection] ...` console-style lines that may exist in
// already-grown log files. The migration path is: old entries get
// classified as INFO with the timestamp-less prefix as the message.
const CANONICAL_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\[(INFO|WARN|ERROR)\]\s+(.*)$/;

function parseLine(line: string): LogEntry | null {
  if (!line) return null;
  const m = CANONICAL_RE.exec(line);
  if (m) {
    const level = m[2]!.toLowerCase() as LogEntry['level'];
    return {
      timestamp: m[1]!,
      level,
      message: m[3]!,
    };
  }
  // Fallback for legacy lines (e.g. a developer ran the dev build
  // before this format was introduced). We don't have a real
  // timestamp; treat the whole line as an INFO message dated now.
  // The viewer will sort these to the top, which is fine for legacy
  // bulk.
  return {
    timestamp: '',
    level: 'info',
    message: line,
  };
}

/**
 * Read the most recent `limit` lines from collection.log. Returns
 * empty array when the file doesn't exist yet (typical on first
 * launch before the first batch has run).
 *
 * Read strategy: load the whole file, split, slice. At 100MB worst
 * case that's still fast on SSDs. If the file ever exceeds memory
 * comfortably, switch to a tail-by-byte-offset reader; for now keep
 * it simple.
 */
export async function readCollectionLog(limit = 5000): Promise<LogEntry[]> {
  const p = collectionLogPath();
  if (!existsSync(p)) return [];
  let content = '';
  try {
    content = await fs.readFile(p, 'utf8');
  } catch {
    return [];
  }
  const rawLines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = rawLines.length > limit ? rawLines.slice(-limit) : rawLines;
  const out: LogEntry[] = [];
  for (const l of tail) {
    const parsed = parseLine(l);
    if (parsed) out.push(parsed);
  }
  return out;
}

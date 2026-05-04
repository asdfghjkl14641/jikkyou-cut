import { createHash } from 'node:crypto';
import path from 'node:path';

// Convert a videoKey (typically the absolute file path supplied by the
// renderer) into a Windows-safe filename stem. Used by per-video cache
// files: aiSummary's *-summaries.json / *-extractions.json plus
// gemini.ts's analysis cache. Centralised here so a future drift —
// e.g. someone adding `:` to the forbidden set — applies uniformly.
export function videoKeyToFilenameStem(videoKey: string): string {
  return path.basename(videoKey).replace(/[\\/:*?"<>|]/g, '_');
}

// Stable identifier for an API key without persisting the plaintext.
// 12 hex chars from sha256 give 48 bits of identifier — enough that a
// 50-key set has effectively zero collision risk. Used by the Gemini
// usage log so the DB never sees a raw key.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

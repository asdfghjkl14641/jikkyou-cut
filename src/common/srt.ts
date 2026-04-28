import { nanoid } from 'nanoid';
import type { TranscriptCue } from './types';

const TIME_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

const toSec = (h: string, m: string, s: string, ms: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

export function parseSrt(content: string): TranscriptCue[] {
  // Strip BOM if present, normalise newlines.
  const normalised = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];

  const blocks = normalised.split(/\n{2,}/);
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;

    let lineIdx = 0;
    const indexLine = lines[lineIdx];
    const numericIndex = indexLine && /^\d+$/.test(indexLine.trim())
      ? Number.parseInt(indexLine.trim(), 10)
      : null;
    if (numericIndex !== null) lineIdx += 1;

    const timeLine = lines[lineIdx];
    if (!timeLine) continue;
    const m = TIME_RE.exec(timeLine);
    if (!m) continue;
    lineIdx += 1;

    const text = lines.slice(lineIdx).join(' ').trim();
    if (!text) continue;

    cues.push({
      id: nanoid(),
      index: numericIndex ?? cues.length + 1,
      startSec: toSec(m[1]!, m[2]!, m[3]!, m[4]!),
      endSec: toSec(m[5]!, m[6]!, m[7]!, m[8]!),
      text,
      deleted: false,
    });
  }
  return cues;
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { TranscriptCue } from '../common/types';

const PROJECT_VERSION = 1;

const projectPathFor = (videoFilePath: string): string => {
  const dir = path.dirname(videoFilePath);
  const base = path.basename(videoFilePath, path.extname(videoFilePath));
  return path.join(dir, `${base}.jcut.json`);
};

// Defensive read — bad/old schemas yield null rather than throwing, so the
// caller falls back to "no saved project" rather than blocking the app.
function normaliseCue(raw: unknown): TranscriptCue | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const startSec = typeof o['startSec'] === 'number' ? (o['startSec'] as number) : null;
  const endSec = typeof o['endSec'] === 'number' ? (o['endSec'] as number) : null;
  const text = typeof o['text'] === 'string' ? (o['text'] as string) : null;
  if (startSec == null || endSec == null || text == null) return null;
  return {
    id: typeof o['id'] === 'string' && (o['id'] as string).length > 0
      ? (o['id'] as string)
      : nanoid(),
    index: typeof o['index'] === 'number' ? (o['index'] as number) : 0,
    startSec,
    endSec,
    text,
    deleted: typeof o['deleted'] === 'boolean' ? (o['deleted'] as boolean) : false,
  };
}

export async function loadProject(
  videoFilePath: string,
): Promise<TranscriptCue[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(projectPathFor(videoFilePath), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const rawCues = data['cues'];
    if (!Array.isArray(rawCues)) return null;
    const out: TranscriptCue[] = [];
    for (const r of rawCues) {
      const c = normaliseCue(r);
      if (c) out.push(c);
    }
    return out;
  } catch {
    return null;
  }
}

export async function saveProject(
  videoFilePath: string,
  cues: TranscriptCue[],
): Promise<void> {
  const project = {
    version: PROJECT_VERSION,
    videoFileName: path.basename(videoFilePath),
    language: 'ja',
    generatedAt: Date.now(),
    cues,
  };
  await fs.writeFile(
    projectPathFor(videoFilePath),
    JSON.stringify(project, null, 2),
    'utf8',
  );
}

export async function clearProject(videoFilePath: string): Promise<void> {
  await fs.rm(projectPathFor(videoFilePath), { force: true });
}

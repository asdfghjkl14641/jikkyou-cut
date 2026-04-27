import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT,
  type AppConfig,
  type TranscriptionContext,
} from '../common/config';

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');

const stringField = (raw: unknown): string =>
  typeof raw === 'string' ? raw : '';

function normaliseContext(raw: unknown): TranscriptionContext {
  if (raw == null || typeof raw !== 'object') return DEFAULT_CONTEXT;
  const o = raw as Record<string, unknown>;
  return {
    gameTitle: stringField(o['gameTitle']),
    characters: stringField(o['characters']),
    catchphrases: stringField(o['catchphrases']),
    notes: stringField(o['notes']),
  };
}

// Migration note: a legacy `whisperModelPath` field may exist on disk from
// the pre-Gemini build. We silently drop it.
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      transcriptionContext: normaliseContext(parsed['transcriptionContext']),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(
  partial: Partial<AppConfig>,
): Promise<AppConfig> {
  const current = await loadConfig();
  const next: AppConfig = {
    transcriptionContext: {
      ...current.transcriptionContext,
      ...(partial.transcriptionContext ?? {}),
    },
  };
  const p = getConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

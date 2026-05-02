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

// Coerce on-disk speaker count into the documented domain. Valid values are
// `null` (auto), `2` / `3` / `4` / `5`, or `6` (the "6+" sentinel). Anything
// else — negative, zero, fractional, > 6 — collapses to null so we never
// send a malformed `diarization_config` to Gladia.
function normaliseSpeakerCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  if (n >= 2 && n <= 6) return n;
  return null;
}

// Migration note: a legacy `whisperModelPath` field may exist on disk from
// the pre-Gemini build. We silently drop it.
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      transcriptionContext: normaliseContext(parsed['transcriptionContext']),
      // Pre-collaboration-toggle configs lack the field — fall back to the
      // safer `false` (solo) so existing installs default to the cheaper
      // request shape rather than silently flipping their behaviour.
      collaborationMode: typeof parsed['collaborationMode'] === 'boolean'
        ? (parsed['collaborationMode'] as boolean)
        : DEFAULT_CONFIG.collaborationMode,
      expectedSpeakerCount: normaliseSpeakerCount(parsed['expectedSpeakerCount']),
      urlDownloadAccepted: !!parsed['urlDownloadAccepted'],
      defaultDownloadDir: typeof parsed['defaultDownloadDir'] === 'string'
        ? (parsed['defaultDownloadDir'] as string)
        : path.join(app.getPath('userData'), 'Downloads', 'jikkyou-cut'),
      defaultDownloadQuality: typeof parsed['defaultDownloadQuality'] === 'string'
        ? (parsed['defaultDownloadQuality'] as string)
        : 'best',
      lastDownloadUrl: typeof parsed['lastDownloadUrl'] === 'string'
        ? (parsed['lastDownloadUrl'] as string)
        : null,
      // Pre-flag configs lack the field — fall back to false so existing
      // installs do not silently begin consuming YouTube quota.
      dataCollectionEnabled: typeof parsed['dataCollectionEnabled'] === 'boolean'
        ? (parsed['dataCollectionEnabled'] as boolean)
        : DEFAULT_CONFIG.dataCollectionEnabled,
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      defaultDownloadDir: path.join(app.getPath('userData'), 'Downloads', 'jikkyou-cut'),
    };
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
    collaborationMode:
      partial.collaborationMode != null
        ? partial.collaborationMode
        : current.collaborationMode,
    // Note `=== undefined` rather than `!= null`: callers should be able to
    // explicitly pass `null` to switch back to auto-detect, which would
    // otherwise be swallowed by a `!= null` check.
    expectedSpeakerCount:
      partial.expectedSpeakerCount !== undefined
        ? normaliseSpeakerCount(partial.expectedSpeakerCount)
        : current.expectedSpeakerCount,
    urlDownloadAccepted:
      partial.urlDownloadAccepted !== undefined
        ? partial.urlDownloadAccepted
        : current.urlDownloadAccepted,
    defaultDownloadDir:
      partial.defaultDownloadDir !== undefined
        ? partial.defaultDownloadDir
        : current.defaultDownloadDir,
    defaultDownloadQuality:
      partial.defaultDownloadQuality !== undefined
        ? partial.defaultDownloadQuality
        : current.defaultDownloadQuality,
    lastDownloadUrl:
      partial.lastDownloadUrl !== undefined
        ? partial.lastDownloadUrl
        : current.lastDownloadUrl,
    dataCollectionEnabled:
      partial.dataCollectionEnabled !== undefined
        ? partial.dataCollectionEnabled
        : current.dataCollectionEnabled,
  };
  const p = getConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

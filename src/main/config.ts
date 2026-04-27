import { app } from 'electron';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../common/config';

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config: AppConfig): Promise<void> {
  const p = getConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2), 'utf8');
}

// Validation runs only on settings being changed in this call.
async function validatePartial(partial: Partial<AppConfig>): Promise<void> {
  if ('whisperModelPath' in partial) {
    const p = partial.whisperModelPath;
    if (p !== null && p !== undefined) {
      if (!p.toLowerCase().endsWith('.bin')) {
        throw new Error('モデルファイルは .bin 拡張子である必要があります');
      }
      try {
        await fs.access(p, fsConstants.R_OK);
      } catch {
        throw new Error('指定されたモデルファイルが見つからないか、読み込めません');
      }
    }
  }
}

export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  await validatePartial(partial);
  const current = await loadConfig();
  const next: AppConfig = { ...current, ...partial };
  await writeConfig(next);
  return next;
}

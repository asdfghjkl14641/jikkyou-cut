import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubtitleSettings, SubtitleStyle, SpeakerPreset, StylePreset } from '../common/types';

const SETTINGS_FILE = 'subtitle-settings.json';

const filePath = (): string =>
  path.join(app.getPath('userData'), SETTINGS_FILE);

const DEFAULT_PRESET: SpeakerPreset = {
  id: 'preset-default',
  name: 'デフォルト',
  speakerStyles: [
    {
      speakerId: 'default',
      speakerName: 'デフォルト',
      fontFamily: 'Noto Sans JP',
      fontSize: 48,
      textColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 4,
      shadow: { enabled: true, color: '#000000', offsetPx: 3 },
      position: 'bottom',
    },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const BUILTIN_STYLE_PRESETS: StylePreset[] = [
  {
    id: 'style-preset-emphasis',
    name: '強調',
    style: {
      fontFamily: 'Train One',
      fontSize: 56,
      textColor: '#FF0000',
      outlineColor: '#000000',
      outlineWidth: 6,
      shadow: { enabled: true, color: '#000000', offsetPx: 4 },
      position: 'bottom',
    }
  },
  {
    id: 'style-preset-whisper',
    name: 'ささやき',
    style: {
      fontFamily: 'Klee One',
      fontSize: 36,
      textColor: '#EEEEEE',
      outlineColor: '#000000',
      outlineWidth: 2,
      shadow: { enabled: false, color: '#000000', offsetPx: 1 },
      position: 'bottom',
    }
  },
  {
    id: 'style-preset-shout',
    name: '叫び',
    style: {
      fontFamily: 'Reggae One',
      fontSize: 64,
      textColor: '#FFFF00',
      outlineColor: '#000000',
      outlineWidth: 8,
      shadow: { enabled: true, color: '#000000', offsetPx: 5 },
      position: 'bottom',
    }
  },
  {
    id: 'style-preset-narration',
    name: 'ナレーション',
    style: {
      fontFamily: 'Noto Sans JP',
      fontSize: 40,
      textColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 3,
      shadow: { enabled: true, color: '#000000', offsetPx: 2 },
      position: 'top',
    }
  },
  {
    id: 'style-preset-custom',
    name: 'カスタム1',
    style: {
      fontFamily: 'Noto Sans JP',
      fontSize: 48,
      textColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 4,
      shadow: { enabled: true, color: '#000000', offsetPx: 3 },
      position: 'bottom',
    }
  }
];

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  enabled: true,
  presets: [DEFAULT_PRESET],
  activePresetId: 'preset-default',
  stylePresets: BUILTIN_STYLE_PRESETS,
};

// Re-injects the canonical default preset if missing or ensures it has the
// 'default' speaker style to prevent broken state.
function reconcilePresets(loaded: SubtitleSettings): SubtitleSettings {
  let presets = Array.isArray(loaded.presets) ? loaded.presets : [];
  
  // Migration from old `styles` based config
  if (presets.length === 0) {
    presets = [DEFAULT_PRESET];
  } else {
    // Ensure default preset exists and is unmodifiable in ID
    const defaultPresetIdx = presets.findIndex(p => p.id === 'preset-default');
    if (defaultPresetIdx === -1) {
      presets = [DEFAULT_PRESET, ...presets];
    } else {
      // Ensure 'default' speaker exists in the default preset
      const defaultPreset = presets[defaultPresetIdx]!;
      if (!defaultPreset.speakerStyles.some(s => s.speakerId === 'default')) {
        defaultPreset.speakerStyles.push({ ...DEFAULT_PRESET.speakerStyles[0]! });
      }
    }
  }

  const activePresetId = typeof loaded.activePresetId === 'string' && loaded.activePresetId.length > 0
    ? loaded.activePresetId
    : 'preset-default';

  const stylePresets = Array.isArray(loaded.stylePresets) ? loaded.stylePresets : BUILTIN_STYLE_PRESETS;

  return {
    enabled: typeof loaded.enabled === 'boolean' ? loaded.enabled : true,
    presets,
    activePresetId,
    stylePresets,
  };
}

export async function loadSubtitleSettings(): Promise<SubtitleSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath(), 'utf8');
  } catch {
    return DEFAULT_SUBTITLE_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as SubtitleSettings;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SUBTITLE_SETTINGS;
    return reconcilePresets(parsed);
  } catch {
    return DEFAULT_SUBTITLE_SETTINGS;
  }
}

export async function saveSubtitleSettings(
  settings: SubtitleSettings,
): Promise<void> {
  const p = filePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(settings, null, 2), 'utf8');
}

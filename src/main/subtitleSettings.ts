import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubtitleSettings, SubtitleStyle } from '../common/types';

const SETTINGS_FILE = 'subtitle-settings.json';

const filePath = (): string =>
  path.join(app.getPath('userData'), SETTINGS_FILE);

// Built-in style presets. These IDs are reserved (`builtin-*`) and the
// objects are re-injected on every load so the user can never delete them
// even by editing the JSON manually. Their contents are also restored to
// canonical values on every load — i.e. the user may select a built-in but
// editing one duplicates it as a user style instead (UI enforces this).
const BUILTIN_STYLES: ReadonlyArray<SubtitleStyle> = [
  {
    id: 'builtin-standard',
    name: '標準',
    fontFamily: 'Noto Sans JP',
    fontSize: 48,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 4,
    shadow: { enabled: true, color: '#000000', offsetPx: 3 },
    position: 'bottom',
    isBuiltin: true,
  },
  {
    id: 'builtin-impact',
    name: '強調',
    fontFamily: 'Reggae One',
    fontSize: 56,
    textColor: '#FFFF00',
    outlineColor: '#000000',
    outlineWidth: 5,
    shadow: { enabled: true, color: '#000000', offsetPx: 4 },
    position: 'bottom',
    isBuiltin: true,
  },
  {
    id: 'builtin-pop',
    name: 'ポップ',
    fontFamily: 'M PLUS Rounded 1c',
    fontSize: 50,
    textColor: '#FFD700',
    outlineColor: '#5B2C00',
    outlineWidth: 4,
    shadow: { enabled: true, color: '#000000', offsetPx: 3 },
    position: 'bottom',
    isBuiltin: true,
  },
  {
    id: 'builtin-pixel',
    name: 'レトロ',
    fontFamily: 'DotGothic16',
    fontSize: 44,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 3,
    shadow: { enabled: false, color: '#000000', offsetPx: 0 },
    position: 'bottom',
    isBuiltin: true,
  },
  {
    id: 'builtin-handwritten',
    name: '手書き風',
    fontFamily: 'Klee One',
    fontSize: 50,
    textColor: '#FFFFFF',
    outlineColor: '#1A1A1A',
    outlineWidth: 3,
    shadow: { enabled: true, color: '#000000', offsetPx: 2 },
    position: 'bottom',
    isBuiltin: true,
  },
];

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  enabled: true,
  activeStyleId: 'builtin-standard',
  styles: [...BUILTIN_STYLES],
};

// Re-injects the canonical built-in styles on top of whatever was loaded —
// user-authored styles (id not starting with `builtin-`) are preserved.
function reconcileBuiltins(loaded: SubtitleSettings): SubtitleSettings {
  const builtinIds = new Set(BUILTIN_STYLES.map((s) => s.id));
  const userStyles = (loaded.styles ?? []).filter(
    (s) => s != null && typeof s.id === 'string' && !builtinIds.has(s.id),
  );
  return {
    enabled:
      typeof loaded.enabled === 'boolean'
        ? loaded.enabled
        : DEFAULT_SUBTITLE_SETTINGS.enabled,
    activeStyleId:
      typeof loaded.activeStyleId === 'string' && loaded.activeStyleId.length > 0
        ? loaded.activeStyleId
        : DEFAULT_SUBTITLE_SETTINGS.activeStyleId,
    styles: [...BUILTIN_STYLES, ...userStyles],
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
    return reconcileBuiltins(parsed);
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

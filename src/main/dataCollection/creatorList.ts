import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Per-creator targeting list — JSON file at userData/data-collection/
// creators.json. Editable by hand if the user really wants, but the
// Settings UI is the canonical entry point.
//
// Schema:
//   { creators: [{ name: string, channelId: string | null, group: string | null }] }
//
// `group` was added 2026-05-03 alongside the seed-40 list. It tags
// each creator as 'nijisanji' / 'hololive' / 'streamer' so Phase 2
// analytics can compare across groups. User-added creators (via
// Settings) get `null` and are still fully functional.

export type CreatorGroup = 'nijisanji' | 'hololive' | 'streamer';

export type CreatorEntry = {
  name: string;
  channelId: string | null;
  group: CreatorGroup | null;
};

const filePath = (): string =>
  path.join(app.getPath('userData'), 'data-collection', 'creators.json');

const isCreatorGroup = (s: unknown): s is CreatorGroup =>
  s === 'nijisanji' || s === 'hololive' || s === 'streamer';

export async function loadCreatorList(): Promise<CreatorEntry[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as { creators?: unknown };
    if (!Array.isArray(parsed.creators)) return [];
    return parsed.creators
      .filter((c): c is { name: string; channelId?: string | null; group?: unknown } =>
        c != null && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
      )
      .map((c) => ({
        name: c.name,
        channelId: typeof c.channelId === 'string' ? c.channelId : null,
        group: isCreatorGroup(c.group) ? c.group : null,
      }));
  } catch {
    return [];
  }
}

export async function saveCreatorList(creators: CreatorEntry[]): Promise<void> {
  const p = filePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // De-duplicate by name (case-sensitive — Japanese names are often
  // already canonical, no need for fancier matching).
  const seen = new Set<string>();
  const cleaned: CreatorEntry[] = [];
  for (const c of creators) {
    const name = c.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cleaned.push({
      name,
      channelId: c.channelId?.trim() || null,
      group: c.group ?? null,
    });
  }
  await fs.writeFile(p, JSON.stringify({ creators: cleaned }, null, 2), 'utf8');
}

export async function addCreator(name: string, channelId: string | null): Promise<void> {
  const list = await loadCreatorList();
  if (list.some((c) => c.name === name.trim())) return;
  // User-added creators have no group tag — analytics treats them as
  // "uncategorised" until the user manually edits creators.json.
  list.push({ name: name.trim(), channelId, group: null });
  await saveCreatorList(list);
}

export async function removeCreator(name: string): Promise<void> {
  const list = await loadCreatorList();
  await saveCreatorList(list.filter((c) => c.name !== name));
}

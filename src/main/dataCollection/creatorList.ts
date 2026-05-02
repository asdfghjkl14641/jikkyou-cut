import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Per-creator targeting list — JSON file at userData/data-collection/
// creators.json. Editable by hand if the user really wants, but the
// Settings UI is the canonical entry point.
//
// Schema:
//   { creators: [{ name: string, channelId: string | null }] }

export type CreatorEntry = {
  name: string;
  channelId: string | null;
};

const filePath = (): string =>
  path.join(app.getPath('userData'), 'data-collection', 'creators.json');

export async function loadCreatorList(): Promise<CreatorEntry[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as { creators?: unknown };
    if (!Array.isArray(parsed.creators)) return [];
    return parsed.creators
      .filter((c): c is { name: string; channelId?: string | null } =>
        c != null && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
      )
      .map((c) => ({
        name: c.name,
        channelId: typeof c.channelId === 'string' ? c.channelId : null,
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
    cleaned.push({ name, channelId: c.channelId?.trim() || null });
  }
  await fs.writeFile(p, JSON.stringify({ creators: cleaned }, null, 2), 'utf8');
}

export async function addCreator(name: string, channelId: string | null): Promise<void> {
  const list = await loadCreatorList();
  if (list.some((c) => c.name === name.trim())) return;
  list.push({ name: name.trim(), channelId });
  await saveCreatorList(list);
}

export async function removeCreator(name: string): Promise<void> {
  const list = await loadCreatorList();
  await saveCreatorList(list.filter((c) => c.name !== name));
}

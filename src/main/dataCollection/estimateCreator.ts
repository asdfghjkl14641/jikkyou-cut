import type Database from 'better-sqlite3';

// Heuristic creator detection from video metadata. Pure-ish — takes the
// db handle as an arg so callers can swap it for tests. Used by the AI
// auto-extract flow to inject a "配信者: ..." line into the refine
// prompt; future M1.5b will key per-creator pattern files off the same
// estimation.

export type CreatorEstimation = {
  creatorName: string | null;
  creatorGroup: string | null;
  // 'channel-match' is the strongest signal (channel handle === creator
  // name), 'title-match' is the substring-in-title fallback, 'unknown'
  // is "neither rule fired — show 指定なし to the user".
  source: 'channel-match' | 'title-match' | 'unknown';
};

// Names of 1-2 chars (e.g. "叶") false-match almost anywhere in a long
// Japanese title, so they're skipped on the title-match path. They can
// still be picked via channel-match (which is exact) or by the user
// manually overriding through the picker UI.
const MIN_TITLE_MATCH_LEN = 3;

type CreatorRow = { name: string; creator_group: string | null };

export function estimateCreator(
  db: Database.Database,
  args: { videoTitle: string; channelName?: string },
): CreatorEstimation {
  const rows = db
    .prepare('SELECT name, creator_group FROM creators WHERE is_target = 1')
    .all() as CreatorRow[];

  if (args.channelName) {
    const exact = rows.find((r) => r.name === args.channelName);
    if (exact) {
      return {
        creatorName: exact.name,
        creatorGroup: exact.creator_group,
        source: 'channel-match',
      };
    }
  }

  // Longest-name-first so "葛葉ナチュラル" (hypothetical longer name)
  // wins over a bare "葛葉" prefix when both are seeded.
  const sorted = [...rows].sort((a, b) => b.name.length - a.name.length);
  for (const r of sorted) {
    if (r.name.length < MIN_TITLE_MATCH_LEN) continue;
    if (args.videoTitle.includes(r.name)) {
      return {
        creatorName: r.name,
        creatorGroup: r.creator_group,
        source: 'title-match',
      };
    }
  }

  return { creatorName: null, creatorGroup: null, source: 'unknown' };
}

// Picker UI source. Only seed creators (is_target = 1) — auto-discovered
// uploaders aren't pickable here. Sorted by group then name so the
// dialog can render group sections in a stable order.
export function listSeedCreatorsForPicker(
  db: Database.Database,
): Array<{ name: string; group: string | null }> {
  return db
    .prepare(
      `SELECT name, creator_group AS "group"
         FROM creators
        WHERE is_target = 1
        ORDER BY creator_group ASC, name ASC`,
    )
    .all() as Array<{ name: string; group: string | null }>;
}

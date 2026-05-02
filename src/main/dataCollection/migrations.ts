import { app } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// One-shot DB schema migrations for the data-collection database.
// Versioning is tracked via SQLite's built-in `PRAGMA user_version` —
// we don't need a separate `_migrations` table. Each migration bumps
// user_version by 1 on success.
//
// Migrations live next to the main schema (database.ts) so the rest of
// the code can keep treating openDb() as the single entry point. The
// startup wires runMigrations() in app.whenReady BEFORE the seed step
// (which calls openDb), so the schema changes have landed by the time
// any normal query runs.

const dbPath = (): string => path.join(app.getPath('userData'), 'data-collection.db');

const TARGET_VERSION = 1;

export type MigrationOutcome = {
  ranMigrations: number[];           // versions actually executed this call
  finalVersion: number;
  backupPath: string | null;         // null when no backup was needed (already up to date)
  details: string[];
};

export async function runMigrations(): Promise<MigrationOutcome> {
  const p = dbPath();
  if (!existsSync(p)) {
    // Fresh install. No migration to run yet — the regular SCHEMA in
    // database.ts will set up tables on first openDb. user_version is
    // bumped here so a brand-new install starts at TARGET_VERSION
    // and skips the data-migration steps that operate on legacy rows.
    const tmpDb = new Database(p);
    try {
      tmpDb.pragma(`user_version = ${TARGET_VERSION}`);
    } finally {
      tmpDb.close();
    }
    return {
      ranMigrations: [],
      finalVersion: TARGET_VERSION,
      backupPath: null,
      details: ['fresh install — initialized user_version'],
    };
  }

  // Check current version with a throwaway connection. We close before
  // backup so the file copy isn't fighting WAL.
  let initial: number;
  {
    const probe = new Database(p, { readonly: true });
    try {
      initial = probe.pragma('user_version', { simple: true }) as number;
    } finally {
      probe.close();
    }
  }
  if (initial >= TARGET_VERSION) {
    return {
      ranMigrations: [],
      finalVersion: initial,
      backupPath: null,
      details: [`already at user_version=${initial}, target=${TARGET_VERSION}`],
    };
  }

  // About to mutate. Take a backup of the .db file (after a WAL
  // checkpoint so there's nothing pending in the .wal sidecar).
  const backupPath = await createBackup(p);

  const db = new Database(p);
  const ran: number[] = [];
  const details: string[] = [];
  try {
    let v = db.pragma('user_version', { simple: true }) as number;
    if (v < 1) {
      const r = migrate001SplitUploaders(db);
      db.pragma('user_version = 1');
      ran.push(1);
      details.push(`v1 split-uploaders: ${r}`);
      v = 1;
    }
    return {
      ranMigrations: ran,
      finalVersion: v,
      backupPath,
      details,
    };
  } finally {
    db.close();
  }
}

async function createBackup(p: string): Promise<string> {
  // Flush WAL into the main file so the .db on disk is a complete
  // snapshot. Then copy the file alongside, with a timestamped suffix.
  const flush = new Database(p);
  try {
    flush.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    flush.close();
  }
  const ts = new Date()
    .toISOString()
    .replace(/[-:.]/g, '')
    .slice(0, 15); // YYYYMMDDTHHMMSS
  const backup = `${p}.bak.${ts}`;
  await fs.copyFile(p, backup);
  // eslint-disable-next-line no-console
  console.log(`[migration] backup created: ${backup}`);
  return backup;
}

// ---------------------------------------------------------------------
// Migration 001 — split clip uploaders out of the creators table.
//
// Before:
//   creators(is_target=0) held both the seed roster AND every uploader
//   YouTube returned in broad-search results, with no way to tell them
//   apart for analytics. The user's seed of 75 ballooned to 325 after
//   only a handful of batches.
//
// After:
//   uploaders/<id, channel_id, channel_name>             — clip uploaders
//   creators/<id, name, channel_id, is_target=1, group>  — seed only
//   videos.uploader_id                                    — link to uploader
//   videos.creator_id                                     — link to seed
//                                                           creator (NULL
//                                                           for broad-search
//                                                           hits we don't
//                                                           know how to
//                                                           attribute)
//
// Strategy:
//   1. Create uploaders + indexes + videos.uploader_id (idempotent).
//   2. Bulk-insert one uploader per distinct videos.channel_name (covers
//      every video, including those whose creator was is_target=1).
//   3. Sweep is_target=0 creators in case they have no video link —
//      their identifying info still moves to uploaders.
//   4. Backfill videos.uploader_id by joining on channel_name.
//   5. Null out videos.creator_id for the rows that previously linked
//      to is_target=0 (auto-add) creators — those creators are about
//      to disappear, and the video's "true creator" is unknown.
//   6. Delete is_target=0 creators.
//   7. Refresh uploaders.video_count cache.
// ---------------------------------------------------------------------
function migrate001SplitUploaders(db: Database.Database): string {
  const summary: string[] = [];
  const tx = db.transaction(() => {
    // Step 1 — schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS uploaders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT,
        channel_name TEXT NOT NULL UNIQUE,
        first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
        video_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_uploaders_channel_id ON uploaders(channel_id);
      CREATE INDEX IF NOT EXISTS idx_uploaders_video_count ON uploaders(video_count DESC);
    `);

    const cols = db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'uploader_id')) {
      db.exec('ALTER TABLE videos ADD COLUMN uploader_id INTEGER REFERENCES uploaders(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_uploader ON videos(uploader_id)');

    // Step 2 — uploaders from videos.channel_name
    const upserted = db.prepare(`
      INSERT INTO uploaders (channel_id, channel_name)
      SELECT
        (SELECT channel_id FROM videos v2 WHERE v2.channel_name = v.channel_name AND v2.channel_id IS NOT NULL LIMIT 1),
        channel_name
      FROM videos v
      WHERE channel_name IS NOT NULL AND channel_name != ''
      GROUP BY channel_name
      ON CONFLICT(channel_name) DO UPDATE SET
        channel_id = COALESCE(uploaders.channel_id, excluded.channel_id)
    `).run();
    summary.push(`uploaders from videos: +${upserted.changes}`);

    // Step 3 — also catch is_target=0 creators that aren't in videos
    const orphans = db.prepare(`
      INSERT INTO uploaders (channel_id, channel_name)
      SELECT channel_id, name
      FROM creators
      WHERE is_target = 0
      ON CONFLICT(channel_name) DO UPDATE SET
        channel_id = COALESCE(uploaders.channel_id, excluded.channel_id)
    `).run();
    summary.push(`uploaders from orphaned creators: +${orphans.changes}`);

    // Step 4 — backfill videos.uploader_id
    const linked = db.prepare(`
      UPDATE videos
      SET uploader_id = (
        SELECT id FROM uploaders WHERE uploaders.channel_name = videos.channel_name
      )
      WHERE channel_name IS NOT NULL AND channel_name != '' AND uploader_id IS NULL
    `).run();
    summary.push(`videos linked to uploaders: ${linked.changes}`);

    // Step 5 — null out creator_id for is_target=0 links
    const nullified = db.prepare(`
      UPDATE videos
      SET creator_id = NULL
      WHERE creator_id IN (SELECT id FROM creators WHERE is_target = 0)
    `).run();
    summary.push(`videos.creator_id nullified: ${nullified.changes}`);

    // Step 6 — delete is_target=0 creators
    const deleted = db.prepare('DELETE FROM creators WHERE is_target = 0').run();
    summary.push(`auto-add creators removed: ${deleted.changes}`);

    // Step 7 — refresh uploader.video_count cache
    db.exec(`
      UPDATE uploaders
      SET video_count = (SELECT COUNT(*) FROM videos WHERE videos.uploader_id = uploaders.id)
    `);
    const finalCount = db.prepare('SELECT COUNT(*) AS n FROM uploaders').get() as { n: number };
    summary.push(`final uploaders count: ${finalCount.n}`);
  });
  tx();
  return summary.join('; ');
}

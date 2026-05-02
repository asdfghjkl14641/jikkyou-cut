import { app } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

// Singleton SQLite handle. Main-process only — better-sqlite3 is sync
// and not safe across worker boundaries. Renderer-side code reaches
// data through IPC.
//
// File: userData/data-collection.db. WAL mode for tolerable
// concurrency between the background collector loop and the
// occasional read from a Settings UI query.
let db: Database.Database | null = null;

const dbPath = (): string => path.join(app.getPath('userData'), 'data-collection.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  channel_id TEXT,
  is_target INTEGER DEFAULT 0,
  -- Affiliation tag for analytics: 'nijisanji' | 'hololive' | 'streamer'
  -- | null. Set on seed; not overwritten on upsert. Column name avoids
  -- the SQL GROUP reserved word.
  creator_group TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  creator_id INTEGER,
  title TEXT NOT NULL,
  channel_id TEXT,
  channel_name TEXT,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  duration_sec INTEGER,
  published_at TEXT,
  thumbnail_path TEXT,
  url TEXT,
  description TEXT,
  raw_metadata TEXT,
  collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE TABLE IF NOT EXISTS heatmap_peaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  peak_value REAL NOT NULL,
  chapter_title TEXT,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_quota_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_index INTEGER NOT NULL,
  date TEXT NOT NULL,
  units_used INTEGER NOT NULL,
  UNIQUE(api_key_index, date)
);

CREATE INDEX IF NOT EXISTS idx_videos_creator ON videos(creator_id);
CREATE INDEX IF NOT EXISTS idx_videos_view ON videos(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_heatmap_video ON heatmap_peaks(video_id);
CREATE INDEX IF NOT EXISTS idx_chapters_video ON chapters(video_id);
`;

export function openDb(): Database.Database {
  if (db) return db;
  const p = dbPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const handle = new Database(p);
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.exec(SCHEMA);
  migrateSchema(handle);
  db = handle;
  return handle;
}

// Apply additive migrations for tables that pre-existed before a column
// was added. SQLite's `ALTER TABLE ADD COLUMN` is idempotent only if we
// gate on `PRAGMA table_info`.
function migrateSchema(handle: Database.Database): void {
  const cols = handle.prepare('PRAGMA table_info(creators)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'creator_group')) {
    handle.exec('ALTER TABLE creators ADD COLUMN creator_group TEXT');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---- Models ----------------------------------------------------------------

export type CreatorRow = {
  id: number;
  name: string;
  channel_id: string | null;
  is_target: number;
  creator_group: string | null;
  created_at: string;
};

export type VideoUpsert = {
  id: string;
  creator_id: number | null;
  uploader_id: number | null;
  title: string;
  channel_id: string | null;
  channel_name: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  duration_sec: number | null;
  published_at: string | null;
  thumbnail_path: string | null;
  url: string | null;
  description: string | null;
  raw_metadata: string | null;
};

export type HeatmapPeakInsert = {
  video_id: string;
  rank: number;
  start_sec: number;
  end_sec: number;
  peak_value: number;
  chapter_title: string | null;
};

export type ChapterInsert = {
  video_id: string;
  title: string;
  start_sec: number;
  end_sec: number;
};

// ---- Creator helpers -------------------------------------------------------

export function upsertCreator(
  name: string,
  channelId: string | null,
  isTarget: boolean,
  group: string | null = null,
): number {
  const conn = openDb();
  const existing = conn
    .prepare('SELECT id, channel_id, is_target FROM creators WHERE name = ?')
    .get(name) as { id: number; channel_id: string | null; is_target: number } | undefined;
  if (existing) {
    if (
      (channelId && existing.channel_id !== channelId) ||
      (isTarget ? 1 : 0) !== existing.is_target
    ) {
      // Group is set on first insert and intentionally not overwritten
      // here — a per-video upsert for a random clip uploader shouldn't
      // wipe the affiliation tag set by the seed step.
      conn
        .prepare('UPDATE creators SET channel_id = COALESCE(?, channel_id), is_target = ? WHERE id = ?')
        .run(channelId, isTarget ? 1 : 0, existing.id);
    }
    return existing.id;
  }
  const result = conn
    .prepare('INSERT INTO creators (name, channel_id, is_target, creator_group) VALUES (?, ?, ?, ?)')
    .run(name, channelId, isTarget ? 1 : 0, group);
  return Number(result.lastInsertRowid);
}

export function listCreators(): CreatorRow[] {
  return openDb()
    .prepare('SELECT * FROM creators ORDER BY is_target DESC, name ASC')
    .all() as CreatorRow[];
}

// Look up a creator's id by name, without touching channel_id /
// is_target / group. Used by the batch loop to attribute videos
// found via per-creator search to the seed creator that prompted
// the search — passing detail.channelId through upsertCreator would
// incorrectly overwrite the creator's resolved channel_id with the
// uploader's channel_id (different entity).
export function getCreatorIdByName(name: string): number | null {
  const row = openDb()
    .prepare('SELECT id FROM creators WHERE name = ? LIMIT 1')
    .get(name) as { id: number } | undefined;
  return row?.id ?? null;
}

// Backfill the `creator_group` column only when it's currently NULL.
// Used by the seed-or-update step so a previously seeded creator
// (with group already set) is never overwritten by a stale value, but
// rows that existed before the column was introduced still get tagged.
export function setCreatorGroupIfNull(name: string, group: string): void {
  openDb()
    .prepare('UPDATE creators SET creator_group = ? WHERE name = ? AND creator_group IS NULL')
    .run(group, name);
}

// ---- Uploader helpers ------------------------------------------------------
// Uploaders are clip-uploader channels (the entity that posted the
// video). They live in their own table so the creators table can stay
// pure (= seeded streamers only), which lets Phase 2 analytics treat
// the two populations independently. Migration 001 split them out from
// the legacy mixed-creators table.

export function upsertUploader(channelId: string | null, channelName: string): number {
  const conn = openDb();
  const trimmed = channelName.trim();
  if (!trimmed) {
    throw new Error('upsertUploader: channelName must be non-empty');
  }
  // INSERT ... ON CONFLICT ... RETURNING id is supported on SQLite
  // 3.35+ which better-sqlite3 v12 bundles. Returns existing id on
  // conflict so the caller doesn't need a separate SELECT round-trip.
  const row = conn
    .prepare(
      `INSERT INTO uploaders (channel_id, channel_name)
       VALUES (?, ?)
       ON CONFLICT(channel_name) DO UPDATE SET
         channel_id = COALESCE(uploaders.channel_id, excluded.channel_id)
       RETURNING id`,
    )
    .get(channelId, trimmed) as { id: number };
  return row.id;
}

// Bumped on every successful video upsert that links to this uploader.
// Cheap counter — saved in the row so analytics can filter "uploaders
// with at least N videos" without a heavy JOIN.
export function bumpUploaderVideoCount(uploaderId: number): void {
  openDb()
    .prepare('UPDATE uploaders SET video_count = video_count + 1 WHERE id = ?')
    .run(uploaderId);
}

// ---- Video upsert (atomic across video + peaks + chapters) ----------------

export function upsertVideoFull(args: {
  video: VideoUpsert;
  peaks: HeatmapPeakInsert[];
  chapters: ChapterInsert[];
}): void {
  const conn = openDb();
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO videos (id, creator_id, uploader_id, title, channel_id, channel_name,
                             view_count, like_count, comment_count, duration_sec,
                             published_at, thumbnail_path, url, description, raw_metadata,
                             collected_at)
         VALUES (@id, @creator_id, @uploader_id, @title, @channel_id, @channel_name,
                 @view_count, @like_count, @comment_count, @duration_sec,
                 @published_at, @thumbnail_path, @url, @description, @raw_metadata,
                 CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           creator_id = excluded.creator_id,
           uploader_id = excluded.uploader_id,
           title = excluded.title,
           channel_id = excluded.channel_id,
           channel_name = excluded.channel_name,
           view_count = excluded.view_count,
           like_count = excluded.like_count,
           comment_count = excluded.comment_count,
           duration_sec = excluded.duration_sec,
           published_at = excluded.published_at,
           thumbnail_path = COALESCE(excluded.thumbnail_path, videos.thumbnail_path),
           url = excluded.url,
           description = excluded.description,
           raw_metadata = excluded.raw_metadata,
           collected_at = CURRENT_TIMESTAMP`,
      )
      .run(args.video);

    // Wipe previous peaks/chapters for this video then re-insert. Simpler
    // than computing diffs and produces the right result for the common
    // "re-collect → fresh data" path.
    conn.prepare('DELETE FROM heatmap_peaks WHERE video_id = ?').run(args.video.id);
    conn.prepare('DELETE FROM chapters WHERE video_id = ?').run(args.video.id);

    const insertPeak = conn.prepare(
      `INSERT INTO heatmap_peaks (video_id, rank, start_sec, end_sec, peak_value, chapter_title)
       VALUES (@video_id, @rank, @start_sec, @end_sec, @peak_value, @chapter_title)`,
    );
    for (const p of args.peaks) insertPeak.run(p);

    const insertChapter = conn.prepare(
      `INSERT INTO chapters (video_id, title, start_sec, end_sec)
       VALUES (@video_id, @title, @start_sec, @end_sec)`,
    );
    for (const c of args.chapters) insertChapter.run(c);
  });
  tx();
}

export function videoExists(id: string): boolean {
  const row = openDb()
    .prepare('SELECT 1 FROM videos WHERE id = ? LIMIT 1')
    .get(id);
  return row != null;
}

// ---- Quota log -------------------------------------------------------------

const todayStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function logQuotaUsage(keyIndex: number, units: number): void {
  const conn = openDb();
  conn
    .prepare(
      `INSERT INTO api_quota_log (api_key_index, date, units_used)
       VALUES (?, ?, ?)
       ON CONFLICT(api_key_index, date) DO UPDATE SET
         units_used = units_used + excluded.units_used`,
    )
    .run(keyIndex, todayStr(), units);
}

export function getQuotaUsedToday(keyIndex: number): number {
  const row = openDb()
    .prepare('SELECT units_used FROM api_quota_log WHERE api_key_index = ? AND date = ?')
    .get(keyIndex, todayStr()) as { units_used: number } | undefined;
  return row?.units_used ?? 0;
}

export function getTotalQuotaUsedToday(): number {
  const row = openDb()
    .prepare('SELECT COALESCE(SUM(units_used), 0) AS total FROM api_quota_log WHERE date = ?')
    .get(todayStr()) as { total: number };
  return row.total;
}

// Per-key breakdown for the API management UI. Returns one entry per
// key index seen today; rows for keys that haven't been used today
// don't appear (caller fills with zero if needed).
export function getQuotaPerKeyToday(): Array<{ keyIndex: number; unitsUsed: number }> {
  const rows = openDb()
    .prepare(
      'SELECT api_key_index AS keyIndex, units_used AS unitsUsed ' +
      'FROM api_quota_log WHERE date = ? ORDER BY api_key_index ASC',
    )
    .all(todayStr()) as Array<{ keyIndex: number; unitsUsed: number }>;
  return rows;
}

// ---- Stats for Settings UI -------------------------------------------------

export type CollectionStats = {
  videoCount: number;
  // Seed creators only (= is_target=1). Auto-discovered uploaders
  // moved to the uploaders table by migration 001 — they are no
  // longer counted here.
  creatorCount: number;
  uploaderCount: number;
  quotaUsedToday: number;
  lastCollectedAt: string | null;
};

export function getStats(): CollectionStats {
  const conn = openDb();
  const v = conn.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number };
  const c = conn.prepare('SELECT COUNT(*) AS n FROM creators WHERE is_target = 1').get() as { n: number };
  // The uploaders table is created by migration 001. On a fresh
  // install the migration runs before the first getStats call (wired
  // via app.whenReady), so the table is always present here.
  const u = conn.prepare('SELECT COUNT(*) AS n FROM uploaders').get() as { n: number };
  const last = conn.prepare('SELECT MAX(collected_at) AS t FROM videos').get() as { t: string | null };
  return {
    videoCount: v.n,
    creatorCount: c.n,
    uploaderCount: u.n,
    quotaUsedToday: getTotalQuotaUsedToday(),
    lastCollectedAt: last.t,
  };
}

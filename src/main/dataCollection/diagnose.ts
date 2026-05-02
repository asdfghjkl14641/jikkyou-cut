import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';

// One-shot DB introspection helper. Wired to a temporary "デバッグ:
// DB 診断" menu entry so the user can trigger it from Electron and
// the output flows to whatever terminal hosts `npm run dev`.
//
// Read-only — opens a separate handle in readonly mode so it cannot
// accidentally mutate state. Triggered manually; never runs on its own.
//
// Diagnoses the "配信者 325 件 / seed 75 人" mismatch:
//   - Q1 / Q2 / Q3 / Q4 / Q5 dissect the creators table
//   - Q6 / Q7 inspect the videos → creators link
//   - Q8 reads the per-key quota log

export function diagnoseDataCollection(): void {
  const dbPath = path.join(app.getPath('userData'), 'data-collection.db');
  // eslint-disable-next-line no-console
  console.log('===== DATA COLLECTION DIAGNOSIS =====');
  // eslint-disable-next-line no-console
  console.log('[diag] db path:', dbPath);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diag] failed to open db:', err);
    return;
  }

  try {
    // Q1: total creators
    const total = db.prepare('SELECT COUNT(*) AS n FROM creators').get() as { n: number };
    // eslint-disable-next-line no-console
    console.log('[diag] Q1 creators total:', total.n);

    // Q2: duplicate names (UNIQUE constraint should make this 0, sanity check)
    const dups = db.prepare(`
      SELECT name, COUNT(*) AS cnt
      FROM creators
      GROUP BY name
      HAVING cnt > 1
      ORDER BY cnt DESC
      LIMIT 20
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q2 duplicate names:', dups.length, 'cases', dups);

    // Q3: by creator_group (seed 由来は付いてる、auto-add は NULL)
    const byGroup = db.prepare(`
      SELECT creator_group, COUNT(*) AS cnt
      FROM creators
      GROUP BY creator_group
      ORDER BY cnt DESC
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q3 by creator_group:', byGroup);

    // Q4: by is_target (seed=1, auto-add=0)
    const byTarget = db.prepare(`
      SELECT is_target, COUNT(*) AS cnt
      FROM creators
      GROUP BY is_target
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q4 by is_target:', byTarget);

    // Q5: most recently added 20 creators (seed と auto-discover の判別用)
    const recent = db.prepare(`
      SELECT id, name, channel_id, is_target, creator_group, created_at
      FROM creators
      ORDER BY id DESC
      LIMIT 20
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q5 recent 20 creators (newest first):');
    for (const r of recent as Array<{ id: number; name: string; channel_id: string | null; is_target: number; creator_group: string | null; created_at: string }>) {
      // eslint-disable-next-line no-console
      console.log(`  id=${r.id} target=${r.is_target} group=${r.creator_group ?? 'NULL'} name="${r.name}"`);
    }

    // Q6: video-to-creator link stats
    const videoStats = db.prepare(`
      SELECT
        COUNT(*) AS total_videos,
        COUNT(DISTINCT creator_id) AS distinct_creator_ids,
        COUNT(DISTINCT channel_id) AS distinct_channels,
        COUNT(DISTINCT channel_name) AS distinct_channel_names
      FROM videos
    `).get();
    // eslint-disable-next-line no-console
    console.log('[diag] Q6 video stats:', videoStats);

    // Q7: top channels by video count (= 切り抜き投稿者 ranking)
    const topChannels = db.prepare(`
      SELECT channel_name, COUNT(*) AS video_count
      FROM videos
      GROUP BY channel_name
      ORDER BY video_count DESC
      LIMIT 20
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q7 top 20 uploader channels:');
    for (const r of topChannels as Array<{ channel_name: string | null; video_count: number }>) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.video_count} videos — "${r.channel_name ?? '(null)'}"`);
    }

    // Q8: API quota by key, today
    const today = new Date().toISOString().slice(0, 10);
    const quotaToday = db.prepare(`
      SELECT api_key_index, units_used
      FROM api_quota_log
      WHERE date = ?
      ORDER BY api_key_index
    `).all(today);
    // eslint-disable-next-line no-console
    console.log(`[diag] Q8 quota today (${today}):`, quotaToday);

    // Q9: spot-check — creators that exist in the seed file's name
    // space (so we can directly compare seed roster vs DB).
    const seedTargetCount = db.prepare(`
      SELECT COUNT(*) AS n FROM creators WHERE is_target = 1
    `).get() as { n: number };
    const autoAddedCount = db.prepare(`
      SELECT COUNT(*) AS n FROM creators WHERE is_target = 0
    `).get() as { n: number };
    // eslint-disable-next-line no-console
    console.log(
      '[diag] Q9 summary:',
      `${seedTargetCount.n} target (seed-like) +`,
      `${autoAddedCount.n} auto-added (uploaders from broad search) =`,
      `${seedTargetCount.n + autoAddedCount.n} total`,
    );

    // eslint-disable-next-line no-console
    console.log('===== DIAGNOSIS COMPLETE =====');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diag] error during queries:', err);
  } finally {
    db.close();
  }
}

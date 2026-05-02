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

    // Q3b: list NULL-group creator names for diagnosis. After
    // reseedGroupsForExistingCreators runs, this should be empty for
    // any name appearing in SEED_CREATORS. Stragglers (likely
    // user-added via Settings UI) stay null until manually grouped.
    const nullGroupNames = db.prepare(`
      SELECT id, name, is_target, channel_id, created_at
      FROM creators
      WHERE creator_group IS NULL
      ORDER BY id
    `).all();
    // eslint-disable-next-line no-console
    console.log('[diag] Q3b NULL group creators:', nullGroupNames.length, 'rows');
    for (const r of nullGroupNames as Array<{ id: number; name: string; is_target: number; channel_id: string | null; created_at: string }>) {
      // eslint-disable-next-line no-console
      console.log(`  id=${r.id} target=${r.is_target} name="${r.name}" channel_id=${r.channel_id ?? '(null)'} created=${r.created_at}`);
    }

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

    // Migration-aware queries. Skip silently if the uploaders table
    // doesn't exist (= migration 001 hasn't run yet).
    const hasUploaders = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='uploaders'")
      .get();
    if (hasUploaders) {
      // Q10: total uploaders
      const upCount = db.prepare('SELECT COUNT(*) AS n FROM uploaders').get() as { n: number };
      // eslint-disable-next-line no-console
      console.log('[diag] Q10 uploaders total:', upCount.n);

      // Q11: videos linked to an uploader
      const videosWithUp = db.prepare(
        'SELECT COUNT(*) AS n FROM videos WHERE uploader_id IS NOT NULL',
      ).get() as { n: number };
      // eslint-disable-next-line no-console
      console.log('[diag] Q11 videos with uploader_id NOT NULL:', videosWithUp.n);

      // Q12: videos linked to a seed creator
      const videosWithCreator = db.prepare(
        'SELECT COUNT(*) AS n FROM videos WHERE creator_id IS NOT NULL',
      ).get() as { n: number };
      // eslint-disable-next-line no-console
      console.log('[diag] Q12 videos with creator_id NOT NULL (seed 紐付き):', videosWithCreator.n);

      // Q13: top 10 uploaders by video_count (cached) — sanity check
      // that the migration's count refresh matched reality.
      const topUploaders = db.prepare(`
        SELECT u.channel_name, u.video_count AS cached, COUNT(v.id) AS actual
        FROM uploaders u
        LEFT JOIN videos v ON v.uploader_id = u.id
        GROUP BY u.id
        ORDER BY u.video_count DESC
        LIMIT 10
      `).all();
      // eslint-disable-next-line no-console
      console.log('[diag] Q13 top 10 uploaders (cached vs actual count):');
      for (const r of topUploaders as Array<{ channel_name: string; cached: number; actual: number }>) {
        const drift = r.cached !== r.actual ? ` ⚠ DRIFT` : '';
        // eslint-disable-next-line no-console
        console.log(`  cached=${r.cached} actual=${r.actual}${drift} — "${r.channel_name}"`);
      }

      // Q14: user_version (= which migrations have run)
      const userVersion = db.pragma('user_version', { simple: true }) as number;
      // eslint-disable-next-line no-console
      console.log('[diag] Q14 user_version:', userVersion);

      // Q15-Q17: recent-activity sanity checks. After "1 回だけ取得"
      // these reveal whether the new batch correctly routes broad-
      // search hits to uploaders (Q16 should grow) and NOT to
      // creators (Q17 must stay 0 — any non-zero value means the
      // broad-search auto-add regression is back).

      const recentVideos = db.prepare(`
        SELECT
          SUM(CASE WHEN creator_id IS NOT NULL THEN 1 ELSE 0 END) AS with_creator,
          SUM(CASE WHEN uploader_id IS NOT NULL THEN 1 ELSE 0 END) AS with_uploader,
          COUNT(*) AS total
        FROM videos
        WHERE collected_at > datetime('now', '-1 hour')
      `).get() as { with_creator: number | null; with_uploader: number | null; total: number };
      // eslint-disable-next-line no-console
      console.log(
        '[diag] Q15 videos collected in last 1h:',
        `total=${recentVideos.total}`,
        `with_creator=${recentVideos.with_creator ?? 0}`,
        `with_uploader=${recentVideos.with_uploader ?? 0}`,
      );

      const recentUploaders = db.prepare(`
        SELECT COUNT(*) AS n FROM uploaders WHERE first_seen_at > datetime('now', '-1 hour')
      `).get() as { n: number };
      // eslint-disable-next-line no-console
      console.log('[diag] Q16 new uploaders in last 1h:', recentUploaders.n);

      const recentCreators = db.prepare(`
        SELECT COUNT(*) AS n FROM creators WHERE created_at > datetime('now', '-1 hour')
      `).get() as { n: number };
      const regression = recentCreators.n > 0 ? ' ⚠ AUTO-ADD REGRESSION SUSPECTED' : '';
      // eslint-disable-next-line no-console
      console.log(`[diag] Q17 new creators in last 1h: ${recentCreators.n} (expected 0)${regression}`);
    } else {
      // eslint-disable-next-line no-console
      console.log('[diag] Q10-Q17 skipped (uploaders table does not exist — migration 001 has not run)');
    }

    // eslint-disable-next-line no-console
    console.log('===== DIAGNOSIS COMPLETE =====');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diag] error during queries:', err);
  } finally {
    db.close();
  }
}

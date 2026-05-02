import { loadCreatorList, saveCreatorList, type CreatorEntry } from './creatorList';
import { openDb, setCreatorGroupIfNull, upsertCreator } from './database';
import { searchChannelByName } from './youtubeApi';
import { logInfo, logWarn } from './logger';

// Seed list curated by the user. Expanded 2026-05-03 from 40 → 75
// creators across five affiliation groups, used as the starting
// target list for Phase 1 data collection.
//
// channelId is resolved lazily on each batch via
// resolveCreatorChannelIds() — keeping the seed list literal here
// lets us ship without any network round-trip at install time.
//
// Note on neoporte: the box is relatively new and its membership has
// fluctuated. If `_collectBatch` reports 0 hits for a name's
// "切り抜き" query, the warning surfaces in collection.log and the
// user is expected to edit creators.json to correct the spelling.
export const SEED_CREATORS: readonly CreatorEntry[] = [
  // にじさんじ (20)
  { name: '葛葉', channelId: null, group: 'nijisanji' },
  { name: '叶', channelId: null, group: 'nijisanji' },
  { name: '不破湊', channelId: null, group: 'nijisanji' },
  { name: 'イブラヒム', channelId: null, group: 'nijisanji' },
  { name: '加賀美ハヤト', channelId: null, group: 'nijisanji' },
  { name: '壱百満天原サロメ', channelId: null, group: 'nijisanji' },
  { name: '笹木咲', channelId: null, group: 'nijisanji' },
  { name: '椎名唯華', channelId: null, group: 'nijisanji' },
  { name: '月ノ美兎', channelId: null, group: 'nijisanji' },
  { name: 'でびでび・でびる', channelId: null, group: 'nijisanji' },
  { name: '渋谷ハジメ', channelId: null, group: 'nijisanji' },
  { name: 'ローレン・イロアス', channelId: null, group: 'nijisanji' },
  { name: '健屋花那', channelId: null, group: 'nijisanji' },
  { name: '剣持刀也', channelId: null, group: 'nijisanji' },
  { name: 'ジョー・力一', channelId: null, group: 'nijisanji' },
  { name: '三枝明那', channelId: null, group: 'nijisanji' },
  { name: 'レオス・ヴィンセント', channelId: null, group: 'nijisanji' },
  { name: 'ヴォックス・アクマ', channelId: null, group: 'nijisanji' },
  { name: 'ルカ・カネシロ', channelId: null, group: 'nijisanji' },
  { name: '西園チグサ', channelId: null, group: 'nijisanji' },

  // ホロライブ (15)
  { name: '兎田ぺこら', channelId: null, group: 'hololive' },
  { name: '宝鐘マリン', channelId: null, group: 'hololive' },
  { name: '湊あくあ', channelId: null, group: 'hololive' },
  { name: 'さくらみこ', channelId: null, group: 'hololive' },
  { name: '戌神ころね', channelId: null, group: 'hololive' },
  { name: '猫又おかゆ', channelId: null, group: 'hololive' },
  { name: '大空スバル', channelId: null, group: 'hololive' },
  { name: '白上フブキ', channelId: null, group: 'hololive' },
  { name: '星街すいせい', channelId: null, group: 'hololive' },
  { name: '沙花叉クロヱ', channelId: null, group: 'hololive' },
  { name: '角巻わため', channelId: null, group: 'hololive' },
  { name: '大神ミオ', channelId: null, group: 'hololive' },
  { name: '不知火フレア', channelId: null, group: 'hololive' },
  { name: '雪花ラミィ', channelId: null, group: 'hololive' },
  { name: '桃鈴ねね', channelId: null, group: 'hololive' },

  // ぶいすぽっ! (15)
  { name: '一ノ瀬うるは', channelId: null, group: 'vspo' },
  { name: '橘ひなの', channelId: null, group: 'vspo' },
  { name: '英リサ', channelId: null, group: 'vspo' },
  { name: '藍沢エマ', channelId: null, group: 'vspo' },
  { name: '八雲べに', channelId: null, group: 'vspo' },
  { name: '神成きゅぴ', channelId: null, group: 'vspo' },
  { name: '紫宮るな', channelId: null, group: 'vspo' },
  { name: '花芽すみれ', channelId: null, group: 'vspo' },
  { name: '花芽なずな', channelId: null, group: 'vspo' },
  { name: '兎咲ミミ', channelId: null, group: 'vspo' },
  { name: '空澄セナ', channelId: null, group: 'vspo' },
  { name: '小雀とと', channelId: null, group: 'vspo' },
  { name: '白波らむね', channelId: null, group: 'vspo' },
  { name: '如月れん', channelId: null, group: 'vspo' },
  { name: '夢野あかり', channelId: null, group: 'vspo' },

  // ネオポルテ (5)
  { name: '柊ツルギ', channelId: null, group: 'neoporte' },
  { name: '叶神あかり', channelId: null, group: 'neoporte' },
  { name: '愛宮みるく', channelId: null, group: 'neoporte' },
  { name: '白雪レイド', channelId: null, group: 'neoporte' },
  { name: '獅子神レオナ', channelId: null, group: 'neoporte' },

  // ストリーマー / ゲーム実況 (20)
  { name: '加藤純一', channelId: null, group: 'streamer' },
  { name: 'もこう', channelId: null, group: 'streamer' },
  { name: '兄者弟者', channelId: null, group: 'streamer' },
  { name: '釈迦', channelId: null, group: 'streamer' },
  { name: 'StylishNoob', channelId: null, group: 'streamer' },
  { name: 'SHAKA', channelId: null, group: 'streamer' },
  { name: 'ありさか', channelId: null, group: 'streamer' },
  { name: 'ボドカ', channelId: null, group: 'streamer' },
  { name: 'k4sen', channelId: null, group: 'streamer' },
  { name: '関優太', channelId: null, group: 'streamer' },
  { name: 'スタヌ', channelId: null, group: 'streamer' },
  { name: 'うるか', channelId: null, group: 'streamer' },
  { name: 'だるまいずごっど', channelId: null, group: 'streamer' },
  { name: '渋谷ハル', channelId: null, group: 'streamer' },
  { name: 'ta1yo', channelId: null, group: 'streamer' },
  { name: 'ぶゅりる', channelId: null, group: 'streamer' },
  { name: 'ぎぞく', channelId: null, group: 'streamer' },
  { name: 'gorou', channelId: null, group: 'streamer' },
  { name: 'Selly', channelId: null, group: 'streamer' },
  { name: '蛇足', channelId: null, group: 'streamer' },
];

// Idempotent diff-merge:
//   - Names already in creators.json: kept as-is (channelId / order
//     preserved). If the existing entry's group is null and the seed
//     names a group, we backfill that single field both in the JSON
//     file and in the DB row.
//   - Names in SEED_CREATORS but not in existing: appended at the end
//     (preserving the user's hand-edited ordering at the front).
//
// Run once at app startup. Replaces the older `seedCreatorsIfEmpty`
// — that was sufficient for first install but couldn't merge in a
// later seed expansion (40 → 75) without losing the channelIds the
// user had already resolved.
export async function seedOrUpdateCreators(): Promise<void> {
  const existing = await loadCreatorList();
  const existingByName = new Map(existing.map((c) => [c.name, c] as const));

  let backfilled = 0;
  for (const seed of SEED_CREATORS) {
    const cur = existingByName.get(seed.name);
    if (!cur) continue;
    if (cur.group === null && seed.group !== null) {
      cur.group = seed.group;
      setCreatorGroupIfNull(seed.name, seed.group);
      backfilled += 1;
    }
  }

  const toAdd = SEED_CREATORS.filter((c) => !existingByName.has(c.name));

  if (toAdd.length === 0 && backfilled === 0) {
    logInfo(`creators already populated (${existing.length}) — no seed delta`);
  } else if (toAdd.length > 0) {
    logInfo(
      `seed delta: +${toAdd.length} new creators ` +
        `(was ${existing.length}, now ${existing.length + toAdd.length})` +
        (backfilled > 0 ? `, backfilled group on ${backfilled}` : ''),
    );
    for (const c of toAdd) {
      upsertCreator(c.name, c.channelId, true, c.group);
    }
    const merged: CreatorEntry[] = [...existing, ...toAdd];
    await saveCreatorList(merged);
  } else if (backfilled > 0) {
    logInfo(`seed delta: backfilled group on ${backfilled} existing creators`);
    await saveCreatorList(existing);
  }

  // Last-mile DB consistency check — runs unconditionally each
  // startup. Even if creators.json claims everything is in sync, the
  // DB may have rows whose group drifted (e.g., a per-creator-search
  // insert that ran the legacy 3-arg upsertCreator path before the
  // seed step). This sweep forces every seed name's DB row to match
  // the literal SEED_CREATORS group. No-op when already consistent.
  const reseeded = reseedGroupsForExistingCreators();
  if (reseeded > 0) {
    logInfo(`reseed: corrected creator_group on ${reseeded} existing creator(s)`);
  }
}

// Force-update creator_group for any existing DB row whose name
// matches a SEED_CREATORS entry but whose group is null or differs
// from the literal seed group. Returns number of rows changed. Safe
// to call repeatedly (no-op when everything's already in sync).
//
// Why this exists: per-creator search hits previously called the
// 3-arg `upsertCreator(name, channelId, isTarget)` path which left
// `creator_group` at the column default (NULL) when the row had to be
// inserted (= seed step hadn't yet populated the DB row, e.g. after
// an inconsistent state between creators.json and the DB). This
// sweep is the canonical source-of-truth alignment.
export function reseedGroupsForExistingCreators(): number {
  const conn = openDb();
  const stmt = conn.prepare(
    `UPDATE creators
       SET creator_group = ?
     WHERE name = ?
       AND (creator_group IS NULL OR creator_group != ?)
       AND is_target = 1`,
  );
  let total = 0;
  for (const seed of SEED_CREATORS) {
    if (!seed.group) continue;
    const result = stmt.run(seed.group, seed.name, seed.group);
    if (result.changes > 0) {
      logInfo(`reseed group: "${seed.name}" → ${seed.group}`);
      total += result.changes;
    }
  }
  return total;
}

// Fill in `channelId` for any creator that is still null. Called at
// the start of each batch — runs API only when there is something to
// resolve, so the steady-state cost is zero.
//
// Cost: 100 quota units per unresolved creator (search.list with
// type=channel). 75 creators × 100u = 7,500u worst case (first batch
// after full seed), well under the 500K daily budget across 50 keys.
// Result is persisted to creators.json + DB so the lookup is one-shot.
//
// 0-hit names trigger a WARN to collection.log so the user can spot
// typos / outdated handles (especially for fluid groups like
// neoporte) by checking the API management → 収集ログ tab.
export async function resolveCreatorChannelIds(): Promise<number> {
  const list = await loadCreatorList();
  let resolved = 0;
  let dirty = false;
  for (const c of list) {
    if (c.channelId) continue;
    const hit = await searchChannelByName(c.name);
    if (!hit) {
      logWarn(
        `creator "${c.name}" のチャンネル検索ヒットなし — 表記揺れ / ` +
          `脱退 / 改名の可能性。creators.json を見直してください` +
          (c.group ? ` (group=${c.group})` : ''),
      );
      continue;
    }
    c.channelId = hit.channelId;
    upsertCreator(c.name, hit.channelId, true, c.group);
    resolved += 1;
    dirty = true;
    logInfo(`resolved channelId for ${c.name} → ${hit.channelId}`);
  }
  if (dirty) await saveCreatorList(list);
  return resolved;
}

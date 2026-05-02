import { loadCreatorList, saveCreatorList, type CreatorEntry } from './creatorList';
import { upsertCreator } from './database';
import { searchChannelByName } from './youtubeApi';
import { logInfo, logWarn } from './logger';

// Seed list curated 2026-05-03 by the user. 40 creators across three
// affiliation groups, used as the starting target list for Phase 1
// data collection. The user can still add / remove via the Settings
// UI; the seed only fires when creators.json is empty (idempotent).
//
// channelId is resolved lazily on the first batch via
// resolveCreatorChannelIds() — keeping the seed list literal here lets
// us ship without a network round-trip at install time.
export const SEED_CREATORS: readonly CreatorEntry[] = [
  // にじさんじ (15)
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

  // ホロライブ (10)
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

  // ストリーマー / ゲーム実況 (15)
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
];

// Idempotent: only seeds when creators.json is empty. Existing user
// installs (who already added creators by hand) are left alone. Run
// once at app startup, before the data-collection manager touches the
// list.
export async function seedCreatorsIfEmpty(): Promise<void> {
  const existing = await loadCreatorList();
  if (existing.length > 0) {
    logInfo(`creators already populated (${existing.length}) — skipping seed`);
    return;
  }
  logInfo(`seeding creators.json with ${SEED_CREATORS.length} entries`);
  await saveCreatorList([...SEED_CREATORS]);
  // Also seed the DB so per-creator queries can attribute videos to
  // the correct creator_id even before the first search.list response
  // comes back.
  for (const c of SEED_CREATORS) {
    upsertCreator(c.name, c.channelId, true, c.group);
  }
}

// Fill in `channelId` for any creator that is still null. Called at
// the start of each batch — runs API only when there is something to
// resolve, so the steady-state cost is zero.
//
// Cost: 100 quota units per unresolved creator (search.list with
// type=channel). 40 creators × 100u = 4,000u, well under the 10,000u
// daily budget per key. Result is persisted to creators.json + DB so
// the lookup is one-shot.
export async function resolveCreatorChannelIds(): Promise<number> {
  const list = await loadCreatorList();
  let resolved = 0;
  let dirty = false;
  for (const c of list) {
    if (c.channelId) continue;
    const hit = await searchChannelByName(c.name);
    if (!hit) {
      logWarn(`channel id not resolved for creator "${c.name}"`);
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

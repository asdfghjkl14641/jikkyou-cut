export type ReactionCategory =
  | 'laugh'      // 笑い
  | 'surprise'   // 驚き
  | 'emotion'    // 感動
  | 'praise'     // 称賛
  | 'death'      // 死亡 / 失敗(ゲーム実況)
  | 'victory'    // 勝利 / 成功
  | 'scream'     // 叫び / 大声
  | 'flag'       // フラグ / 察し
  | 'other';     // その他

export type CategorizedKeyword = {
  pattern: string;
  category: ReactionCategory;
};

// Hard-coded reaction keyword dictionary, expanded for game-streaming
// vocabulary (death / victory / scream / flag) on top of the original
// generic four (laugh / surprise / emotion / praise) + other.
//
// Order in the source list is purely for readability. The regex-matching
// helpers iterate the length-desc sorted view so longer patterns are
// tried first ("死んだ" before "死"), but we still count every hit per
// the project's scoring policy ("count all", not "first match wins").
export const REACTION_KEYWORDS: CategorizedKeyword[] = [
  // 笑い (laugh)
  { pattern: 'wwwwwwww', category: 'laugh' },
  { pattern: 'wwwwww', category: 'laugh' },
  { pattern: 'wwww', category: 'laugh' },
  { pattern: 'www', category: 'laugh' },
  { pattern: 'ww', category: 'laugh' },
  { pattern: '草', category: 'laugh' },
  { pattern: '笑', category: 'laugh' },
  { pattern: '爆笑', category: 'laugh' },

  // 驚き (surprise)
  { pattern: 'やばすぎ', category: 'surprise' },
  { pattern: 'ヤバすぎ', category: 'surprise' },
  { pattern: 'やばい', category: 'surprise' },
  { pattern: 'ヤバい', category: 'surprise' },
  { pattern: 'やば', category: 'surprise' },
  { pattern: 'えぐい', category: 'surprise' },

  // 感動 (emotion)
  { pattern: '泣ける', category: 'emotion' },
  { pattern: '感動', category: 'emotion' },

  // 称賛 (praise)
  { pattern: 'すごすぎ', category: 'praise' },
  { pattern: 'すげー', category: 'praise' },
  { pattern: 'すげぇ', category: 'praise' },
  { pattern: 'すごい', category: 'praise' },
  { pattern: 'すご', category: 'praise' },
  { pattern: '神回', category: 'praise' },
  { pattern: '神プレイ', category: 'praise' },
  { pattern: '神', category: 'praise' },
  { pattern: 'うますぎ', category: 'praise' },
  { pattern: 'うまい', category: 'praise' },
  { pattern: 'うま', category: 'praise' },
  { pattern: '88888888', category: 'praise' },
  { pattern: '888888', category: 'praise' },
  { pattern: '8888', category: 'praise' },
  { pattern: '888', category: 'praise' },
  { pattern: '88', category: 'praise' },

  // 死亡 / 失敗 (death) — game streaming
  { pattern: '死んだ', category: 'death' },
  { pattern: '死亡', category: 'death' },
  { pattern: 'やられた', category: 'death' },
  { pattern: '終わった', category: 'death' },
  { pattern: '詰んだ', category: 'death' },
  { pattern: 'ざまぁ', category: 'death' },
  { pattern: '事故', category: 'death' },
  { pattern: 'ミス', category: 'death' },
  { pattern: 'やらかした', category: 'death' },

  // 勝利 / 成功 (victory)
  { pattern: '勝った', category: 'victory' },
  { pattern: '勝利', category: 'victory' },
  { pattern: '完勝', category: 'victory' },
  { pattern: 'クラッチ', category: 'victory' },
  { pattern: 'ナイス', category: 'victory' },
  { pattern: 'ファインプレー', category: 'victory' },
  { pattern: 'gg', category: 'victory' },
  { pattern: 'GG', category: 'victory' },

  // 叫び / 大声 (scream)
  { pattern: 'あああ', category: 'scream' },
  { pattern: 'ぎゃあ', category: 'scream' },
  { pattern: 'うわあ', category: 'scream' },
  { pattern: 'ぴえん', category: 'scream' },

  // フラグ / 察し (flag) — viewer foreshadowing reactions
  { pattern: '死亡フラグ', category: 'flag' },
  { pattern: 'これは死ぬ', category: 'flag' },
  { pattern: '終わったな', category: 'flag' },
  { pattern: 'フラグ', category: 'flag' },
  { pattern: '察し', category: 'flag' },
  { pattern: 'これは', category: 'flag' },

  // その他 (other)
  { pattern: '初見', category: 'other' },
  { pattern: 'おつ', category: 'other' },
];

const ALL_CATEGORIES: readonly ReactionCategory[] = [
  'laugh',
  'surprise',
  'emotion',
  'praise',
  'death',
  'victory',
  'scream',
  'flag',
  'other',
] as const;

const ZERO_COUNTS = (): Record<ReactionCategory, number> => ({
  laugh: 0,
  surprise: 0,
  emotion: 0,
  praise: 0,
  death: 0,
  victory: 0,
  scream: 0,
  flag: 0,
  other: 0,
});

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sort by pattern length descending so longer patterns are tried first.
// We still count every match (a single "死亡フラグ" comment registers
// hits in flag *and* death *and* surprise — by design, per the
// project's "count all" policy), so this ordering is mostly cosmetic
// for the iteration log; it also matches the policy stated in the
// design doc.
const SORTED_KEYWORDS: CategorizedKeyword[] = [...REACTION_KEYWORDS].sort(
  (a, b) => b.pattern.length - a.pattern.length,
);

/**
 * Counts keyword hits broken down by category.
 */
export function countKeywordHitsByCategory(
  text: string,
): Record<ReactionCategory, number> {
  const result = ZERO_COUNTS();
  if (!text) return result;

  for (const { pattern, category } of SORTED_KEYWORDS) {
    const matches = text.match(new RegExp(escapeRegex(pattern), 'g'));
    if (matches) {
      result[category] += matches.length;
    }
  }

  return result;
}

/**
 * Counts every match of any reaction keyword in `text`.
 */
export function countKeywordHits(text: string): number {
  const byCategory = countKeywordHitsByCategory(text);
  let total = 0;
  for (const c of ALL_CATEGORIES) total += byCategory[c];
  return total;
}

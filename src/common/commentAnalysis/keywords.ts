// Hard-coded reaction keyword dictionary for the score's keyword-hit
// component. Future work: let the user edit this per-video / per-channel.
//
// Order matters: longer keywords are listed first so that "8888" is
// counted as one hit, not two overlapping `88` matches. We don't bother
// with fancy n-gram suppression — duplicate hits from `88` overlap end
// up netting roughly the right "intensity" anyway.
export const REACTION_KEYWORDS: readonly string[] = [
  // 拍手・歓声(数字パターンは長い順)
  '88888888', '888888', '8888', '888', '88',
  // 笑い(長い順)
  'wwwwwwww', 'wwwwww', 'wwww', 'www', 'ww',
  '草', '笑', '爆笑',
  // 驚き / 称賛
  'やばすぎ', 'ヤバすぎ', 'やばい', 'ヤバい', 'やば',
  'すごすぎ', 'すげー', 'すげぇ', 'すごい', 'すご',
  '神回', '神プレイ', '神',
  'うますぎ', 'うまい', 'うま',
  // 感動 / 衝撃
  '泣ける', '感動', 'えぐい', 'ぱねぇ',
  // ゲーム実況系
  'ファインプレー', 'ナイス', 'クラッチ',
  // 配信特有
  '初見', 'おつ',
];

// Pre-compiled regex (anchored per-keyword) so we don't re-allocate on
// every chat message. Escaping handles the few regex-meta chars
// ("888" / "www" are alphanumeric, so this is mostly a safety net).
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REACTION_REGEX = new RegExp(REACTION_KEYWORDS.map(escape).join('|'), 'g');

/**
 * Counts every match of any reaction keyword in `text`. Multiple
 * occurrences are counted (e.g. "草草草" returns 3). Use the same token
 * set across all messages for consistent scoring.
 */
export function countKeywordHits(text: string): number {
  if (!text) return 0;
  const m = text.match(REACTION_REGEX);
  return m ? m.length : 0;
}

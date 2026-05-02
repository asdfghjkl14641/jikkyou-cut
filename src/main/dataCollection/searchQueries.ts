// Broad search queries — fired with relevance/viewCount sort to grab the
// "what's trending in 切り抜き" pool. Per-creator queries come from
// creatorList.ts.
//
// Curated per the project spec; the user can reach in here to tweak
// without rebuilding any infrastructure.
export const BROAD_QUERIES: readonly string[] = [
  '【切り抜き】',
  'クリップ',
  '神回 切り抜き',
  '面白い場面 切り抜き',
  'ゲーム実況 切り抜き',
  'マイクラ 切り抜き',
  'APEX 切り抜き',
  'ストリートファイター 切り抜き',
  'VTuber 切り抜き',
  'にじさんじ 切り抜き',
  'ホロライブ 切り抜き',
] as const;

// Search-list options used everywhere. We don't randomise per-call;
// stable ordering means the dedup-against-existing-DB filter does the
// "skip what we've seen" work efficiently.
export const SEARCH_DEFAULTS = {
  maxResultsPerQuery: 50,    // YouTube cap
  // 'relevance' first because viewCount-only would be dominated by the
  // same handful of evergreen mega-clips. Mixing relevance gives the
  // newer / more niche videos a chance.
  order: 'relevance' as const,
  regionCode: 'JP',
  relevanceLanguage: 'ja',
} as const;

export function buildPerCreatorQuery(creatorName: string): string {
  return `${creatorName} 切り抜き`;
}

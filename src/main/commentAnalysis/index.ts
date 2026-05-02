import type {
  CommentAnalysis,
  CommentAnalysisProgress,
  CommentAnalysisStartArgs,
} from '../../common/types';
import { fetchChatReplay, cancelChatReplay } from './chatReplay';
import { fetchViewerStats } from './viewerStats';
import { calculateScores } from './scoring';

/**
 * Runs the full comment-analysis pipeline:
 *   1. Chat replay via yt-dlp (YouTube live_chat or Twitch rechat)
 *   2. Viewer-count time series via playboard.co (YouTube only)
 *   3. Bucket aggregation + 3-element weighted score
 *
 * Stages are sequential — playboard's HTML scrape is slow enough that
 * doing it in parallel with yt-dlp doesn't help much, and serial logs
 * are easier to debug. Both data fetches are cached after first run.
 *
 * `onProgress` fires three times: phase = 'chat' / 'viewers' / 'scoring',
 * each at percent=0 then 100. The renderer uses these to swap labels
 * ("チャット取得中…" / "視聴者数取得中…" / "スコア計算中…").
 *
 * Failure modes are absorbed at each stage:
 *   - chat = [] → buckets all have commentCount=0 (uninteresting graph but
 *     completes without throwing)
 *   - viewers.source === 'unavailable' → scoring switches to 2-element
 *     weights (density + keyword), viewerGrowth row dimmed in tooltip
 */
export async function analyzeComments(
  args: CommentAnalysisStartArgs,
  onProgress: (p: CommentAnalysisProgress) => void,
): Promise<CommentAnalysis> {
  console.log(
    `[comment-analysis] start url=${args.sourceUrl} duration=${args.durationSec.toFixed(1)}s`,
  );
  onProgress({ phase: 'chat', percent: 0 });
  const messages = await fetchChatReplay(args.sourceUrl);
  console.log(`[comment-analysis] chat: ${messages.length} messages`);
  onProgress({ phase: 'chat', percent: 100 });

  onProgress({ phase: 'viewers', percent: 0 });
  const viewers = await fetchViewerStats(args.sourceUrl);
  console.log(
    `[comment-analysis] viewers: source=${viewers.source} samples=${viewers.samples.length}`,
  );
  onProgress({ phase: 'viewers', percent: 100 });

  onProgress({ phase: 'scoring', percent: 0 });
  const analysis = calculateScores({
    messages,
    viewers,
    durationSec: args.durationSec,
  });
  console.log(
    `[comment-analysis] scoring done: ${analysis.samples.length} buckets, hasViewerStats=${analysis.hasViewerStats}`,
  );
  onProgress({ phase: 'scoring', percent: 100 });

  return analysis;
}

export async function cancelAnalysis(): Promise<void> {
  // Only the chat fetch has a kill-able child process. The playboard
  // fetch is a single fetch() call that finishes within seconds; we let
  // it run to completion rather than complicating with AbortController.
  await cancelChatReplay();
}

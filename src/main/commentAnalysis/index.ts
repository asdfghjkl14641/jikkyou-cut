import type {
  CommentAnalysis,
  CommentAnalysisProgress,
  CommentAnalysisStartArgs,
} from '../../common/types';
import type { YtdlpCookiesBrowser } from '../../common/config';
import { fetchChatReplay, cancelChatReplay } from './chatReplay';
import { fetchViewerStats } from './viewerStats';
import { analyze } from './scoring';

export type AnalyzeCommentsOptions = {
  // Forwarded to yt-dlp's chat replay fetch (YouTube only — Twitch
  // routes through GraphQL and ignores all cookie fields for now).
  // 'none' keeps anonymous behaviour; the user opts in via
  // SettingsDialog when YouTube's bot detection blocks the anonymous
  // path.
  cookiesBrowser: YtdlpCookiesBrowser;
  // Manual cookies.txt paths. Priority is platform-specific > generic
  // > browser — see urlDownload.getCookiesArgs.
  cookiesFile: string | null;
  cookiesFileYoutube: string | null;
  cookiesFileTwitch: string | null;
};

/**
 * Runs the full comment-analysis pipeline:
 *   1. Chat replay via yt-dlp (YouTube live_chat or Twitch rechat)
 *   2. Viewer-count time series via playboard.co (YouTube only)
 *   3. Bucket aggregation (Stage 1). Rolling-window scoring runs in the
 *      renderer so the user can move the W slider without an IPC round-trip.
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
 *   - viewers.source === 'unavailable' → renderer switches to the
 *     no-viewer weight set (retention drops out, density/keyword absorb
 *     its share)
 */
export async function analyzeComments(
  args: CommentAnalysisStartArgs,
  onProgress: (p: CommentAnalysisProgress) => void,
  options: AnalyzeCommentsOptions,
): Promise<CommentAnalysis> {
  console.log('[comment-debug] analyzeComments entry, full args:', JSON.stringify(args));
  console.log(
    `[comment-debug] sourceUrl resolved: ${args.sourceUrl} (typeof=${typeof args.sourceUrl})`,
  );
  console.log(
    `[comment-analysis] start url=${args.sourceUrl} duration=${args.durationSec.toFixed(1)}s, ` +
      `cookiesBrowser=${options.cookiesBrowser}, cookiesFile=${options.cookiesFile ?? '<none>'}, ` +
      `cookiesFileYT=${options.cookiesFileYoutube ?? '<none>'}, cookiesFileTW=${options.cookiesFileTwitch ?? '<none>'}`,
  );
  onProgress({ phase: 'chat', percent: 0 });
  const messages = await fetchChatReplay(args.sourceUrl, {
    cookiesBrowser: options.cookiesBrowser,
    cookiesFile: options.cookiesFile,
    cookiesFileYoutube: options.cookiesFileYoutube,
    cookiesFileTwitch: options.cookiesFileTwitch,
  });
  console.log(`[comment-debug] fetchChatReplay returned: ${messages.length} messages`);
  console.log(`[comment-analysis] chat: ${messages.length} messages`);
  onProgress({ phase: 'chat', percent: 100 });

  onProgress({ phase: 'viewers', percent: 0 });
  const viewers = await fetchViewerStats(args.sourceUrl);
  console.log(
    `[comment-debug] fetchViewerStats returned: source=${viewers.source}, samples=${viewers.samples.length}`,
  );
  console.log(
    `[comment-analysis] viewers: source=${viewers.source} samples=${viewers.samples.length}`,
  );
  onProgress({ phase: 'viewers', percent: 100 });

  onProgress({ phase: 'scoring', percent: 0 });
  const analysis = analyze({
    messages,
    viewers,
    durationSec: args.durationSec,
  });
  console.log(
    `[comment-debug] analyze() done: buckets=${analysis.buckets.length}, allMessages=${analysis.allMessages.length}`,
  );
  console.log(
    `[comment-analysis] bucketize done: ${analysis.buckets.length} buckets, hasViewerStats=${analysis.hasViewerStats}`,
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

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ViewerStats, ViewerSample } from '../../common/types';
import { extractVideoId } from './chatReplay';

const cacheDir = (): string => path.join(app.getPath('userData'), 'comment-analysis');
const cacheFile = (videoId: string): string =>
  path.join(cacheDir(), `${videoId}-viewers.json`);

async function readCache(videoId: string): Promise<ViewerStats | null> {
  try {
    const raw = await fs.readFile(cacheFile(videoId), 'utf8');
    const parsed = JSON.parse(raw) as ViewerStats;
    if (!parsed || !Array.isArray(parsed.samples)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(videoId: string, stats: ViewerStats): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cacheFile(videoId), JSON.stringify(stats), 'utf8');
}

const PLAYBOARD_URL = (videoId: string) =>
  `https://playboard.co/en/video/${videoId}`;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Walk an arbitrary JSON tree looking for a leaf array of {time, count}-
// shaped objects. playboard's hydration shape isn't documented and tends
// to be bumped — pattern-matching by shape is more durable than hardcoding
// a path. We accept several common field names for "time" and "count"
// because past page versions have used different ones (`time` / `t` /
// `timeSec` / `offsetSec` for x-axis; `count` / `viewers` / `value` /
// `concurrent` for y-axis).
const TIME_KEYS = ['time', 't', 'timeSec', 'offsetSec', 'sec', 'second', 'x'] as const;
const COUNT_KEYS = ['count', 'viewers', 'value', 'concurrent', 'y', 'viewerCount'] as const;

type AnyJson = unknown;

function pickField(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function looksLikeViewerSeries(arr: unknown[]): ViewerSample[] | null {
  if (arr.length < 4) return null; // too short to be useful series
  const out: ViewerSample[] = [];
  for (const entry of arr) {
    if (entry == null || typeof entry !== 'object') return null;
    const o = entry as Record<string, unknown>;
    const t = pickField(o, TIME_KEYS);
    const c = pickField(o, COUNT_KEYS);
    if (t == null || c == null) return null;
    out.push({ timeSec: t, count: c });
  }
  // Heuristic: monotone-ish time axis (allow noise, but mostly increasing).
  // A series that's actually e.g. `[{x: 0, y: 1}, {x: 100, y: 2}, ...]`
  // satisfies this; random unrelated objects don't.
  let increasing = 0;
  for (let i = 1; i < out.length; i += 1) {
    if (out[i]!.timeSec >= out[i - 1]!.timeSec) increasing += 1;
  }
  if (increasing < out.length * 0.7) return null;
  return out;
}

function findViewerSeriesInTree(node: AnyJson): ViewerSample[] | null {
  if (Array.isArray(node)) {
    const matched = looksLikeViewerSeries(node);
    if (matched) return matched;
    for (const child of node) {
      const found = findViewerSeriesInTree(child);
      if (found) return found;
    }
    return null;
  }
  if (node != null && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const found = findViewerSeriesInTree(v);
      if (found) return found;
    }
  }
  return null;
}

// Pull the JSON payload out of the page. We try, in order:
//   1. <script id="__NEXT_DATA__" type="application/json">…</script>
//      (Next.js standard)
//   2. window.__NUXT__ = (…)              (Nuxt fallback)
//   3. Any <script type="application/json"> with the right shape inside
function extractHydrationJson(html: string): AnyJson | null {
  const nextData = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (nextData?.[1]) {
    try {
      return JSON.parse(nextData[1]);
    } catch {
      /* fall through */
    }
  }
  const nuxt = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?);<\/script>/);
  if (nuxt?.[1]) {
    try {
      return JSON.parse(nuxt[1]);
    } catch {
      /* fall through */
    }
  }
  // Any JSON-looking <script type="application/json">.
  const jsonScripts = html.matchAll(
    /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  );
  for (const m of jsonScripts) {
    if (!m[1]) continue;
    try {
      return JSON.parse(m[1]);
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

async function fetchPlayboardHtml(videoId: string): Promise<string | null> {
  // Use Node 20+'s built-in fetch (Electron 33 ships Node 20.x).
  try {
    const res = await fetch(PLAYBOARD_URL(videoId), {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        // Plain browser-like Accept; some sites 4xx without it.
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      console.warn(`[viewer-stats] playboard returned HTTP ${res.status} for ${videoId}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn('[viewer-stats] playboard fetch failed:', err);
    return null;
  }
}

/**
 * Returns viewer-count time-series for the given source URL, or
 * `{ source: 'unavailable' }` when playboard has no data / blocks the
 * request / the page changed structure. Cached at
 * `userData/comment-analysis/<videoId>-viewers.json` (infinite TTL —
 * archived viewer data doesn't change).
 *
 * Never throws for "no data" cases — orchestrator is expected to switch
 * to 2-element scoring when source === 'unavailable'.
 */
export async function fetchViewerStats(url: string): Promise<ViewerStats> {
  const meta = extractVideoId(url);
  const fallback: ViewerStats = {
    samples: [],
    source: 'unavailable',
    fetchedAt: new Date().toISOString(),
  };

  if (!meta) return fallback;

  const cached = await readCache(meta.id);
  if (cached) {
    console.log(
      `[viewer-stats] cache hit ${meta.id}: ${cached.samples.length} samples (${cached.source})`,
    );
    return cached;
  }

  // Twitch isn't covered by playboard. Skip the fetch entirely rather
  // than wasting a roundtrip.
  if (meta.platform !== 'youtube') {
    await writeCache(meta.id, fallback);
    return fallback;
  }

  const html = await fetchPlayboardHtml(meta.id);
  if (!html) {
    // Don't cache the empty failure — playboard may block transiently;
    // leaving cache absent allows a retry on next analysis.
    return fallback;
  }

  const tree = extractHydrationJson(html);
  if (!tree) {
    console.warn(`[viewer-stats] no hydration JSON found in playboard page ${meta.id}`);
    return fallback;
  }

  const samples = findViewerSeriesInTree(tree);
  if (!samples || samples.length === 0) {
    console.warn(
      `[viewer-stats] hydration JSON present but no viewer series matched for ${meta.id}`,
    );
    return fallback;
  }

  const stats: ViewerStats = {
    samples,
    source: 'playboard',
    fetchedAt: new Date().toISOString(),
  };
  console.log(`[viewer-stats] playboard ${meta.id}: ${samples.length} samples`);
  await writeCache(meta.id, stats);
  return stats;
}

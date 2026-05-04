import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './database';
import type { PatternAnalysisResult } from '../../common/types';

// Phase 2a — pattern analysis. Reads accumulated videos / heatmap data
// and emits per-creator + per-group JSON snapshots that downstream
// (M1.5b) will fold into the AI auto-extract prompt. Synchronous via
// better-sqlite3; the queries are ms-scale at the current data volume
// (75 creators × ~hundreds of videos), so no event-loop yields needed.
//
// What we compute (simplified scope agreed for M1):
//   - titlePatterns: frequentKeywords / lengthDist / emojiUsage
//   - durationPatterns: p10 / p50 / p90 of video duration
//   - peakLocationPatterns: rank-1 heatmap peak location bucket ratios
//
// Deliberately NOT here: viewVelocity, thumbnailPatterns,
// chapterPatterns, topVideos. They land in later phases.

// Below this many videos for a given creator, the JSON would be too
// noisy (e.g. 5 videos × "発狂" = 100% — meaningless). Group-level
// JSON has no such gate (always plenty of samples across a group).
const MIN_SAMPLES_FOR_CREATOR_PATTERN = 20;
const TOP_KEYWORD_COUNT = 10;
const MIN_TOKEN_LEN = 2;

// Tokenization is dumb-split on whitespace + Japanese/ASCII punctuation.
// MeCab would be more accurate but adds a heavy native dependency for
// marginal benefit at this scale — the AI consumer is robust to noise.
const TOKEN_SPLIT_RE = /[\s　【】「」、。・,.!?！?()()[\]\\/"'`〈〉《》〔〕]+/u;
// Emoji ranges per spec — Emoticons / Misc Symbols & Pictographs +
// Misc Symbols / Dingbats. Captures most decorative usage in clip titles.
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u;

const PEAK_BUCKET_EARLY_END = 0.2;   // [0, 0.2)
const PEAK_BUCKET_MID_END = 0.7;     // [0.2, 0.7)
                                      // [0.7, 1.0] = endingClimax

export type TitlePatterns = {
  frequentKeywords: { word: string; freq: number; viewBoost: number }[];
  lengthDist: { min: number; max: number; median: number; p90: number };
  emojiUsage: number;
};

export type DurationPatterns = {
  p10: number;
  p50: number;
  p90: number;
  definition: string;
};

export type PeakLocationPatterns = {
  earlyHook: number;
  midSpike: number;
  endingClimax: number;
  definition: string;
};

export type CreatorPatterns = {
  creatorName: string;
  creatorGroup: string | null;
  totalAnalyzed: number;
  lastUpdated: string;
  patterns: {
    titlePatterns: TitlePatterns;
    durationPatterns: DurationPatterns;
    peakLocationPatterns: PeakLocationPatterns;
  };
};

export type GroupPatterns = {
  group: string;
  creatorCount: number;
  totalAnalyzed: number;
  lastUpdated: string;
  patterns: {
    titlePatterns: TitlePatterns;
    durationPatterns: DurationPatterns;
    peakLocationPatterns: PeakLocationPatterns;
  };
};

// Cross-creator aggregate. Used as the M1.5b AI-prompt feed —
// "切り抜き動画一般の伸びパターン" without any creator-specific
// bias. Same pattern shape as creator/group; the only difference is
// the SELECT scope (no WHERE filter).
export type GlobalPatterns = {
  totalAnalyzed: number;
  lastUpdated: string;
  patterns: {
    titlePatterns: TitlePatterns;
    durationPatterns: DurationPatterns;
    peakLocationPatterns: PeakLocationPatterns;
  };
};

type VideoSample = {
  id: string;
  title: string;
  duration_sec: number | null;
  view_count: number | null;
};

const SUPPORTED_GROUPS = ['nijisanji', 'hololive', 'vspo', 'neoporte', 'streamer'] as const;

function patternsDir(): string {
  return path.join(app.getPath('userData'), 'patterns');
}

// Replace Windows-forbidden chars. seed creator names are clean today,
// but defending against future user-added names with stray slashes is
// cheap insurance.
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function tokenize(s: string): string[] {
  if (!s) return [];
  return s.split(TOKEN_SPLIT_RE).filter((t) => t.length >= MIN_TOKEN_LEN);
}

// Index-based percentile. For p50 / p90 / p10 on small N this is good
// enough; we're not doing rigorous stats here.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx] ?? 0;
}

function avgViewCount(videos: VideoSample[]): number {
  let sum = 0;
  let n = 0;
  for (const v of videos) {
    if (v.view_count != null) {
      sum += v.view_count;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

function computeTitlePatterns(videos: VideoSample[]): TitlePatterns {
  const totalCount = videos.length;
  const overallAvgView = avgViewCount(videos);

  // word -> set of video ids that contain it (per-video dedup so a
  // word repeated in one title doesn't inflate freq).
  const wordToVideoIds = new Map<string, Set<string>>();
  for (const v of videos) {
    const seen = new Set(tokenize(v.title));
    for (const w of seen) {
      const set = wordToVideoIds.get(w);
      if (set) set.add(v.id);
      else wordToVideoIds.set(w, new Set([v.id]));
    }
  }

  // For each word, freq + view-count uplift relative to the overall
  // average. A word that consistently appears in the highest-viewed
  // videos lights up here even if its absolute freq is modest.
  const entries: { word: string; freq: number; viewBoost: number }[] = [];
  for (const [word, vids] of wordToVideoIds) {
    const containedVideos = videos.filter((v) => vids.has(v.id));
    const avgWith = avgViewCount(containedVideos);
    // No view counts at all (or division by zero): default to 1.0 — a
    // neutral signal that means "no information".
    const viewBoost = overallAvgView > 0 ? avgWith / overallAvgView : 1.0;
    entries.push({
      word,
      freq: vids.size / totalCount,
      viewBoost,
    });
  }
  entries.sort((a, b) => b.freq - a.freq);
  const frequentKeywords = entries.slice(0, TOP_KEYWORD_COUNT).map((e) => ({
    word: e.word,
    freq: roundTo(e.freq, 4),
    viewBoost: roundTo(e.viewBoost, 3),
  }));

  const lengths = videos.map((v) => v.title.length).sort((a, b) => a - b);
  const lengthDist = {
    min: lengths[0] ?? 0,
    max: lengths[lengths.length - 1] ?? 0,
    median: percentile(lengths, 0.5),
    p90: percentile(lengths, 0.9),
  };

  const emojiCount = videos.filter((v) => EMOJI_RE.test(v.title)).length;
  const emojiUsage = totalCount > 0 ? roundTo(emojiCount / totalCount, 4) : 0;

  return { frequentKeywords, lengthDist, emojiUsage };
}

function computeDurationPatterns(videos: VideoSample[]): DurationPatterns {
  const ds = videos
    .map((v) => v.duration_sec)
    .filter((d): d is number => d != null && d > 0)
    .sort((a, b) => a - b);
  return {
    p10: percentile(ds, 0.1),
    p50: percentile(ds, 0.5),
    p90: percentile(ds, 0.9),
    definition: '切り抜き動画の長さ秒',
  };
}

function computePeakLocationPatterns(
  videos: VideoSample[],
  rank1PeakStartByVideo: Map<string, number>,
): PeakLocationPatterns {
  // Denominator = videos that HAVE a rank-1 peak. Per the spec, this
  // is the simpler of the two options ("100% across rank=1-bearing
  // videos" rather than including peak-less videos as zero-everywhere).
  let early = 0, mid = 0, end = 0, denom = 0;
  for (const v of videos) {
    if (!v.duration_sec || v.duration_sec <= 0) continue;
    const peakStart = rank1PeakStartByVideo.get(v.id);
    if (peakStart == null) continue;
    const pos = peakStart / v.duration_sec;
    if (pos < PEAK_BUCKET_EARLY_END) early += 1;
    else if (pos < PEAK_BUCKET_MID_END) mid += 1;
    else end += 1;
    denom += 1;
  }
  return {
    earlyHook: denom > 0 ? roundTo(early / denom, 4) : 0,
    midSpike: denom > 0 ? roundTo(mid / denom, 4) : 0,
    endingClimax: denom > 0 ? roundTo(end / denom, 4) : 0,
    definition: '盛り上がりピーク(rank=1)が動画のどこに来るか',
  };
}

function roundTo(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

// Fetch rank=1 heatmap peak start_sec for a list of video IDs.
// Chunked because SQLite has a max parameter count (~999 default) and
// a single creator can exceed that on rare days.
function rank1PeaksFor(db: Database.Database, videoIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (videoIds.length === 0) return map;
  const CHUNK = 500;
  for (let i = 0; i < videoIds.length; i += CHUNK) {
    const slice = videoIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT video_id, start_sec FROM heatmap_peaks
         WHERE rank = 1 AND video_id IN (${placeholders})`,
      )
      .all(...slice) as Array<{ video_id: string; start_sec: number }>;
    for (const r of rows) map.set(r.video_id, r.start_sec);
  }
  return map;
}

// Cross-creator analysis. SELECT range = all collected videos, no
// WHERE filter. Heatmap peaks likewise unrestricted. Output goes to
// userData/patterns/global.json and is consumed by aiSummary.ts at
// auto-extract time.
function analyzeGlobal(db: Database.Database, lastUpdated: string): GlobalPatterns | null {
  const videos = db
    .prepare('SELECT id, title, duration_sec, view_count FROM videos')
    .all() as VideoSample[];
  if (videos.length === 0) return null;
  const peaks = rank1PeaksFor(db, videos.map((v) => v.id));
  return {
    totalAnalyzed: videos.length,
    lastUpdated,
    patterns: {
      titlePatterns: computeTitlePatterns(videos),
      durationPatterns: computeDurationPatterns(videos),
      peakLocationPatterns: computePeakLocationPatterns(videos, peaks),
    },
  };
}

export function runPatternAnalysis(): PatternAnalysisResult {
  const db = openDb();
  mkdirSync(patternsDir(), { recursive: true });

  const generated: string[] = [];
  let skipped = 0;
  const lastUpdated = new Date().toISOString();

  // ---- Global JSON ---------------------------------------------------------
  // Generated first so failures here surface before the heavier
  // per-creator sweep runs. M1.5b reads this file at auto-extract time.
  const globalPatterns = analyzeGlobal(db, lastUpdated);
  let globalGenerated = false;
  let globalAnalyzed = 0;
  if (globalPatterns) {
    const filePath = path.join(patternsDir(), 'global.json');
    writeFileSync(filePath, JSON.stringify(globalPatterns, null, 2), 'utf8');
    globalGenerated = true;
    globalAnalyzed = globalPatterns.totalAnalyzed;
  }

  // ---- Per-creator JSON ----------------------------------------------------
  const creators = db
    .prepare('SELECT id, name, creator_group FROM creators WHERE is_target = 1')
    .all() as Array<{ id: number; name: string; creator_group: string | null }>;

  for (const c of creators) {
    const videos = db
      .prepare(
        'SELECT id, title, duration_sec, view_count FROM videos WHERE creator_id = ?',
      )
      .all(c.id) as VideoSample[];

    if (videos.length < MIN_SAMPLES_FOR_CREATOR_PATTERN) {
      skipped += 1;
      continue;
    }

    const peaks = rank1PeaksFor(db, videos.map((v) => v.id));
    const cp: CreatorPatterns = {
      creatorName: c.name,
      creatorGroup: c.creator_group,
      totalAnalyzed: videos.length,
      lastUpdated,
      patterns: {
        titlePatterns: computeTitlePatterns(videos),
        durationPatterns: computeDurationPatterns(videos),
        peakLocationPatterns: computePeakLocationPatterns(videos, peaks),
      },
    };
    const filePath = path.join(patternsDir(), `${sanitizeFilename(c.name)}.json`);
    writeFileSync(filePath, JSON.stringify(cp, null, 2), 'utf8');
    generated.push(c.name);
  }

  // ---- Per-group JSON ------------------------------------------------------
  // Independent SELECT — not an aggregation of the per-creator JSONs —
  // so groups with no qualifying-individual creators still get a file.
  const generatedGroups: string[] = [];
  for (const g of SUPPORTED_GROUPS) {
    const videos = db
      .prepare(
        `SELECT v.id, v.title, v.duration_sec, v.view_count
         FROM videos v
         JOIN creators c ON c.id = v.creator_id
         WHERE c.creator_group = ?`,
      )
      .all(g) as VideoSample[];
    if (videos.length === 0) continue;

    const peaks = rank1PeaksFor(db, videos.map((v) => v.id));
    const creatorCount = (db
      .prepare(
        'SELECT COUNT(*) AS n FROM creators WHERE creator_group = ? AND is_target = 1',
      )
      .get(g) as { n: number }).n;

    const gp: GroupPatterns = {
      group: g,
      creatorCount,
      totalAnalyzed: videos.length,
      lastUpdated,
      patterns: {
        titlePatterns: computeTitlePatterns(videos),
        durationPatterns: computeDurationPatterns(videos),
        peakLocationPatterns: computePeakLocationPatterns(videos, peaks),
      },
    };
    const filePath = path.join(patternsDir(), `group_${g}.json`);
    writeFileSync(filePath, JSON.stringify(gp, null, 2), 'utf8');
    generatedGroups.push(g);
  }

  return {
    globalGenerated,
    globalAnalyzed,
    generatedCreators: generated,
    skippedCreators: skipped,
    generatedGroups,
  };
}

import type { TranscriptCue } from './types';

/**
 * A contiguous run of non-deleted cues that the final video will keep.
 * The result preserves any sub-second gaps between adjacent kept cues — the
 * caller (S5 export) decides whether to merge or pad them.
 */
export type KeptRegion = {
  startSec: number;
  endSec: number;
  cueIds: string[];
};

/**
 * Derives the regions of the source video that survive editing. Adjacent
 * kept cues are coalesced into a single region; a deleted cue (or the end of
 * the array) terminates a region.
 */
export function deriveKeptRegions(cues: readonly TranscriptCue[]): KeptRegion[] {
  const regions: KeptRegion[] = [];
  let current: KeptRegion | null = null;

  for (const cue of cues) {
    if (cue.deleted) {
      if (current) {
        regions.push(current);
        current = null;
      }
      continue;
    }
    if (!current) {
      current = {
        startSec: cue.startSec,
        endSec: cue.endSec,
        cueIds: [cue.id],
      };
    } else {
      current.endSec = cue.endSec;
      current.cueIds.push(cue.id);
    }
  }
  if (current) regions.push(current);

  return regions;
}

/**
 * Adjacent kept regions separated by less than this many seconds are treated
 * as one continuous run for preview purposes — the natural sub-second cue
 * boundaries from ASR shouldn't trigger jarring seeks.
 */
const PREVIEW_GAP_TOLERANCE_SEC = 1;

export type SkipDecision =
  | { kind: 'none' }
  | { kind: 'skip'; toSec: number }
  | { kind: 'end' };

/**
 * Decides what to do when playback reaches time `t` in preview mode.
 * Pure function — given the same inputs, returns the same decision.
 *
 *  - `none`: `t` is inside a kept region, or in a small gap (< tolerance).
 *  - `skip`: `t` is in a deletion gap; jump to `toSec` (next kept start).
 *  - `end` : `t` is past the last kept region (or there are no regions).
 */
export function decidePreviewSkip(
  t: number,
  regions: readonly KeptRegion[],
): SkipDecision {
  if (regions.length === 0) return { kind: 'end' };

  // Find the first region whose end is past `t`.
  let i = 0;
  while (i < regions.length) {
    const r = regions[i];
    if (r != null && r.endSec > t) break;
    i += 1;
  }

  if (i >= regions.length) return { kind: 'end' };

  const next = regions[i]!;
  if (t >= next.startSec) {
    // Inside `next`.
    return { kind: 'none' };
  }

  // `t` sits in a gap before `next`. Decide whether the gap is small enough
  // to play through without seeking (avoids ugly micro-jumps at cue
  // boundaries from ASR).
  const prevEnd = i > 0 ? regions[i - 1]!.endSec : 0;
  const gapWidth = next.startSec - prevEnd;
  if (gapWidth < PREVIEW_GAP_TOLERANCE_SEC) {
    return { kind: 'none' };
  }
  return { kind: 'skip', toSec: next.startSec };
}

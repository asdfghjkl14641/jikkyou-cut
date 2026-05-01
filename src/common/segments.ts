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
 * 
 * If `durationSec` is provided, silence at the beginning (0 to first cue)
 * and end (last cue to duration) are automatically included as kept regions.
 */
export function deriveKeptRegions(
  cues: readonly TranscriptCue[],
  durationSec?: number | null,
): KeptRegion[] {
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

  // Apply silence fixes if we have cues
  if (cues.length > 0) {
    const firstCue = cues[0];
    // 1. Front silence (0 to first cue)
    if (firstCue && firstCue.startSec > 0) {
      const first = regions[0];
      if (first && first.startSec === firstCue.startSec) {
        // First kept region starts exactly at the first cue -> extend it to 0
        first.startSec = 0;
      } else {
        // First cue was deleted, or no cues kept -> prepend a silence region
        regions.unshift({
          startSec: 0,
          endSec: firstCue.startSec,
          cueIds: [],
        });
      }
    }

    // 2. Trailing silence (last cue to duration)
    const lastCue = cues[cues.length - 1];
    if (durationSec != null && lastCue && durationSec > lastCue.endSec) {
      const last = regions[regions.length - 1];
      if (last && last.endSec === lastCue.endSec) {
        // Last kept region ends exactly at the last cue -> extend it to duration
        last.endSec = durationSec;
      } else {
        // Last cue was deleted, or no cues kept -> append a silence region
        regions.push({
          startSec: lastCue.endSec,
          endSec: durationSec,
          cueIds: [],
        });
      }
    }
  } else if (durationSec != null && durationSec > 0) {
    // No cues at all -> keep the entire video
    regions.push({
      startSec: 0,
      endSec: durationSec,
      cueIds: [],
    });
  }

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

/**
 * Picks the cue index that best represents `currentSec` for both scroll
 * targeting AND playback highlighting. The list always wants *some* row
 * marked as "current" while a video file is loaded — having no marker at
 * all in cue-gap silences leaves the user wondering where playback is.
 *
 *  1. If `currentSec` falls inside a cue, return that cue's index.
 *  2. Else (gap between cues / beyond the last cue), return the index of
 *     the most recent cue that ended at or before `currentSec`.
 *  3. Else (`currentSec` is before the first cue, e.g. lead-in silence),
 *     return 0 so the first cue is treated as current.
 *
 * Returns `null` only when the cue list is empty.
 *
 * Pure function. Assumes cues are non-overlapping and sorted by `startSec`.
 */
export function findCueIndexForCurrent(
  currentSec: number,
  cues: readonly TranscriptCue[],
): number | null {
  if (cues.length === 0) return null;

  // 1. Currently inside a cue.
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i];
    if (!c) continue;
    if (currentSec >= c.startSec && currentSec < c.endSec) {
      return i;
    }
  }

  // 2. In a gap (or past the last cue) — pick the nearest preceding cue.
  for (let i = cues.length - 1; i >= 0; i -= 1) {
    const c = cues[i];
    if (!c) continue;
    if (c.endSec <= currentSec) {
      return i;
    }
  }

  // 3. Before the first cue (lead-in silence).
  return 0;
}

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

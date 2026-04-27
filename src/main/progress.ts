// Originally adapted from LosslessCut (GPL-2.0-or-later) — `src/main/progress.ts`.
// Copyright (c) Mikael Finstad. https://github.com/mifi/lossless-cut
// Modifications: trimmed to only the `out_time_us` / `progress` keys we use.

export type FfmpegProgress = {
  outTimeMicros: number;
  done: boolean;
  speed?: number;
};

// `-progress pipe:1` emits key=value lines. We only care about a tiny subset.
export function parseProgressLine(line: string): Partial<FfmpegProgress> | null {
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();

  switch (key) {
    case 'out_time_us': {
      const n = Number(value);
      return Number.isFinite(n) ? { outTimeMicros: n } : null;
    }
    case 'speed': {
      // value like "1.23x" or "N/A"
      const m = /^([\d.]+)x?$/.exec(value);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? { speed: n } : null;
    }
    case 'progress':
      return { done: value === 'end' };
    default:
      return null;
  }
}

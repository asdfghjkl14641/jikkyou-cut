import type { SubtitlePosition, SpeakerPreset, TranscriptCue, SpeakerStyle } from './types';
import type { KeptRegion } from './segments';

// Most-likely bug source for the whole subtitle pipeline. The export concat
// removes deleted regions, so a cue that originally ran 12.3-15.0 in the
// source no longer lives at 12.3 in the output — we have to walk the
// `keptRegions` (same source-of-truth as the FFmpeg trim+concat graph) and
// remap. Returns null when `originalSec` falls inside a removed gap; the
// caller drops that cue or clamps it to the surrounding kept region's edge.
export function convertTimecode(
  originalSec: number,
  keptRegions: readonly KeptRegion[],
): number | null {
  let elapsed = 0;
  for (const r of keptRegions) {
    if (originalSec >= r.startSec && originalSec < r.endSec) {
      return elapsed + (originalSec - r.startSec);
    }
    elapsed += r.endSec - r.startSec;
  }
  return null;
}

// Like `convertTimecode` but, when the time lands in a gap or past the end,
// snaps back to the previous kept region's last instant. Used for cue end
// times so that a cue overlapping a gap still terminates at a visible frame.
function convertTimecodeClamped(
  originalSec: number,
  keptRegions: readonly KeptRegion[],
): number | null {
  let elapsed = 0;
  let lastEnd: number | null = null;
  for (const r of keptRegions) {
    if (originalSec >= r.startSec && originalSec < r.endSec) {
      return elapsed + (originalSec - r.startSec);
    }
    if (originalSec < r.startSec && lastEnd != null) {
      return lastEnd;
    }
    elapsed += r.endSec - r.startSec;
    lastEnd = elapsed;
  }
  return lastEnd;
}

// ASS uses BGR byte order with `&Hxxxxxxxx&` syntax (the leading `00` byte
// is the alpha channel; 00 = fully opaque). Easy to get backwards — we
// always wrote the test for this first.
export function hexToAss(hex: string): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m || !m[1]) return '&H00FFFFFF&';
  const rr = m[1].slice(0, 2).toUpperCase();
  const gg = m[1].slice(2, 4).toUpperCase();
  const bb = m[1].slice(4, 6).toUpperCase();
  return `&H00${bb}${gg}${rr}&`;
}

// "H:MM:SS.cc" — note centiseconds (not milliseconds), and a single leading
// hour digit (NOT zero-padded to two). FFmpeg's libass parser is strict.
export function formatAssTime(seconds: number): string {
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCs = Math.round(sec * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const positionToAlignment = (p: SubtitlePosition): number => {
  // ASS Numpad-style alignment: 1-3 bottom, 4-6 middle, 7-9 top. We always
  // center horizontally → 2 / 5 / 8.
  switch (p) {
    case 'top':
      return 8;
    case 'middle':
      return 5;
    case 'bottom':
    default:
      return 2;
  }
};

const escapeAssText = (text: string): string =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');

export type BuildAssArgs = {
  cues: readonly TranscriptCue[];
  keptRegions: readonly KeptRegion[];
  preset: SpeakerPreset;
  videoWidth: number;
  videoHeight: number;
};

function buildStyleLine(style: SpeakerStyle): string {
  const alignment = positionToAlignment(style.position);
  const primaryColour = hexToAss(style.textColor);
  const outlineColour = hexToAss(style.outlineColor);
  const backColour = hexToAss(style.shadow.color);
  const shadowDepth = style.shadow.enabled ? Math.max(0, style.shadow.offsetPx) : 0;
  const outline = Math.max(0, style.outlineWidth);
  const marginV = style.position === 'middle' ? 0 : 60;
  const styleName = `Speaker_${style.speakerId}`;
  return `Style: ${styleName},${style.fontFamily},${style.fontSize},${primaryColour},${primaryColour},${outlineColour},${backColour},0,0,0,0,100,100,0,0,1,${outline},${shadowDepth},${alignment},20,20,${marginV},1`;
}

export function buildAss(args: BuildAssArgs): string {
  const { cues, keptRegions, preset, videoWidth, videoHeight } = args;

  const styleLines: string[] = [];
  const speakerStyleMap = new Map<string, string>();

  // Use 'default' if the preset lacks it somehow
  const fallbackStyleName = `Speaker_default`;

  for (const speaker of preset.speakerStyles) {
    styleLines.push(buildStyleLine(speaker));
    speakerStyleMap.set(speaker.speakerId, `Speaker_${speaker.speakerId}`);
  }

  const events: string[] = [];
  for (const cue of cues) {
    if (cue.deleted) continue;
    if (!cue.showSubtitle) continue;
    if (!cue.text || cue.text.trim().length === 0) continue;

    const startMapped = convertTimecode(cue.startSec, keptRegions);
    if (startMapped == null) continue;
    const endMapped = convertTimecodeClamped(
      Math.max(cue.startSec, cue.endSec - 1e-6),
      keptRegions,
    );
    if (endMapped == null || endMapped <= startMapped) continue;

    let styleName = fallbackStyleName;
    if (cue.styleOverride) {
      // Phase 2: custom override per cue
      const overrideStyleName = `Cue_${cue.id}`;
      if (!styleLines.find(l => l.startsWith(`Style: ${overrideStyleName},`))) {
        styleLines.push(buildStyleLine({ ...cue.styleOverride, speakerId: cue.id } as SpeakerStyle).replace(`Speaker_${cue.id}`, overrideStyleName));
      }
      styleName = overrideStyleName;
    } else if (cue.speaker && speakerStyleMap.has(cue.speaker)) {
      styleName = speakerStyleMap.get(cue.speaker)!;
    } else if (speakerStyleMap.has('default')) {
      styleName = speakerStyleMap.get('default')!;
    } else {
      // Very fallback if 'default' is somehow missing
      styleName = 'Default';
      if (!styleLines.find(l => l.startsWith('Style: Default,'))) {
        styleLines.push(`Style: Default,Arial,48,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,0,2,20,20,60,1`);
      }
    }

    events.push(
      `Dialogue: 0,${formatAssTime(startMapped)},${formatAssTime(endMapped)},${styleName},,0,0,0,,${escapeAssText(cue.text)}`,
    );
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

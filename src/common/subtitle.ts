import type { SubtitlePosition, SubtitleStyle, TranscriptCue } from './types';
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
  style: SubtitleStyle;
  videoWidth: number;
  videoHeight: number;
};

export function buildAss(args: BuildAssArgs): string {
  const { cues, keptRegions, style, videoWidth, videoHeight } = args;
  const alignment = positionToAlignment(style.position);
  const primaryColour = hexToAss(style.textColor);
  const outlineColour = hexToAss(style.outlineColor);
  const backColour = hexToAss(style.shadow.color);
  const shadowDepth = style.shadow.enabled
    ? Math.max(0, style.shadow.offsetPx)
    : 0;
  const outline = Math.max(0, style.outlineWidth);
  // Margin from the corresponding edge in the alignment direction. middle
  // alignment ignores it.
  const marginV = style.position === 'middle' ? 0 : 60;

  // V4+ Style fields:
  // Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,
  // BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,
  // BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
  // BorderStyle=1 → outline + drop shadow. BackColour drives the shadow.
  const styleLine =
    `Style: Default,${style.fontFamily},${style.fontSize},${primaryColour},${primaryColour},${outlineColour},${backColour},` +
    `0,0,0,0,100,100,0,0,1,${outline},${shadowDepth},${alignment},20,20,${marginV},1`;

  const events: string[] = [];
  for (const cue of cues) {
    if (cue.deleted) continue;
    if (!cue.showSubtitle) continue;
    if (!cue.text || cue.text.trim().length === 0) continue;

    const startMapped = convertTimecode(cue.startSec, keptRegions);
    if (startMapped == null) continue;
    // Pull the end time back a touch so an exact-equal endSec→startSec.next
    // boundary (common with ASR) doesn't sit in the next region's interior.
    const endMapped = convertTimecodeClamped(
      Math.max(cue.startSec, cue.endSec - 1e-6),
      keptRegions,
    );
    if (endMapped == null || endMapped <= startMapped) continue;

    events.push(
      `Dialogue: 0,${formatAssTime(startMapped)},${formatAssTime(endMapped)},Default,,0,0,0,,${escapeAssText(cue.text)}`,
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
    styleLine,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

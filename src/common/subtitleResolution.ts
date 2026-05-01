import type { TranscriptCue, SpeakerPreset, SpeakerStyle } from './types';

export function resolveSubtitleStyle(
  cue: TranscriptCue,
  activePreset: SpeakerPreset | null,
): SpeakerStyle {
  if (cue.styleOverride) {
    return cue.styleOverride;
  }
  
  if (!activePreset) {
    throw new Error('No active preset available');
  }

  if (cue.speaker) {
    const speakerStyle = activePreset.speakerStyles.find(s => s.speakerId === cue.speaker);
    if (speakerStyle) return speakerStyle;
  }
  
  const defaultStyle = activePreset.speakerStyles.find(s => s.speakerId === 'default');
  if (defaultStyle) return defaultStyle;
  
  return activePreset.speakerStyles[0]!;
}

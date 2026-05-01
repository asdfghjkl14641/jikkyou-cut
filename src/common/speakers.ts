export function defaultSpeakerName(speakerId: string): string {
  if (speakerId === 'default') return 'デフォルト';
  const match = speakerId.match(/^speaker_(\d+)$/);
  if (match && match[1]) {
    return `スピーカー${parseInt(match[1], 10) + 1}`;
  }
  return speakerId;
}

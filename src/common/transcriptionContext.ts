import type { TranscriptionContext } from './config';

export function buildPrompt(ctx: TranscriptionContext): string {
  const trimmed = {
    gameTitle: ctx.gameTitle.trim(),
    characters: ctx.characters.trim(),
    catchphrases: ctx.catchphrases.trim(),
    notes: ctx.notes.trim(),
  };
  const hasContext =
    trimmed.gameTitle ||
    trimmed.characters ||
    trimmed.catchphrases ||
    trimmed.notes;

  const base = `あなたは日本語音声の文字起こし専門家です。添付された音声を文字起こしし、SRT形式で出力してください。

## 文字起こしのルール
- 日本語で出力
- SRT形式(連番、タイムコード "HH:MM:SS,mmm --> HH:MM:SS,mmm"、テキスト、空行)で出力
- タイムコードは音声の実際の発話時間に合わせる
- フィラー語(えーっと、あー、んー)は基本省略してよい
- 読みやすい文単位でセグメント分割(1セグメント5〜10秒目安)`;

  let contextSection = '';
  if (hasContext) {
    const lines: string[] = [];
    if (trimmed.gameTitle) {
      lines.push(`このオーディオは「${trimmed.gameTitle}」のゲーム実況です。`);
    }
    if (trimmed.characters) {
      lines.push(`登場するキャラクター・固有名詞: ${trimmed.characters}`);
    }
    if (trimmed.catchphrases) {
      lines.push(`配信者の口癖: ${trimmed.catchphrases}`);
    }
    if (trimmed.notes) {
      lines.push(`その他の補足: ${trimmed.notes}`);
    }
    contextSection = `\n\n## コンテキスト情報\n${lines.join('\n')}\n\nこれらの固有名詞・口癖は文字起こし時に正しく反映してください。`;
  }

  const tail = `\n\n## 出力形式\nSRT形式のみを出力。前置きやコメント、説明文は一切不要。`;

  return base + contextSection + tail;
}

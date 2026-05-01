import type { TranscriptionContext } from './config';

const MAX_VOCAB_TERMS = 100;

// Splits a free-text field into individual vocabulary terms. Accepts the
// usual delimiters Japanese users mix in: newline, ASCII/full-width comma,
// and full-width space. Plain ASCII space is intentionally NOT a delimiter
// here — many Japanese terms (especially game titles / phrases) contain
// half-width spaces.
const splitMulti = (s: string): string[] =>
  s.split(/[\n,、,　]+/u).map((t) => t.trim()).filter((t) => t.length > 0);

// `notes` is split only on newlines so longer phrases (full sentences /
// notes that contain commas) survive as a single hint to the ASR.
const splitNewlinesOnly = (s: string): string[] =>
  s.split(/\n+/).map((t) => t.trim()).filter((t) => t.length > 0);

/**
 * Builds the `custom_vocabulary` array sent to Gladia from the user's
 * context form. Pure function — given identical input, produces an
 * identical, deterministic list (de-duplicated, capped at 100 terms).
 */
export function buildCustomVocabulary(ctx: TranscriptionContext): string[] {
  const terms: string[] = [];

  const game = ctx.gameTitle.trim();
  if (game) terms.push(game);

  for (const t of splitMulti(ctx.characters)) terms.push(t);
  for (const t of splitMulti(ctx.catchphrases)) terms.push(t);
  for (const t of splitNewlinesOnly(ctx.notes)) terms.push(t);

  // De-duplicate while preserving first-seen order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of terms) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  if (unique.length > MAX_VOCAB_TERMS) {
    console.warn(
      `[gladia] custom_vocabulary exceeded ${MAX_VOCAB_TERMS} terms (${unique.length}); truncating`,
    );
    return unique.slice(0, MAX_VOCAB_TERMS);
  }
  return unique;
}

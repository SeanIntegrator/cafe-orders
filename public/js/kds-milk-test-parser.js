/**
 * Flow line-note helpers: typo normalization and whole-note exact matches only
 * (no substring regex — avoids "not too hot" → Hot).
 */

/**
 * Fix common customer typos in free-text notes (and shot signal strings) before matching.
 * Idempotent for repeated application.
 * @param {string|null|undefined} s
 * @returns {string}
 */
export function normalizeKdsNoteTypos(s) {
  let t = String(s ?? '');
  if (!t.trim()) return t;
  t = t.replace(/\bsht\s+shots?\b/gi, 'shot');
  t = t.replace(/\bshoots\b/gi, 'shots');
  t = t.replace(/\bshoot\b/gi, 'shot');
  t = t.replace(/\bsht\b/gi, 'shot');
  t = t.replace(/\bsot\b/gi, 'shot');
  t = t.replace(/\bhoot\b/gi, 'hot');
  t = t.replace(/\bexra\b/gi, 'extra');
  t = t.replace(/\bxtra\b/gi, 'extra');
  t = t.replace(/\bex\b/gi, 'extra');
  t = t.replace(/\bx\b/gi, 'extra');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** Keys: lowercase after normalize + single-space collapse; values = chip labels */
const NOTE_TEXTURE_EXACT = Object.freeze({
  dry: 'Dry',
  wet: 'Wet',
  'no foam': 'No foam',
});

const NOTE_TEMP_EXACT = Object.freeze({
  hot: 'Hot',
  'extra hot': 'Extra hot',
  warm: 'Warm',
  'less hot': 'Less hot',
});

function normalizedNoteKey(noteRaw) {
  const n = normalizeKdsNoteTypos(String(noteRaw ?? '').trim()).replace(/\s+/g, ' ');
  return n.toLowerCase();
}

/**
 * Whole customer note must match one allowed texture phrase (after typo normalize).
 * @param {string|null|undefined} noteRaw
 * @returns {string|null} Display label or null
 */
export function parseFlowNoteTextureExact(noteRaw) {
  const key = normalizedNoteKey(noteRaw);
  if (!key) return null;
  return NOTE_TEXTURE_EXACT[key] ?? null;
}

/**
 * Whole customer note must match one allowed temperature phrase (after typo normalize).
 * @param {string|null|undefined} noteRaw
 * @returns {string|null} Display label or null
 */
export function parseFlowNoteTempExact(noteRaw) {
  const key = normalizedNoteKey(noteRaw);
  if (!key) return null;
  return NOTE_TEMP_EXACT[key] ?? null;
}

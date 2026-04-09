/**
 * Per-site / per-cafe KDS tuning (env-driven so new locations don't require code edits).
 *
 * KDS_MODIFIER_OPTION_IDS_EX — comma-separated Square catalog_object_ids for modifier *options*
 * that live in a bundled list (e.g. "ex") but should sort with coffee prep (shots, decaf, etc.).
 *
 * KDS_SITE_KEY — optional override for the site identifier. If unset, index.js sets this to
 * Square location ID from getLocationId() after startup; falls back to "default" if unavailable.
 */

let _siteKey = process.env.KDS_SITE_KEY || 'default';

function getKdsSiteKey() {
  return _siteKey;
}

/** @param {string} key */
function setKdsSiteKey(key) {
  _siteKey = key && String(key).trim() ? String(key).trim() : 'default';
}

const SHOT_QUAD_RE = /\bquad(?:ruple)?\s+shot\b|\b4\s*x\s*shot\b/i;
const SHOT_TRIPLE_RE = /\btriple\s+shot\b|\b3\s*x\s*shot\b/i;
const SHOT_DOUBLE_RE = /\bdouble\s+shot\b|\b2\s*x\s*shot\b/i;
const SHOT_SINGLE_RE =
  /\bsingle\s*-?\s*shot\b|\b1\s*x\s*shot\b|\b1\s+shot\b|\bone\s+shot\b/i;
const SHOT_EXTRA_RE = /\bextra\s+shot\b/i;
const DECAF_RE = /\bdecaf|decaffeinated\b/i;
const TEXTURE_RE =
  /\b(extra\s+dry|dry|wet|foamy|less\s+foam|no\s+foam|extra\s+foam|half\s+foam)\b/i;
const FLOW_MILK_TEMP_RE =
  /\b(extra\s+hot|extra\s+warm|warmer?|warm\b|iced|ice\b|cold|a\s+little\s+cooler|cooler\b|kid\s*temp|lukewarm)\b/i;
const MILK_RULES = [
  { key: 'soy', re: /\b(soy|soya)\b/i },
  { key: 'coconut', re: /\bcoconut\b/i },
  { key: 'almond', re: /\balmond\b/i },
  { key: 'oat', re: /\boat\b/i },
  { key: 'semi', re: /\b(semi|skim|skinny|low\s*fat|semi-?skimmed?)\b/i },
  { key: 'whole', re: /\b(whole|full\s*fat|regular\s*milk)\b/i },
];

function parseIdSet(envVal) {
  if (!envVal || typeof envVal !== 'string') return new Set();
  return new Set(
    envVal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const exOptionIds = parseIdSet(process.env.KDS_MODIFIER_OPTION_IDS_EX);

/** Lower = earlier in prep sort; keep small (0–30) so ex-boosted mods interleave with typical catalog indices (0–15). */
const SORT_TIER = {
  shot: 2,
  decaf: 3,
  milk: 8,
  texture: 10,
  temp: 12,
  size: 14,
  syrup: 20,
  topping: 22,
  other: 18,
};

function detectMilkKey(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  for (const { key, re } of MILK_RULES) {
    if (re.test(s)) return key;
  }
  return null;
}

/** Align with public isFlowSizeModifier word/oz/ml tokens (e.g. Large in Ex list → size tier). */
function isFlowSizeToken(name) {
  const t = String(name || '').trim();
  if (!t || /^regular$/i.test(t)) return false;
  return (
    /^(large|medium|small|venti|grande|tall|short|xl|xxl|xs)$/i.test(t) ||
    /^(8|10|12|16|20)\s*oz$/i.test(t) ||
    /^\d{2,3}\s*ml$/i.test(t)
  );
}

/**
 * When a modifier option is in the site's "ex" (or similar) list, assign a sort tier so it
 * interleaves correctly with milk/syrups from other lists (client sort uses one global order key).
 * @param {string} catalogObjectId
 * @param {string} modifierName
 * @returns {number|null} sort key 0–999, or null to use client catalog order only
 */
function kdsSortOrderForExModifier(catalogObjectId, modifierName) {
  if (!exOptionIds.size || !catalogObjectId || !exOptionIds.has(catalogObjectId)) {
    return null;
  }
  const n = String(modifierName || '');
  if (SHOT_QUAD_RE.test(n) || SHOT_TRIPLE_RE.test(n) || SHOT_DOUBLE_RE.test(n) || SHOT_SINGLE_RE.test(n) || SHOT_EXTRA_RE.test(n)) {
    return SORT_TIER.shot;
  }
  if (DECAF_RE.test(n)) return SORT_TIER.decaf;
  if (detectMilkKey(n)) return SORT_TIER.milk;
  if (isFlowSizeToken(n)) return SORT_TIER.size;
  if (TEXTURE_RE.test(n)) return SORT_TIER.texture;
  if (FLOW_MILK_TEMP_RE.test(n)) return SORT_TIER.temp;
  return SORT_TIER.other;
}

module.exports = {
  getKdsSiteKey,
  setKdsSiteKey,
  /** @deprecated use getKdsSiteKey() — value updates after server resolves Square location */
  get siteKey() {
    return _siteKey;
  },
  exOptionIds,
  kdsSortOrderForExModifier,
  SORT_TIER,
};

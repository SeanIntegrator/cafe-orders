/**
 * KDS Concept C: classify modifiers (milk vs square vs round) and sort per brief §14.
 * Square = coffee modifiers; round = additions. Extra shot → square (brief).
 */

/** Optional: map Square catalog_object_id → two-letter bean label (Et, Co, …). Curated in admin later. */
export const KDS_BEAN_LABEL_BY_CATALOG_ID = Object.freeze({});

const DECAF_RE = /\bdecaf|decaffeinated\b/i;
const GUEST_RE = /\bguest\s+(bean|espresso|shot|grind)\b/i;

const MILK_RULES = [
  { key: 'soy', re: /\bsoy\b/i },
  { key: 'coconut', re: /\bcoconut\b/i },
  { key: 'almond', re: /\balmond\b/i },
  { key: 'oat', re: /\boat\b/i },
  { key: 'semi', re: /\b(semi|skim|skinny|low\s*fat|semi-?skimmed?)\b/i },
  { key: 'whole', re: /\b(whole|full\s*fat|regular\s*milk)\b/i },
];

/** Lower = earlier in row. Brief §14 square order. */
const SQUARE_TIERS = [
  { re: /\b(triple|quad|quadruple)\s+shot\b|\b3\s*x\s*shot\b|\btriple\b/i, tier: 0 },
  { re: /\bdouble\s+shot\b|\b2\s*x\s*shot\b|\bextra\s+shot\b/i, tier: 1 },
  { re: /\bsingle\s+shot\b|\b1\s*x\s*shot\b/i, tier: 2 },
  { re: /\bristretto\b|\blungo\b|\blong\s+black\b|\bshort\s+black\b/i, tier: 3 },
  { re: /\blarge\b|\bventi\b|\bgrande\b|\bmedium\b|\bsmall\b|\b12oz\b|\b16oz\b|\b8oz\b/i, tier: 10 },
  { re: /\bextra\s+hot\b|\bwarmer?\b|\biced\b|\bcold\b/i, tier: 20 },
  { re: /\bdry\b|\bwet\b|\bextra\s+foam\b|\bno\s+foam\b|\bhalf\s+foam\b/i, tier: 30 },
  { re: /\bdecaf|decaffeinated\b/i, tier: 40 },
];

const ROUND_TIERS = [
  { re: /\bvanilla\b|\bcaramel\b|\bhazelnut\b|\bmaple\b|\btoffee\b|\bpeppermint\b|\blavender\b|\brose\b|\bsyrup\b/i, tier: 0 },
  { re: /\bcold\s*foam\b|\bsprinkles?\b|\bwhipped\s*cream\b|\boat\s*crumble\b|\bchocolate\s*shavings?\b|\bdrizzle\b|\bmarshmallow\b/i, tier: 10 },
];

/** Syrups — own chips in portrait milk column; excluded from generic “round” modifier row when using split model. */
const SYRUP_RE =
  /\bvanilla\b|\bcaramel\b|\bhazelnut\b|\bmaple\b|\btoffee\b|\bpeppermint\b|\blavender\b|\brose\b|\bsyrup\b/i;

/**
 * Temperature shown inside the milk chip (vertical divider) in portrait mode.
 * Iced/cold stay out — drink titles already imply iced; no empty “no milk” chip needed.
 */
const MILK_CHIP_TEMP_EXCLUDE = /\b(iced|ice\b|cold|frappe|frappé|slush)\b/i;
const MILK_CHIP_TEMP_INCLUDE =
  /\b(extra\s+hot|extra\s+warm|warmer?|warm\b|a\s+little\s+cooler|cooler\b|kid\s*temp|lukewarm)\b/i;

export function isSyrupModifier(name) {
  return SYRUP_RE.test(String(name || ''));
}

export function isMilkChipTemperature(name) {
  const s = String(name || '');
  if (!s.trim()) return false;
  if (MILK_CHIP_TEMP_EXCLUDE.test(s)) return false;
  return MILK_CHIP_TEMP_INCLUDE.test(s);
}

/** @returns {string|null} milk key or null if not a milk modifier */
export function detectMilkKey(modifierName) {
  const s = String(modifierName || '').trim();
  if (!s) return null;
  for (const { key, re } of MILK_RULES) {
    if (re.test(s)) return key;
  }
  return null;
}

export function extractMilkFromModifierList(names) {
  for (const n of names) {
    const k = detectMilkKey(n);
    if (k) return { milkKey: k, milkLabel: n };
  }
  return { milkKey: 'whole', milkLabel: null };
}

export function hasDecafModifier(names) {
  return names.some((n) => DECAF_RE.test(String(n)));
}

export function orderSuggestsGuestBean(order) {
  const note = [
    order?.fulfillments?.[0]?.pickup_details?.note,
    order?.note,
  ]
    .filter(Boolean)
    .join(' ');
  return GUEST_RE.test(note);
}

export function beanBadgeFromItem(item, order) {
  const vid = item?.catalog_object_id || item?.variation_id || '';
  if (vid && KDS_BEAN_LABEL_BY_CATALOG_ID[vid]) {
    const label = String(KDS_BEAN_LABEL_BY_CATALOG_ID[vid]).trim().slice(0, 2);
    if (label.length >= 2) return { kind: 'Et', label: label.slice(0, 2) };
  }
  const names = (item?.modifiers || []).map((m) => m?.name).filter(Boolean);
  if (hasDecafModifier(names)) return { kind: 'Dc', label: 'Dc' };
  if (orderSuggestsGuestBean(order)) return { kind: 'Gu', label: 'Gu' };
  return { kind: 'Ho', label: 'Ho' };
}

function tierIndex(name, tiers, defaultTier) {
  const s = String(name);
  let best = defaultTier;
  for (const { re, tier } of tiers) {
    if (re.test(s)) best = Math.min(best, tier);
  }
  return best;
}

export function sortSquareModifiers(names) {
  const copy = [...names];
  copy.sort((a, b) => {
    const ta = tierIndex(a, SQUARE_TIERS, 50);
    const tb = tierIndex(b, SQUARE_TIERS, 50);
    if (ta !== tb) return ta - tb;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  });
  return copy;
}

export function sortRoundModifiers(names) {
  const copy = [...names];
  copy.sort((a, b) => {
    const ta = tierIndex(a, ROUND_TIERS, 20);
    const tb = tierIndex(b, ROUND_TIERS, 20);
    if (ta !== tb) return ta - tb;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  });
  return copy;
}

/**
 * @param {string} name
 * @param {{ isMilk?: boolean }} ctx
 * @returns {'square'|'round'}
 */
export function classifyNonMilkModifier(name, ctx = {}) {
  if (ctx.isMilk) return 'square'; // should not be called
  const s = String(name);
  const sq = tierIndex(s, SQUARE_TIERS, 999);
  const ro = tierIndex(s, ROUND_TIERS, 999);
  if (ro < sq) return 'round';
  if (sq < 999) return 'square';
  // Heuristic: flavour words → round
  if (/\b(sauce|powder|powdered|topping|syrup|sweetener|honey|agave)\b/i.test(s)) return 'round';
  return 'square';
}

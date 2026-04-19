/**
 * KDS Concept C: classify modifiers (milk vs square vs round) and sort per brief §14.
 * Square = coffee modifiers; round = additions. Extra shot → square (brief).
 */

import { normalizeKdsNoteTypos } from './kds-milk-test-parser.js';

/** Optional: map Square catalog_object_id → two-letter bean label (Et, Co, …). Curated in admin later. */
export const KDS_BEAN_LABEL_BY_CATALOG_ID = Object.freeze({});

const DECAF_RE = /\bdecaf|decaffeinated\b/i;
const GUEST_RE = /\bguest\s+(bean|espresso|shot|grind)\b/i;

const MILK_RULES = [
  { key: 'soy', re: /\b(soy|soya)\b/i },
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
  { re: /\bsingle\s*-?\s*shot\b|\b1\s*x\s*shot\b|\b1\s+shot\b|\bone\s+shot\b/i, tier: 2 },
  { re: /\bristretto\b|\blungo\b|\blong\s+black\b|\bshort\s+black\b/i, tier: 3 },
  {
    re: /\blarge\b|\bventi\b|\bgrande\b|\bmedium\b|\bsmall\b|\btall\b|\bshort\b|\b12oz\b|\b16oz\b|\b8oz\b|\b10oz\b|\b20oz\b|\b\d{2,3}\s*ml\b/i,
    tier: 10,
  },
  { re: /\bextra\s+hot\b|\bwarmer?\b|\biced\b|\bcold\b/i, tier: 20 },
  {
    re: /\bextra\s+dry\b|\bdry\b|\bwet\b|\bfoamy\b|\bless\s+foam\b|\bno\s+foam\b|\bextra\s+foam\b|\bhalf\s+foam\b/i,
    tier: 30,
  },
  { re: /\bdecaf|decaffeinated\b/i, tier: 40 },
];

const ROUND_TIERS = [
  {
    re: /\bwhite\s*chocolate\b|\bchocolate\b|\bvanilla\b|\bcaramel\b|\bhazelnut\b|\braspberry\b|\bstrawberry\b|\bblueberry\b|\bcherry\b|\bcinnamon\b|\bmaple\b|\btoffee\b|\bpeppermint\b|\blavender\b|\brose\b|\bsyrup\b/i,
    tier: 0,
  },
  { re: /\bcold\s*foam\b|\bsprinkles?\b|\bwhipped\s*cream\b|\boat\s*crumble\b|\bchocolate\s*shavings?\b|\bdrizzle\b|\bmarshmallow\b/i, tier: 10 },
];

/** Toppings (tier 10 in ROUND_TIERS) — syrups stay separate in Flow prep column. */
const TOPPING_RE =
  /\bcold\s*foam\b|\bsprinkles?\b|\bwhipped\s*cream\b|\boat\s*crumble\b|\bchocolate\s*shavings?\b|\bdrizzle\b|\bmarshmallows?\b/i;

const TEXTURE_RE =
  /\b(extra\s+dry|dry|wet|foamy|less\s+foam|no\s+foam|extra\s+foam|half\s+foam)\b/i;

/** Flow milk chip: include iced/cold as temperature segment. */
const FLOW_MILK_TEMP_RE =
  /\b(extra\s+hot|hot|extra\s+warm|warmer?|warm\b|iced|ice\b|cold|a\s+little\s+cooler|cooler\b|kid\s*temp|lukewarm)\b/i;

const SHOT_QUAD_RE = /\bquad(?:ruple)?\s+shot\b|\b4\s*x\s*shot\b/i;
const SHOT_TRIPLE_RE = /\btriple\s+shot\b|\b3\s*x\s*shot\b/i;
const SHOT_DOUBLE_RE = /\bdouble\s+shot\b|\b2\s*x\s*shot\b/i;
const SHOT_SINGLE_RE =
  /\bsingle\s*-?\s*shot\b|\b1\s*x\s*shot\b|\b1\s+shot\b|\bone\s+shot\b/i;
const SHOT_EXTRA_RE = /\bextra\s+shot\b/i;

/** Syrups — own chips in portrait milk column; excluded from generic “round” modifier row when using split model. */
const SYRUP_RE =
  /\bwhite\s*chocolate\b|\bchocolate\b|\bvanilla\b|\bcaramel\b|\bhazelnut\b|\braspberry\b|\bstrawberry\b|\bblueberry\b|\bcherry\b|\bcinnamon\b|\bmaple\b|\btoffee\b|\bpeppermint\b|\blavender\b|\brose\b|\bsyrup\b/i;

/** Flow syrup chip: compact label + CSS variant (white-chocolate before chocolate). */
const FLOW_SYRUP_VARIANTS = [
  { key: 'white-chocolate', re: /\bwhite\s*chocolate\b/i },
  { key: 'chocolate', re: /\bchocolate\b/i },
  { key: 'caramel', re: /\bcaramel\b/i },
  { key: 'hazelnut', re: /\bhazelnut\b/i },
  { key: 'vanilla', re: /\bvanilla\b/i },
  { key: 'raspberry', re: /\braspberry\b/i },
  { key: 'strawberry', re: /\bstrawberry\b/i },
  { key: 'blueberry', re: /\bblueberry\b/i },
  { key: 'rose', re: /\brose\b/i },
  { key: 'cherry', re: /\bcherry\b/i },
  { key: 'cinnamon', re: /\bcinnamon\b/i },
];

/**
 * @param {string} rawName
 * @returns {{ display: string, variant: string | null }}
 */
export function flowSyrupChipParts(rawName) {
  const s0 = String(rawName || '').trim();
  if (!s0) return { display: '', variant: null };
  let display = s0
    .replace(/\bsyrups?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[|]+\s*|\s*[|]+\s*$/g, '')
    .trim();
  if (!display) display = s0.replace(/\bsyrups?\b/gi, '').trim() || s0;

  let variant = null;
  for (const { key, re } of FLOW_SYRUP_VARIANTS) {
    if (re.test(s0)) {
      variant = key;
      break;
    }
  }
  return { display, variant };
}

/**
 * Temperature shown inside the milk chip (vertical divider) in portrait mode.
 * Iced/cold stay out — drink titles already imply iced; no empty “no milk” chip needed.
 */
const MILK_CHIP_TEMP_EXCLUDE = /\b(iced|ice\b|cold|frappe|frappé|slush)\b/i;
const MILK_CHIP_TEMP_INCLUDE =
  /\b(extra\s+hot|hot|extra\s+warm|warmer?|warm\b|a\s+little\s+cooler|cooler\b|kid\s*temp|lukewarm)\b/i;

export function isSyrupModifier(name) {
  return SYRUP_RE.test(String(name || ''));
}

/**
 * Drink size for Flow base column — strip from prep chips.
 * Whole-string match only so phrases like "Short black" are not treated as size.
 */
const FLOW_SIZE_WORD_RE =
  /^(large|medium|small|venti|grande|tall|short|xl|xxl|xs)$/i;
const FLOW_SIZE_OZ_RE = /^(8|10|12|16|20)\s*oz$/i;
const FLOW_SIZE_ML_RE = /^\d{2,3}\s*ml$/i;

export function isFlowSizeModifier(name) {
  const s = String(name || '').trim();
  if (!s || /^regular$/i.test(s)) return false;
  return FLOW_SIZE_WORD_RE.test(s) || FLOW_SIZE_OZ_RE.test(s) || FLOW_SIZE_ML_RE.test(s);
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

/**
 * Merged line note (POS + app both end up with customer_note after server normalize; keep tolerant).
 * @param {object} item
 */
export function getMergedLineNote(item) {
  const a = item?.customer_note != null ? String(item.customer_note).trim() : '';
  const b = item?.note != null ? String(item.note).trim() : '';
  const merged =
    a && b && a !== b ? `${a} ${b}`.replace(/\s+/g, ' ').trim() : a || b;
  return normalizeKdsNoteTypos(merged);
}

export function decafSuggestedByLineNote(item) {
  return DECAF_RE.test(getMergedLineNote(item));
}

export function guestBeanSuggestedByLineNote(item) {
  return GUEST_RE.test(getMergedLineNote(item));
}

/** Snippets from free text for milk detection when POS puts milk only in the note. */
export function syntheticMilkSnippetsFromNote(noteRaw) {
  const s = String(noteRaw || '').trim();
  if (!s) return [];
  const out = [];
  for (const { re } of MILK_RULES) {
    const m = s.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

/**
 * Flow size chip from line note (e.g. "large oat" when no Large modifier on the ticket).
 * @param {string|null|undefined} noteRaw
 * @returns {string|null} e.g. "LARGE"
 */
export function flowSizeLabelFromNote(noteRaw) {
  const s = String(noteRaw || '').trim();
  if (!s) return null;
  for (const w of s.split(/\s+/)) {
    if (isFlowSizeModifier(w)) return String(w).trim().toUpperCase();
  }
  const oz = s.match(/\b(\d{1,2})\s*oz\b/i);
  if (oz && isFlowSizeModifier(`${oz[1]} oz`)) return `${oz[1]} OZ`;
  const ml = s.match(/\b(\d{2,3})\s*ml\b/i);
  if (ml && isFlowSizeModifier(`${ml[1]} ml`)) return `${ml[1]} ML`;
  return null;
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
  const lineNote = getMergedLineNote(item);
  if (hasDecafModifier(names) || DECAF_RE.test(lineNote)) return { kind: 'Dc', label: 'Dc' };
  if (orderSuggestsGuestBean(order) || GUEST_RE.test(lineNote)) return { kind: 'Gu', label: 'Gu' };
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

export function isToppingModifier(name) {
  return TOPPING_RE.test(String(name || ''));
}

export function isTextureModifier(name) {
  return TEXTURE_RE.test(String(name || ''));
}

/** True if this modifier is only used for shot counting / bean display (strip from prep lists). */
export function isShotCountModifier(name) {
  const s = String(name || '');
  if (
    SHOT_QUAD_RE.test(s) ||
    SHOT_TRIPLE_RE.test(s) ||
    SHOT_DOUBLE_RE.test(s) ||
    SHOT_SINGLE_RE.test(s) ||
    SHOT_EXTRA_RE.test(s)
  ) {
    return true;
  }
  if (parseSplitShotsFromNames([s])) return true;
  return false;
}

export function isFlowMilkTemperature(name) {
  const s = String(name || '');
  if (!s.trim()) return false;
  return FLOW_MILK_TEMP_RE.test(s);
}

/**
 * @param {string|null|undefined} milkLabel - display milk name (e.g. Whole, Oat)
 * @param {string|null|undefined} textureMod - e.g. DRY
 * @param {string|null|undefined} tempMod - e.g. Extra hot, Iced
 */
export function buildMilkChipLabel(milkLabel, textureMod, tempMod) {
  const tex = textureMod ? String(textureMod).trim() : '';
  const milk = milkLabel ? String(milkLabel).trim() : '';
  const tmp = tempMod ? String(tempMod).trim() : '';

  let left = '';
  if (tex && milk) left = `${tex} | ${milk}`;
  else if (tex) left = tex;
  else if (milk) left = milk;

  if (tmp) {
    if (left) return `${left} | ${tmp}`;
    return tmp;
  }
  return left;
}

/**
 * Parts for Flow milk chip markup: texture + temp italicized in CSS; milk stays normal.
 * @returns {{ texture: string, milk: string, temp: string }}
 */
export function buildMilkChipSegments(milkLabel, textureMod, tempMod) {
  const tex = textureMod ? String(textureMod).trim() : '';
  const milk = milkLabel ? String(milkLabel).trim() : '';
  const tmp = tempMod ? String(tempMod).trim() : '';
  return { texture: tex, milk: milk, temp: tmp };
}

/**
 * Parse split-shot patterns from modifier names (e.g. 1 decaf + 1 house).
 * @returns {{ decaf: number, house: number } | null}
 */
function parseSplitShotsFromNames(names) {
  const joined = names.map((n) => String(n)).join(' ');
  const m1 = joined.match(
    /(\d+)\s*(?:x\s*)?(?:shot\s*)?\s*(?:of\s*)?(?:decaf|decaffeinated).*?(\d+)\s*(?:x\s*)?(?:shot\s*)?\s*(?:of\s*)?(?:house|regular|ho\b)/i
  );
  if (m1) {
    return { decaf: parseInt(m1[1], 10), house: parseInt(m1[2], 10) };
  }
  const m2 = joined.match(
    /(\d+)\s*(?:x\s*)?(?:shot\s*)?\s*(?:of\s*)?(?:house|regular|ho\b).*?(\d+)\s*(?:x\s*)?(?:shot\s*)?\s*(?:of\s*)?(?:decaf|decaffeinated)/i
  );
  if (m2) {
    return { decaf: parseInt(m2[2], 10), house: parseInt(m2[1], 10) };
  }
  return null;
}

const DEFAULT_ESPRESSO_SHOTS = 2;

/**
 * Modifier names plus line note (POS often puts "Single shot" only in note).
 * @param {object} item
 * @returns {string[]}
 */
function shotSignalNames(item) {
  const names = (item?.modifiers || [])
    .map((m) => m?.name)
    .filter(Boolean)
    .map((n) => normalizeKdsNoteTypos(String(n)));
  const note = normalizeKdsNoteTypos(String(item?.customer_note || item?.note || '').trim());
  if (note) names.push(note);
  return names;
}

/**
 * Derive shot counts from line-item modifiers for Flow bean badges.
 * @returns {{ totalShots: number, isNonStandard: boolean, splitBeans: { decaf: number, house: number } | null }}
 */
export function extractShotInfo(item) {
  const names = shotSignalNames(item);
  const split = parseSplitShotsFromNames(names);
  if (split && (split.decaf > 0 || split.house > 0)) {
    const total = split.decaf + split.house;
    return {
      totalShots: total,
      isNonStandard: true,
      splitBeans: split,
    };
  }

  let explicit = null;
  let extraCount = 0;
  for (const n of names) {
    const s = String(n);
    if (SHOT_QUAD_RE.test(s)) explicit = 4;
    else if (SHOT_TRIPLE_RE.test(s)) explicit = 3;
    else if (SHOT_DOUBLE_RE.test(s)) explicit = 2;
    else if (SHOT_SINGLE_RE.test(s)) explicit = 1;
    else if (SHOT_EXTRA_RE.test(s)) extraCount += 1;
  }

  let totalShots = DEFAULT_ESPRESSO_SHOTS;
  if (explicit != null) {
    totalShots = explicit + extraCount;
  } else if (extraCount > 0) {
    totalShots = DEFAULT_ESPRESSO_SHOTS + extraCount;
  }

  const isNonStandard = totalShots !== DEFAULT_ESPRESSO_SHOTS;
  return {
    totalShots,
    isNonStandard,
    splitBeans: null,
  };
}

/**
 * Server-side KDS prep hints (shots, bean badge) so POS and app orders match Flow behaviour.
 * Logic mirrors public/js/kds-modifier-config.js — keep in sync when changing barista rules.
 */

const GUEST_RE = /\bguest\s+(bean|espresso|shot|grind)\b/i;

/** Optional map Square variation id → two-letter label (same as client KDS_BEAN_LABEL_BY_CATALOG_ID). */
const KDS_BEAN_LABEL_BY_CATALOG_ID = Object.freeze(
  (() => {
    try {
      const raw = process.env.KDS_BEAN_LABEL_BY_CATALOG_ID_JSON;
      if (!raw) return {};
      const o = JSON.parse(raw);
      return typeof o === 'object' && o ? o : {};
    } catch {
      return {};
    }
  })()
);

const SHOT_QUAD_RE = /\bquad(?:ruple)?\s+shot\b|\b4\s*x\s*shot\b/i;
const SHOT_TRIPLE_RE = /\btriple\s+shot\b|\b3\s*x\s*shot\b/i;
const SHOT_DOUBLE_RE = /\bdouble\s+shot\b|\b2\s*x\s*shot\b/i;
const SHOT_SINGLE_RE =
  /\bsingle\s*-?\s*shot\b|\b1\s*x\s*shot\b|\b1\s+shot\b|\bone\s+shot\b/i;
const SHOT_EXTRA_RE = /\bextra\s+shot\b/i;
const DECAF_RE = /\bdecaf|decaffeinated\b/i;

const DEFAULT_ESPRESSO_SHOTS = 2;

/**
 * Modifier names plus line note (POS often puts "Single shot" only in note).
 * @param {object} item
 * @returns {string[]}
 */
function shotSignalNames(item) {
  const names = (item?.modifiers || []).map((m) => m?.name).filter(Boolean);
  const note = String(item?.customer_note || item?.note || '').trim();
  if (note) names.push(note);
  return names;
}

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

function hasDecafModifier(names) {
  return names.some((n) => DECAF_RE.test(String(n)));
}

function orderSuggestsGuestBean(order) {
  const note = [order?.fulfillments?.[0]?.pickup_details?.note, order?.note]
    .filter(Boolean)
    .join(' ');
  return GUEST_RE.test(note);
}

function mergedLineNote(item) {
  const a = item?.customer_note != null ? String(item.customer_note).trim() : '';
  const b = item?.note != null ? String(item.note).trim() : '';
  if (a && b && a !== b) return `${a} ${b}`.replace(/\s+/g, ' ').trim();
  return a || b;
}

/**
 * @param {object} item - line item with modifiers[]
 * @param {object} order - parent order
 * @returns {{ kind: string, label: string }}
 */
function beanBadgeFromItem(item, order) {
  const vid = item?.catalog_object_id || item?.variation_id || '';
  if (vid && KDS_BEAN_LABEL_BY_CATALOG_ID[vid]) {
    const label = String(KDS_BEAN_LABEL_BY_CATALOG_ID[vid]).trim().slice(0, 2);
    if (label.length >= 2) return { kind: 'Et', label: label.slice(0, 2) };
  }
  const names = (item?.modifiers || []).map((m) => m?.name).filter(Boolean);
  const lineNote = mergedLineNote(item);
  if (hasDecafModifier(names) || DECAF_RE.test(lineNote)) return { kind: 'Dc', label: 'Dc' };
  if (orderSuggestsGuestBean(order) || GUEST_RE.test(lineNote)) return { kind: 'Gu', label: 'Gu' };
  return { kind: 'Ho', label: 'Ho' };
}

/**
 * @param {object} item
 * @returns {{ totalShots: number, isNonStandard: boolean, splitBeans: { decaf: number, house: number } | null }}
 */
function extractShotInfo(item) {
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

function isCoffeeBeanItem(item) {
  const name = (item?.name || '').toLowerCase();
  if (
    [
      'espresso',
      'latte',
      'cappuccino',
      'americano',
      'macchiato',
      'mocha',
      'flat white',
      'cortado',
      'ristretto',
      'long black',
      'short black',
      'cold brew',
      'lungo',
      'affogato',
    ].some((w) => name.includes(w))
  ) {
    return true;
  }
  if (name.includes('coffee') && !name.includes('hot choc') && !name.includes('tea')) return true;
  return false;
}

/**
 * @param {object} item - normalized line item
 * @param {object} order - parent order
 * @returns {object} kds_prep payload for the line item
 */
function buildKdsPrep(item, order) {
  const shotInfo = extractShotInfo(item);
  const primaryBean = beanBadgeFromItem(item, order);
  const DEFAULT_SHOTS = 2;
  /** @type {{ kind: string, label: string, shots: number, isGhost: boolean }[]} */
  let beans = [];
  const showBeans = isCoffeeBeanItem(item);
  if (showBeans) {
    if (shotInfo.splitBeans) {
      const { decaf, house } = shotInfo.splitBeans;
      beans = [
        { kind: 'Dc', label: 'Dc', shots: decaf, isGhost: false },
        { kind: 'Ho', label: 'Ho', shots: house, isGhost: false },
      ];
    } else {
      const shots = shotInfo.totalShots;
      const isGhost =
        primaryBean.kind === 'Ho' && shots === DEFAULT_SHOTS && !shotInfo.isNonStandard;
      beans = [{ kind: primaryBean.kind, label: primaryBean.label, shots, isGhost }];
    }
  }

  return {
    version: 1,
    shotInfo,
    primaryBean,
    beans,
  };
}

module.exports = {
  buildKdsPrep,
  extractShotInfo,
  beanBadgeFromItem,
};

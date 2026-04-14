/**
 * Pure view-model builders for KDS Concept C cards and Flow view.
 */

import { getModifiers, isDrinkItem, isCoffeeBeanItem, escapeHtml } from './helpers.js';
import { normalizeServiceModifierOptionName } from './helpers.js';
import {
  extractMilkFromModifierList,
  detectMilkKey,
  beanBadgeFromItem,
  classifyNonMilkModifier,
  sortSquareModifiers,
  sortRoundModifiers,
  hasDecafModifier,
  isSyrupModifier,
  flowSyrupChipParts,
  isMilkChipTemperature,
  extractShotInfo,
  isToppingModifier,
  buildMilkChipLabel,
  buildMilkChipSegments,
  isTextureModifier,
  isFlowMilkTemperature,
  isFlowSizeModifier,
  isShotCountModifier,
  syntheticMilkSnippetsFromNote,
  flowSizeLabelFromNote,
  decafSuggestedByLineNote,
  getMergedLineNote,
} from './kds-modifier-config.js';
import {
  buildFlowMilkScanText,
  parseFlowMilkTextureFromText,
  parseFlowMilkTemperatureFromText,
} from './kds-milk-test-parser.js';

const DEFAULT_SHOTS = 2;

/**
 * When false, Flow shows merged customer notes as raw italic text and skips chip/note heuristics.
 * Set to true after launch once parsing is validated.
 */
export const SMART_NOTE_PARSING_ENABLED = false;

const MILK_KEY_DISPLAY = {
  whole: 'Whole',
  semi: 'Semi',
  oat: 'Oat',
  almond: 'Almond',
  coconut: 'Coconut',
  soy: 'Soy',
};

/** Square often sends "Regular" as a size option; hide from prep/chips (default size). */
export function isRegularSizeModifierLabel(name) {
  return /^regular$/i.test(String(name || '').trim());
}

/** Strip shot phrases from flow column-3 note (shots appear on bean badge). */
function stripFlowShotNoteFragments(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  t = t
    .replace(/\b(single|double|triple|quad|quadruple|extra)\s*-?\s*shots?\b/gi, ' ')
    .replace(/\bone\s+shot\b/gi, ' ')
    .replace(/\b\d\s*x\s*shots?\b/gi, ' ')
    .replace(/\b\d+\s+shots?\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
    .trim();
  return t;
}

/** Remove size tokens already shown on the size chip (note-only or duplicate phrasing). */
function stripFlowSizeWordsFromNote(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  t = t
    .replace(/\b(venti|grande|tall|large|medium|small|short|xl|xxl|xs)\b/gi, ' ')
    .replace(/\b\d{1,2}\s*oz\b/gi, ' ')
    .replace(/\b\d{2,3}\s*ml\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
    .trim();
  return t;
}

function milkDisplayName(milkKey, milkLabel) {
  if (milkLabel) {
    const t = String(milkLabel).trim();
    if (milkKey === 'whole') return MILK_KEY_DISPLAY.whole;
    if (t.length <= 16) return t;
    return MILK_KEY_DISPLAY[milkKey] || t.slice(0, 14) + '…';
  }
  return MILK_KEY_DISPLAY[milkKey] || 'Milk';
}

/**
 * @param {object} item - line_item
 * @param {Map} modifierSortOrder
 * @param {object} order
 * @param {boolean} showAllergyBar
 * @param {string} allergyLabelEscaped - allergen names only, already HTML-escaped, comma-separated
 */
export function buildDrinkLineModel(item, modifierSortOrder, order, showAllergyBar, allergyLabelEscaped) {
  const names = getModifiers(item, modifierSortOrder).filter((n) => !isRegularSizeModifierLabel(n));
  const noteRawCard =
    item.customer_note != null && String(item.customer_note).trim()
      ? String(item.customer_note).trim()
      : '';
  const milkSnippetsCard = syntheticMilkSnippetsFromNote(noteRawCard);
  const itemNameLower = String(item?.name || '').toLowerCase();
  const hasMilkInName = /\bmilk\s*shake\b/.test(itemNameLower);
  const hasMilkModifier = [...names, ...milkSnippetsCard].some((n) => detectMilkKey(n));
  const hasMilk = hasMilkModifier || hasMilkInName;
  const { milkKey } = extractMilkFromModifierList([...names, ...milkSnippetsCard]);
  const withoutMilk = names.filter((n) => !detectMilkKey(n));

  if (item.variation_name && item.variation_name !== 'Regular') {
    withoutMilk.unshift(item.variation_name);
  }

  const syrupMods = withoutMilk.filter((n) => isSyrupModifier(n));
  const tempCandidates = withoutMilk.filter((n) => isMilkChipTemperature(n));
  const sortedTemps = sortSquareModifiers(tempCandidates);
  const milkTempLabel = sortedTemps[0] ?? null;
  const extraTemps = sortedTemps.slice(1);

  const forCoffeeCols = withoutMilk.filter(
    (n) => !isSyrupModifier(n) && !isMilkChipTemperature(n)
  );

  const square = [...extraTemps];
  const round = [];
  for (const n of forCoffeeCols) {
    const kind = classifyNonMilkModifier(n, { isMilk: false });
    if (kind === 'round') round.push(n);
    else square.push(n);
  }

  const decafChip = hasDecafModifier(names) || decafSuggestedByLineNote(item);
  const bean = beanBadgeFromItem(item, order);
  const squareFiltered =
    decafChip && bean.kind === 'Dc'
      ? square.filter((n) => !/\bdecaf|decaffeinated\b/i.test(String(n)))
      : square;

  return {
    milkKey,
    hasMilk,
    milkTempLabel,
    bean,
    squareMods: sortSquareModifiers(squareFiltered),
    roundMods: sortRoundModifiers(round),
    syrupMods: sortRoundModifiers(syrupMods),
    note:
      item.customer_note != null && String(item.customer_note).trim()
        ? String(item.customer_note).trim()
        : '',
    qty: item.quantity || 1,
    name: item.name || 'Item',
    showAllergyBar,
    allergyLabelEscaped,
  };
}

export function buildFoodLineModel(item) {
  return {
    name: item.name || 'Item',
    qty: item.quantity || 1,
  };
}

export function partitionLineItems(order) {
  const items = order.line_items || [];
  const drinkItems = [];
  const foodItems = [];
  for (const item of items) {
    if (isDrinkItem(item)) drinkItems.push(item);
    else foodItems.push(item);
  }
  return { drinkItems, foodItems };
}

export function serviceLabelUpper(order, isEatIn) {
  return isEatIn ? 'EAT IN' : 'TAKEAWAY';
}

/**
 * Shared Flow prep buckets (syrups, toppings, extras) — same pipeline as buildFlowDrinkModel.
 * @returns {{
 *   names: string[],
 *   noteRaw: string,
 *   milkSnippets: string[],
 *   milkKey: string,
 *   milkLabel: string | null,
 *   hasMilkModifier: boolean,
 *   sizeFromModifier: string | null,
 *   textureMod: string | null,
 *   tempMod: string | null,
 *   syrupMods: string[],
 *   toppingMods: string[],
 *   extraSquare: string[],
 *   extraRound: string[],
 * }}
 */
function extractFlowDrinkPrepBuckets(item, modifierSortOrder, order) {
  const names = getModifiers(item, modifierSortOrder)
    .filter((n) => !isRegularSizeModifierLabel(n))
    .filter((n) => !normalizeServiceModifierOptionName(n));

  const noteRaw =
    item.customer_note != null && String(item.customer_note).trim()
      ? String(item.customer_note).trim()
      : '';
  const milkSnippets = syntheticMilkSnippetsFromNote(noteRaw);
  const { milkKey, milkLabel } = extractMilkFromModifierList([...names, ...milkSnippets]);
  const hasMilkModifier = [...names, ...milkSnippets].some((n) => detectMilkKey(n));

  const withoutMilk = names.filter((n) => !detectMilkKey(n));
  const noShotMods = withoutMilk.filter((n) => !isShotCountModifier(n));

  const flowSizeCandidates = noShotMods.filter((n) => isFlowSizeModifier(n));
  const sizeFromModifier = flowSizeCandidates.length
    ? sortSquareModifiers(flowSizeCandidates)[0]
    : null;
  const noSizeMods = noShotMods.filter((n) => !isFlowSizeModifier(n));

  const textureCandidates = noSizeMods.filter((n) => isTextureModifier(n));
  const textureMod = sortSquareModifiers(textureCandidates)[0] ?? null;

  const tempCandidates = noSizeMods.filter((n) => isFlowMilkTemperature(n));
  const tempMod = sortSquareModifiers(tempCandidates)[0] ?? null;

  const rest = noSizeMods.filter(
    (n) => !isTextureModifier(n) && !isFlowMilkTemperature(n)
  );

  const decafChip = hasDecafModifier(names) || decafSuggestedByLineNote(item);
  const primaryBean = beanBadgeFromItem(item, order);
  const restFiltered =
    decafChip && primaryBean.kind === 'Dc'
      ? rest.filter((n) => !/\bdecaf|decaffeinated\b/i.test(String(n)))
      : rest;

  const syrupMods = [];
  const toppingMods = [];
  const extraSquare = [];
  const extraRound = [];

  for (const n of restFiltered) {
    if (isToppingModifier(n)) {
      toppingMods.push(n);
      continue;
    }
    if (isSyrupModifier(n)) {
      syrupMods.push(n);
      continue;
    }
    const kind = classifyNonMilkModifier(n, { isMilk: false });
    if (kind === 'round') extraRound.push(n);
    else extraSquare.push(n);
  }

  return {
    names,
    noteRaw,
    milkSnippets,
    milkKey,
    milkLabel,
    hasMilkModifier,
    sizeFromModifier,
    textureMod,
    tempMod,
    syrupMods,
    toppingMods,
    extraSquare,
    extraRound,
  };
}

function normalizeFlowClusterKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Syrups, toppings, and extra prep tokens for Flow line clustering (shared modifier edges). */
function flowClusterTokenSetFromBuckets(buckets) {
  const { syrupMods, toppingMods, extraSquare, extraRound } = buckets;
  const tokens = new Set();
  for (const n of syrupMods) {
    const p = flowSyrupChipParts(n);
    if (p.variant) tokens.add(`syrup:${p.variant}`);
    else {
      const d = normalizeFlowClusterKey(p.display);
      if (d) tokens.add(`syrup:${d}`);
    }
  }
  for (const n of toppingMods) {
    const k = normalizeFlowClusterKey(n);
    if (k) tokens.add(`top:${k}`);
  }
  for (const n of extraSquare) {
    const k = normalizeFlowClusterKey(n);
    if (k) tokens.add(`sq:${k}`);
  }
  for (const n of extraRound) {
    const k = normalizeFlowClusterKey(n);
    if (k) tokens.add(`rnd:${k}`);
  }
  return tokens;
}

function clusterTokenSetsIntersect(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

/**
 * Flow: reorder drink lines — group by milk (order of first occurrence), then cluster by shared
 * prep tokens (syrup / topping / extras). Within multi-line clusters, sort by drink name
 * descending so longer names (e.g. Flat White) tend before shorter (Cortado) when tied on modifiers.
 * @param {object[]} drinkItems
 * @param {Map} modifierSortOrder
 * @param {object} order
 * @returns {object[]}
 */
export function sortDrinkItemsForFlow(drinkItems, modifierSortOrder, order) {
  if (!Array.isArray(drinkItems) || drinkItems.length <= 1) return drinkItems;

  const enriched = drinkItems.map((item, origIndex) => {
    const buckets = extractFlowDrinkPrepBuckets(item, modifierSortOrder, order);
    return {
      item,
      origIndex,
      milkKey: buckets.milkKey,
      tokens: flowClusterTokenSetFromBuckets(buckets),
    };
  });

  const milkKeysInOrder = [];
  const seen = new Set();
  for (const e of enriched) {
    if (!seen.has(e.milkKey)) {
      seen.add(e.milkKey);
      milkKeysInOrder.push(e.milkKey);
    }
  }

  const result = [];
  for (const milkKey of milkKeysInOrder) {
    const group = enriched.filter((e) => e.milkKey === milkKey);
    const n = group.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    function find(i) {
      return parent[i] === i ? i : (parent[i] = find(parent[i]));
    }
    function union(i, j) {
      const pi = find(i);
      const pj = find(j);
      if (pi !== pj) parent[pj] = pi;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (clusterTokenSetsIntersect(group[i].tokens, group[j].tokens)) union(i, j);
      }
    }

    const byRoot = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(group[i]);
    }

    const components = [...byRoot.values()];
    components.sort((a, b) => {
      const minA = Math.min(...a.map((x) => x.origIndex));
      const minB = Math.min(...b.map((x) => x.origIndex));
      return minA - minB;
    });

    for (const comp of components) {
      if (comp.length === 1) {
        result.push(comp[0].item);
      } else {
        comp.sort((a, b) => {
          const nameA = String(a.item.name || 'Item');
          const nameB = String(b.item.name || 'Item');
          const c = nameB.localeCompare(nameA, undefined, { sensitivity: 'base' });
          if (c !== 0) return c;
          return a.origIndex - b.origIndex;
        });
        for (const x of comp) result.push(x.item);
      }
    }
  }

  return result;
}

/**
 * Flow view: one drink row model (3 columns).
 */
export function buildFlowDrinkModel(item, modifierSortOrder, order, showAllergyBar, allergyLabelEscaped) {
  if (!SMART_NOTE_PARSING_ENABLED) {
    const buckets = extractFlowDrinkPrepBuckets(item, modifierSortOrder, order);
    const noteRaw = getMergedLineNote(item);
    const primaryBean = beanBadgeFromItem(item, order);
    const shotInfo = extractShotInfo(item);
    const showBeans = isCoffeeBeanItem(item);
    /** @type {{ kind: string, label: string, shots: number, isGhost: boolean }[]} */
    let beans = [];
    const prepBeans = item.kds_prep?.version === 1 && Array.isArray(item.kds_prep.beans) ? item.kds_prep.beans : null;
    if (showBeans) {
      if (prepBeans && prepBeans.length > 0) {
        beans = prepBeans;
      } else if (shotInfo.splitBeans) {
        const { decaf, house } = shotInfo.splitBeans;
        beans = [
          { kind: 'Dc', label: 'Dc', shots: decaf, isGhost: false },
          { kind: 'Ho', label: 'Ho', shots: house, isGhost: false },
        ];
      } else {
        const shots = shotInfo.totalShots;
        const isGhost =
          primaryBean.kind === 'Ho' && shots === DEFAULT_SHOTS && !shotInfo.isNonStandard;
        beans = [
          {
            kind: primaryBean.kind,
            label: primaryBean.label,
            shots,
            isGhost,
          },
        ];
      }
    }
    const sizeFromVariation =
      item.variation_name && String(item.variation_name).trim() && item.variation_name !== 'Regular'
        ? String(item.variation_name).trim()
        : null;
    const sizeRaw = sizeFromVariation ?? buckets.sizeFromModifier;
    const sizeChip = sizeRaw ? String(sizeRaw).trim().toUpperCase() : null;

    return {
      milkKey: buckets.milkKey,
      milkChipLabel: '',
      milkChipSegments: [],
      milkChipWidthPx: 50,
      showMilkChip: false,
      syrupChips: [],
      toppingChips: [],
      extraSquareChips: [],
      extraRoundChips: [],
      beans,
      name: item.name || 'Item',
      sizeChip,
      qty: item.quantity || 1,
      note: noteRaw,
      lineAllergyNoteEscaped: '',
      showAllergyBar,
      allergyLabelEscaped,
      showNoteAsRaw: true,
    };
  }

  const buckets = extractFlowDrinkPrepBuckets(item, modifierSortOrder, order);
  const {
    names,
    noteRaw,
    milkSnippets,
    milkKey,
    milkLabel,
    hasMilkModifier,
    sizeFromModifier,
    textureMod,
    tempMod,
    syrupMods,
    toppingMods,
    extraSquare,
    extraRound,
  } = buckets;

  const primaryBean = beanBadgeFromItem(item, order);

  const flowMilkScanText = buildFlowMilkScanText(names, noteRaw);
  const textureFromParser = parseFlowMilkTextureFromText(flowMilkScanText);
  const tempFromParser = parseFlowMilkTemperatureFromText(flowMilkScanText);
  const textureFromNote = parseFlowMilkTextureFromText(noteRaw);
  const tempFromNote = parseFlowMilkTemperatureFromText(noteRaw);
  const textureForChip = textureFromParser ?? textureMod;
  const tempForChip = tempFromParser ?? tempMod;
  const hasMilkChipContext = Boolean(hasMilkModifier || textureForChip || tempForChip);
  const milkNameForChip = hasMilkChipContext ? milkDisplayName(milkKey, milkLabel) : '';
  const milkChipLabel = buildMilkChipLabel(
    milkNameForChip || null,
    textureForChip,
    tempForChip
  );
  const milkChipSegments = buildMilkChipSegments(
    milkNameForChip || null,
    textureForChip,
    tempForChip
  );

  const shotInfo = extractShotInfo(item);
  const showBeans = isCoffeeBeanItem(item);

  /** @type {{ kind: string, label: string, shots: number, isGhost: boolean }[]} */
  let beans = [];
  const prepBeans = item.kds_prep?.version === 1 && Array.isArray(item.kds_prep.beans) ? item.kds_prep.beans : null;
  if (showBeans) {
    if (prepBeans && prepBeans.length > 0) {
      beans = prepBeans;
    } else if (shotInfo.splitBeans) {
      const { decaf, house } = shotInfo.splitBeans;
      beans = [
        {
          kind: 'Dc',
          label: 'Dc',
          shots: decaf,
          isGhost: false,
        },
        {
          kind: 'Ho',
          label: 'Ho',
          shots: house,
          isGhost: false,
        },
      ];
    } else {
      const shots = shotInfo.totalShots;
      const isGhost =
        primaryBean.kind === 'Ho' && shots === DEFAULT_SHOTS && !shotInfo.isNonStandard;
      beans = [
        {
          kind: primaryBean.kind,
          label: primaryBean.label,
          shots,
          isGhost,
        },
      ];
    }
  }

  const sizeFromVariation =
    item.variation_name && String(item.variation_name).trim() && item.variation_name !== 'Regular'
      ? String(item.variation_name).trim()
      : null;
  const sizeFromNote = flowSizeLabelFromNote(noteRaw);
  const sizeRaw = sizeFromVariation ?? sizeFromModifier ?? sizeFromNote;
  const sizeChip = sizeRaw ? String(sizeRaw).trim().toUpperCase() : null;

  const hasTextureInChip = Boolean(textureForChip);
  const hasTempInChip = Boolean(tempForChip);
  const milkChipWidthPx =
    50 + (hasTextureInChip ? 40 : 0) + (hasTempInChip ? 40 : 0);

  const noteAfterShotStrip = stripFlowShotNoteFragments(
    textureFromNote || tempFromNote ? '' : noteRaw
  );

  const lineNoteHasAllergy = /\ballergy\b/i.test(noteRaw);
  /** Pre-escaped HTML for line-note allergy alert (full note when keyword matches). */
  const lineAllergyNoteEscaped = lineNoteHasAllergy ? escapeHtml(noteRaw) : '';
  let noteForDetail = lineNoteHasAllergy ? '' : noteAfterShotStrip;
  if (noteForDetail && flowSizeLabelFromNote(noteRaw)) {
    noteForDetail = stripFlowSizeWordsFromNote(noteForDetail);
  }

  return {
    milkKey,
    milkChipLabel: milkChipLabel.trim(),
    milkChipSegments,
    milkChipWidthPx,
    showMilkChip: Boolean(milkChipLabel && milkChipLabel.trim()),
    syrupChips: sortRoundModifiers(syrupMods).map((name) => flowSyrupChipParts(name)),
    toppingChips: sortRoundModifiers(toppingMods),
    extraSquareChips: sortSquareModifiers(extraSquare),
    extraRoundChips: sortRoundModifiers(extraRound),
    beans,
    name: item.name || 'Item',
    sizeChip,
    qty: item.quantity || 1,
    note: noteForDetail,
    lineAllergyNoteEscaped,
    showAllergyBar,
    allergyLabelEscaped,
    showNoteAsRaw: false,
  };
}

/**
 * Flow view: one food row model.
 */
export function buildFlowFoodModel(item, modifierSortOrder) {
  if (!SMART_NOTE_PARSING_ENABLED) {
    const raw = getMergedLineNote(item);
    const names = getModifiers(item, modifierSortOrder)
      .filter((n) => !isRegularSizeModifierLabel(n))
      .filter((n) => !normalizeServiceModifierOptionName(n));
    const modText = names.length ? names.join(', ') : '';
    const prepText = [raw, modText].filter(Boolean).join(raw && modText ? ' · ' : '');
    return {
      name: item.name || 'Item',
      qty: item.quantity || 1,
      prepText,
      lineAllergyNoteEscaped: '',
      showPrepAsRaw: true,
    };
  }

  const noteRaw =
    item.customer_note != null && String(item.customer_note).trim()
      ? String(item.customer_note).trim()
      : '';
  const lineNoteHasAllergy = /\ballergy\b/i.test(noteRaw);
  const lineAllergyNoteEscaped = lineNoteHasAllergy ? escapeHtml(noteRaw) : '';
  const noteForPrep = lineNoteHasAllergy
    ? ''
    : noteRaw
        .replace(/\b(?:in|out)\b/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
  const names = getModifiers(item, modifierSortOrder)
    .filter((n) => !isRegularSizeModifierLabel(n))
    .filter((n) => !normalizeServiceModifierOptionName(n));
  const modText = names.length ? names.join(', ') : '';
  const prepText = noteForPrep || modText || '';
  return {
    name: item.name || 'Item',
    qty: item.quantity || 1,
    prepText,
    lineAllergyNoteEscaped,
    showPrepAsRaw: false,
  };
}

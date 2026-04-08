/**
 * Pure view-model builders for KDS Concept C cards and Flow view.
 */

import { getModifiers, isDrinkItem, isCoffeeBeanItem } from './helpers.js';
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
} from './kds-modifier-config.js';
import {
  buildFlowMilkScanText,
  parseFlowMilkTextureFromText,
  parseFlowMilkTemperatureFromText,
} from './kds-milk-test-parser.js';

const DEFAULT_SHOTS = 2;

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
  const itemNameLower = String(item?.name || '').toLowerCase();
  const hasMilkInName = /\bmilk\s*shake\b/.test(itemNameLower);
  const hasMilkModifier = names.some((n) => detectMilkKey(n));
  const hasMilk = hasMilkModifier || hasMilkInName;
  const { milkKey } = extractMilkFromModifierList(names);
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

  const decafChip = hasDecafModifier(names);
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
 * Flow view: one drink row model (3 columns).
 */
export function buildFlowDrinkModel(item, modifierSortOrder, order, showAllergyBar, allergyLabelEscaped) {
  const names = getModifiers(item, modifierSortOrder)
    .filter((n) => !isRegularSizeModifierLabel(n))
    .filter((n) => !normalizeServiceModifierOptionName(n));
  const { milkKey, milkLabel } = extractMilkFromModifierList(names);
  const hasMilkModifier = names.some((n) => detectMilkKey(n));

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

  const decafChip = hasDecafModifier(names);
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

  const noteRaw =
    item.customer_note != null && String(item.customer_note).trim()
      ? String(item.customer_note).trim()
      : '';
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
  if (showBeans) {
    if (shotInfo.splitBeans) {
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
  const sizeRaw = sizeFromVariation ?? sizeFromModifier;
  const sizeChip = sizeRaw ? String(sizeRaw).trim().toUpperCase() : null;

  const hasTextureInChip = Boolean(textureForChip);
  const hasTempInChip = Boolean(tempForChip);
  const milkChipWidthPx =
    50 + (hasTextureInChip ? 40 : 0) + (hasTempInChip ? 40 : 0);

  const noteForDetail = stripFlowShotNoteFragments(
    textureFromNote || tempFromNote ? '' : noteRaw
  );

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
    showAllergyBar,
    allergyLabelEscaped,
  };
}

/**
 * Flow view: one food row model.
 */
export function buildFlowFoodModel(item, modifierSortOrder) {
  const noteRaw =
    item.customer_note != null && String(item.customer_note).trim()
      ? String(item.customer_note).trim()
      : '';
  const note = noteRaw
    .replace(/\b(?:in|out)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const names = getModifiers(item, modifierSortOrder)
    .filter((n) => !isRegularSizeModifierLabel(n))
    .filter((n) => !normalizeServiceModifierOptionName(n));
  const modText = names.length ? names.join(', ') : '';
  const prepText = note || modText || '';
  return {
    name: item.name || 'Item',
    qty: item.quantity || 1,
    prepText,
  };
}

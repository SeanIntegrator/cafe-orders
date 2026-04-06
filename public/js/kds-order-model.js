/**
 * Pure view-model builders for KDS Concept C cards.
 */

import { getModifiers, isDrinkItem } from './helpers.js';
import {
  extractMilkFromModifierList,
  detectMilkKey,
  beanBadgeFromItem,
  classifyNonMilkModifier,
  sortSquareModifiers,
  sortRoundModifiers,
  hasDecafModifier,
  isSyrupModifier,
  isMilkChipTemperature,
} from './kds-modifier-config.js';

/**
 * @param {object} item - line_item
 * @param {Map} modifierSortOrder
 * @param {object} order
 * @param {boolean} showAllergyBar
 * @param {string} allergyLabelEscaped - allergen names only, already HTML-escaped, comma-separated
 */
export function buildDrinkLineModel(item, modifierSortOrder, order, showAllergyBar, allergyLabelEscaped) {
  const names = getModifiers(item, modifierSortOrder);
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

/** Pure utility functions — no DOM, no side-effects. */

export { shouldShowOrderOnKds } from './kds-visibility.js';

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isEatInOrder(order) {
  const fulfillment = order.fulfillments?.[0];
  if (!fulfillment) return true; // default eat-in for café
  return fulfillment.type === 'DINE_IN' || !fulfillment.type;
}

export function getCustomerName(order) {
  const pickup = order.fulfillments?.[0]?.pickup_details;
  if (pickup?.recipient?.display_name) return pickup.recipient.display_name;
  if (order.customer_id) return 'Customer';
  return 'Walk-in';
}

/** Flow header: app vs POS / walk-in. */
export function getOrderSource(order) {
  const name = order?.fulfillments?.[0]?.pickup_details?.recipient?.display_name;
  if (name != null && String(name).trim()) return 'APP ORDER';
  return 'WALK IN';
}

/**
 * Map a Square "Service" modifier option name to Flow header label.
 * @param {string} name - modifier display name from line item
 * @returns {'SIT IN'|'TAKEAWAY'|'PICKUP'|null}
 */
export function normalizeServiceModifierOptionName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  if (/^in$/.test(s) || /\b(in|for\s*here)\b/.test(s)) return 'SIT IN';
  if (/^out$/.test(s) || /\b(out|to\s*go)\b/.test(s)) return 'TAKEAWAY';
  if (/\b(pick\s*up|pickup)\b/.test(s) || s.includes('pick up')) return 'PICKUP';
  if (/\b(sit\s*in|eat\s*in|dine\s*in|for\s*here)\b/.test(s)) return 'SIT IN';
  if (/\b(take\s*away|takeaway|to\s*go)\b/.test(s)) return 'TAKEAWAY';
  if (s.includes('pickup')) return 'PICKUP';
  if (s.includes('sit') || s.includes('eat in') || s.includes('dine in')) return 'SIT IN';
  if (s.includes('take away') || s.includes('takeaway') || s.includes('to go')) return 'TAKEAWAY';
  return null;
}

/**
 * First matching Service-list modifier on the order (any line item).
 * @param {object} order
 * @param {Set<string>|null|undefined} serviceOptionIds - from catalog (modifier lists named with "service")
 * @returns {'SIT IN'|'TAKEAWAY'|'PICKUP'|null}
 */
export function getServiceChoiceFromModifiers(order, serviceOptionIds) {
  const items = order?.line_items || [];
  let sawSitIn = false;
  let sawTakeaway = false;
  let sawPickup = false;

  for (const item of items) {
    for (const m of item.modifiers || []) {
      const id = m?.catalog_object_id;
      const label = normalizeServiceModifierOptionName(m.name);
      const fromServiceList = Boolean(id && serviceOptionIds && serviceOptionIds.has(id));
      const fromRawToken = /\b(in|out)\b/i.test(String(m?.name || '').trim());
      if (!label || (!fromServiceList && !fromRawToken)) continue;

      if (label === 'SIT IN') sawSitIn = true;
      else if (label === 'TAKEAWAY') sawTakeaway = true;
      else if (label === 'PICKUP') sawPickup = true;
    }
  }
  if (sawSitIn) return 'SIT IN';
  if (sawTakeaway) return 'TAKEAWAY';
  if (sawPickup) return 'PICKUP';
  return null;
}

/**
 * Service type for Flow header.
 * @param {object} order
 * @param {boolean} isEatIn - from isEatInOrder(order)
 * @param {Set<string>|null|undefined} [serviceOptionIds] - optional; when set, Square Service modifier wins
 */
export function getServiceLabel(order, isEatIn, serviceOptionIds) {
  const fromMod = getServiceChoiceFromModifiers(order, serviceOptionIds);
  if (fromMod) return fromMod;
  const type = order?.fulfillments?.[0]?.type;
  if (type === 'PICKUP') return 'PICKUP';
  if (isEatIn) return 'SIT IN';
  return 'TAKEAWAY';
}

/**
 * Show espresso bean badges only for coffee-style drinks (not matcha/chai/hot choc/tea-only).
 * Matcha/chai drinks often include "latte" in the name — exclude those before keyword checks.
 */
export function isCoffeeBeanItem(item) {
  const name = (item?.name || '').toLowerCase();
  if (/\bmatcha\b/.test(name)) return false;
  if (/\bchai\b/.test(name)) return false;
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
 * Returns modifier names in display order: first category (e.g. Milk) first, then rest.
 * Uses modifier-categories from Square so milk chip and extras are correct regardless of payload order.
 */
export function getModifiers(item, modifierSortOrder) {
  if (!item.modifiers || !item.modifiers.length) return [];
  const withOrder = item.modifiers.map((m) => {
    const kds = m.kds_sort_order;
    const fromCatalog = modifierSortOrder.has(m.catalog_object_id)
      ? modifierSortOrder.get(m.catalog_object_id)
      : 999;
    const order =
      kds != null && Number.isFinite(Number(kds)) ? Number(kds) : fromCatalog;
    return { name: m.name, order };
  });
  withOrder.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  });
  return withOrder.map((m) => m.name);
}

export function getMilkChipClass(label) {
  const t = (label || '').toLowerCase();
  if (t.includes('coconut')) return 'milk-chip--coconut';
  if (t.includes('almond')) return 'milk-chip--almond';
  if (t.includes('soy')) return 'milk-chip--soy';
  if (t.includes('oat')) return 'milk-chip--oat';
  if (t.includes('skinny')) return 'milk-chip--skinny';
  return '';
}

export function isDrinkItem(item) {
  const name = (item.name || '').toLowerCase();
  const hasDrinkKeyword = [
    'coffee', 'latte', 'flat white', 'cappuccino', 'americano',
    'espresso', 'mocha', 'macchiato', 'tea', 'matcha', 'chai',
    'long black', 'short black', 'cold brew', 'cortado', 'ristretto',
    'filter', 'pour over', 'hot chocolate', 'hot choc', 'affogato',
    'frappe', 'smoothie', 'juice', 'lemonade', 'milk shake', 'milkshake',
    'cooler', 'spritz', 'water',
  ].some((word) => name.includes(word));
  if (hasDrinkKeyword) return true;

  return /\b(?:\w*ade|can)\b/.test(name);
}

export function formatMoney(money) {
  if (!money) return '';
  return `£${(money.amount / 100).toFixed(2)}`;
}

export function getInitial(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Parse ISO 8601 duration (e.g. PT12M, PT1H30M) to milliseconds. */
export function parseIsoDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.trim().toUpperCase().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const mins = parseInt(match[2] || '0', 10);
  const secs = parseFloat(match[3] || '0');
  return (hours * 3600 + mins * 60 + secs) * 1000;
}

/** Get ready-at timestamp from order (pickup_at or created_at + prep_time_duration). */
export function getOrderReadyAt(order) {
  const fulfillment = order?.fulfillments?.[0];
  const pickup = fulfillment?.pickup_details;
  if (!pickup) return null;
  if (pickup.pickup_at) {
    const t = new Date(pickup.pickup_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const created = order?.created_at;
  const prepMs = parseIsoDuration(pickup.prep_time_duration);
  if (created && prepMs != null) {
    const t = new Date(created).getTime() + prepMs;
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export function getEtaLabelText(order) {
  if (isEatInOrder(order)) return 'Eat in';
  const readyAt = getOrderReadyAt(order);
  if (readyAt == null) return 'Takeaway';
  const remainingMs = readyAt - Date.now();
  const remainingMins = Math.max(0, Math.ceil(remainingMs / 60000));
  if (remainingMins === 0) return 'Due now';
  if (remainingMins === 1) return 'Pickup in 1 min';
  return `Pickup in ${remainingMins} mins`;
}


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

/**
 * Returns modifier names in display order: first category (e.g. Milk) first, then rest.
 * Uses modifier-categories from Square so milk chip and extras are correct regardless of payload order.
 */
export function getModifiers(item, modifierSortOrder) {
  if (!item.modifiers || !item.modifiers.length) return [];
  const withOrder = item.modifiers.map((m) => ({
    name: m.name,
    order: modifierSortOrder.has(m.catalog_object_id)
      ? modifierSortOrder.get(m.catalog_object_id)
      : 999,
  }));
  withOrder.sort((a, b) => a.order - b.order);
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
  return [
    'coffee', 'latte', 'flat white', 'cappuccino', 'americano',
    'espresso', 'mocha', 'macchiato', 'tea', 'matcha', 'chai',
    'long black', 'short black', 'cold brew', 'cortado', 'ristretto',
    'filter', 'pour over', 'hot chocolate', 'hot choc', 'affogato',
    'frappe', 'smoothie', 'juice', 'lemonade', 'milk shake', 'milkshake',
  ].some((word) => name.includes(word));
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


/**
 * Single KDS contract for Square POS + web-app merged orders: merged line notes, shaped modifiers,
 * optional kds_sort_order for site-specific catalog grouping, and kds_prep hints for Flow.
 */

const { buildKdsPrep } = require('./kds-prep-model');
const { kdsSortOrderForExModifier } = require('./kds-site-config');

const MAX_CUSTOMER_NOTE_LEN = 500;

/**
 * @param {string|null|undefined} customerNote
 * @param {string|null|undefined} squareLineNote
 */
function mergedLineNote(customerNote, squareLineNote) {
  const a = customerNote != null ? String(customerNote).trim() : '';
  const b = squareLineNote != null ? String(squareLineNote).trim() : '';
  if (!a) return b.slice(0, MAX_CUSTOMER_NOTE_LEN);
  if (!b) return a.slice(0, MAX_CUSTOMER_NOTE_LEN);
  if (a === b) return a.slice(0, MAX_CUSTOMER_NOTE_LEN);
  const out = `${a} ${b}`.replace(/\s+/g, ' ').trim();
  return out.slice(0, MAX_CUSTOMER_NOTE_LEN);
}

/**
 * @param {object[]|null|undefined} modifiers
 * @returns {object[]}
 */
function normalizeModifiers(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers : [];
  const out = [];
  for (const m of list) {
    const name = m?.name != null ? String(m.name).trim() : '';
    if (!name) continue;
    const id = m?.catalog_object_id != null ? String(m.catalog_object_id) : '';
    const row = { name, catalog_object_id: id };
    if (m.quantity != null) row.quantity = m.quantity;
    const sort = kdsSortOrderForExModifier(id, name);
    if (sort != null) row.kds_sort_order = sort;
    out.push(row);
  }
  return out;
}

/**
 * @param {object} item - Square or DB-shaped line item
 * @param {object} order - parent order
 * @returns {object}
 */
function normalizeKdsLineItem(item, order) {
  const merged = mergedLineNote(item.customer_note, item.note);
  const base = { ...item };
  if (merged) {
    base.customer_note = merged;
    base.note = merged;
  } else {
    delete base.customer_note;
    delete base.note;
  }
  base.modifiers = normalizeModifiers(item.modifiers);
  try {
    base.kds_prep = buildKdsPrep(base, order);
  } catch (e) {
    console.warn('normalizeKdsLineItem: kds_prep failed', e.message);
  }
  return base;
}

/**
 * @param {object} order
 * @returns {object}
 */
function normalizeKdsOrder(order) {
  if (!order || typeof order !== 'object') return order;
  const line_items = Array.isArray(order.line_items)
    ? order.line_items.map((li) => normalizeKdsLineItem(li, order))
    : order.line_items;
  return { ...order, line_items };
}

/**
 * @param {object[]} orders
 * @returns {object[]}
 */
function normalizeKdsOrders(orders) {
  if (!Array.isArray(orders)) return orders;
  return orders.map((o) => normalizeKdsOrder(o));
}

/**
 * Fetch DB overlay when present (same as hybrid merge), then normalize. Used for webhook single-order emit.
 * @param {object|null|undefined} squareOrder
 * @returns {Promise<object|null>}
 */
async function resolveOrderForKdsDisplay(squareOrder) {
  if (!squareOrder || typeof squareOrder !== 'object') return null;
  try {
    const { fetchWebAppOrderBySquareIdWithItems } = require('./orders-db');
    const { overlayWebAppDbOnSquareOrder } = require('./kds-merge');
    if (squareOrder.id) {
      const dbOverlay = await fetchWebAppOrderBySquareIdWithItems(squareOrder.id);
      if (dbOverlay) {
        const merged = overlayWebAppDbOnSquareOrder(squareOrder, dbOverlay);
        return normalizeKdsOrder(merged);
      }
    }
  } catch (e) {
    console.warn('resolveOrderForKdsDisplay:', e.message);
  }
  return normalizeKdsOrder(squareOrder);
}

module.exports = {
  mergedLineNote,
  normalizeModifiers,
  normalizeKdsLineItem,
  normalizeKdsOrder,
  normalizeKdsOrders,
  resolveOrderForKdsDisplay,
  MAX_CUSTOMER_NOTE_LEN,
};

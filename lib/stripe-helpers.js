/**
 * Server-side cart pricing from Square catalog (never trust client unit_price).
 */

function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase();
}

/** @param {object[]} categories from listModifierCategories */
function buildModifierLookup(categories) {
  const map = new Map();
  for (const cat of categories) {
    for (const m of cat.modifiers || []) {
      const key = normalizeName(m.name);
      if (key && !map.has(key)) {
        map.set(key, { id: m.id, price: Number(m.price) || 0 });
      }
    }
  }
  return map;
}

/**
 * @param {object[]} clientLineItems - same shape as customer orderLineItemsFromCartItems
 * @param {{ id: string, name: string, price: number|null }[]} catalogItems
 * @param {object[]} modifierCategories
 */
function enrichLineItemsForCheckout(clientLineItems, catalogItems, modifierCategories) {
  const varById = new Map(catalogItems.map((i) => [i.id, i]));
  const modLookup = buildModifierLookup(modifierCategories);
  const enriched = [];

  for (const li of clientLineItems) {
    const vid = li.catalog_object_id;
    const v = varById.get(vid);
    if (!v || v.price == null) {
      const err = new Error(`Unknown or unpriced catalog variation: ${vid || 'missing'}`);
      err.code = 'CATALOG';
      throw err;
    }

    const qty = parseInt(String(li.quantity), 10) || 1;
    let unitPence = v.price;
    const rawMods = Array.isArray(li.modifiers) ? li.modifiers : [];
    const resolvedMods = [];
    const squareModifierIds = [];

    for (const m of rawMods) {
      const name = typeof m === 'object' && m != null ? m.name : m;
      const key = normalizeName(name);
      if (!key) continue;
      const hit = modLookup.get(key);
      if (!hit) {
        const err = new Error(`Unknown modifier (check Square catalog name matches app): "${name}"`);
        err.code = 'CATALOG';
        throw err;
      }
      resolvedMods.push({
        name: String(name).trim(),
        price: hit.price,
        catalog_object_id: hit.id,
      });
      unitPence += hit.price;
      squareModifierIds.push(hit.id);
    }

    enriched.push({
      catalog_object_id: vid,
      quantity: qty,
      item_name: li.item_name || v.name || 'Item',
      unit_price: unitPence,
      modifiers: resolvedMods,
      square_modifier_ids: squareModifierIds,
      emoji: li.emoji,
      customer_note: li.customer_note,
    });
  }

  return enriched;
}

function totalSmallestUnit(enriched) {
  return enriched.reduce((sum, li) => sum + li.unit_price * li.quantity, 0);
}

/** Strip webhook-only fields before normalizeLineItems. */
function lineItemsForPersistence(enriched) {
  return enriched.map(({ square_modifier_ids, ...rest }) => ({ ...rest }));
}

module.exports = {
  enrichLineItemsForCheckout,
  totalSmallestUnit,
  lineItemsForPersistence,
};

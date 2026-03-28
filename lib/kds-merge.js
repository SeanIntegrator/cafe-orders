/**
 * Hybrid KDS list: Square open orders merged with Postgres web_app rows.
 */

const { pool, fetchOpenWebAppOrdersWithItems, kdsLineItemsFromDbRows } = require('./orders-db');

async function filterOrdersHiddenByDb(squareOrders) {
  const ids = squareOrders.map((o) => o.id).filter(Boolean);
  if (ids.length === 0) return squareOrders;
  try {
    const { rows } = await pool.query(
      `SELECT square_order_id FROM orders
       WHERE square_order_id = ANY($1::text[]) AND status = 'completed'`,
      [ids]
    );
    const done = new Set(rows.map((r) => r.square_order_id));
    return squareOrders.filter((o) => !done.has(o.id));
  } catch (e) {
    console.warn('GET /api/orders: could not filter DB-completed orders:', e.message);
    return squareOrders;
  }
}

function pickupIsoFromDb(dbOrder) {
  if (!dbOrder.pickup_time) return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const t =
    dbOrder.pickup_time instanceof Date ? dbOrder.pickup_time : new Date(dbOrder.pickup_time);
  return Number.isNaN(t.getTime())
    ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
    : t.toISOString();
}

function overlayWebAppDbOnSquareOrder(squareOrder, dbOrder) {
  const line_items = kdsLineItemsFromDbRows(dbOrder.items);
  const currency = squareOrder.total_money?.currency || 'GBP';
  const merged = {
    ...squareOrder,
    line_items,
    total_money: { amount: dbOrder.total_amount, currency },
  };
  const fulfillments = Array.isArray(squareOrder.fulfillments) && squareOrder.fulfillments.length
    ? squareOrder.fulfillments.map((f, i) => {
        if (i !== 0) return f;
        const pd = { ...(f.pickup_details || {}) };
        pd.recipient = { ...(pd.recipient || {}), display_name: dbOrder.customer_name || 'Customer' };
        if (dbOrder.notes != null) pd.note = dbOrder.notes;
        pd.pickup_at = pickupIsoFromDb(dbOrder);
        return { ...f, pickup_details: { ...pd } };
      })
    : [
        {
          type: 'PICKUP',
          state: 'PROPOSED',
          pickup_details: {
            recipient: { display_name: dbOrder.customer_name || 'Customer' },
            note: dbOrder.notes || '',
            pickup_at: pickupIsoFromDb(dbOrder),
          },
        },
      ];
  merged.fulfillments = fulfillments;
  return merged;
}

function syntheticOpenOrderFromDb(dbOrder) {
  return {
    id: dbOrder.square_order_id,
    state: 'OPEN',
    version: 0,
    line_items: kdsLineItemsFromDbRows(dbOrder.items),
    fulfillments: [
      {
        type: 'PICKUP',
        state: 'PROPOSED',
        pickup_details: {
          recipient: { display_name: dbOrder.customer_name || 'Customer' },
          note: dbOrder.notes || '',
          pickup_at: pickupIsoFromDb(dbOrder),
        },
      },
    ],
    total_money: { amount: dbOrder.total_amount, currency: 'GBP' },
    tenders: [],
  };
}

/**
 * @param {() => Promise<object[]>} searchOpenOrders - e.g. square.searchOpenOrders
 * @returns {Promise<object[]>}
 */
async function mergeOpenOrdersWithWebAppDb(searchOpenOrders) {
  let orders = await searchOpenOrders();
  orders = await filterOrdersHiddenByDb(orders);
  const squareIds = new Set(orders.map((o) => o.id).filter(Boolean));

  let dbWebApp = [];
  try {
    dbWebApp = await fetchOpenWebAppOrdersWithItems();
  } catch (e) {
    console.warn('GET /api/orders: could not load web_app orders from DB:', e.message);
  }

  const dbBySquareId = new Map(dbWebApp.map((o) => [o.square_order_id, o]));

  const mergedList = orders.map((sq) => {
    const dbRow = dbBySquareId.get(sq.id);
    if (dbRow) {
      dbBySquareId.delete(sq.id);
      return overlayWebAppDbOnSquareOrder(sq, dbRow);
    }
    return sq;
  });

  for (const dbRow of dbBySquareId.values()) {
    if (!squareIds.has(dbRow.square_order_id)) {
      mergedList.push(syntheticOpenOrderFromDb(dbRow));
    }
  }

  return mergedList;
}

module.exports = {
  mergeOpenOrdersWithWebAppDb,
  filterOrdersHiddenByDb,
  pickupIsoFromDb,
  overlayWebAppDbOnSquareOrder,
  syntheticOpenOrderFromDb,
};

const pool = require('../db');

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((li) => {
    const qty = parseInt(String(li.quantity), 10) || 1;
    const unit = Math.round(Number(li.unit_price) || 0);
    const modifiers = Array.isArray(li.modifiers) ? li.modifiers : [];
    return {
      square_variation_id: li.catalog_object_id || li.square_variation_id || null,
      item_name: String(li.item_name || 'Item').slice(0, 500),
      quantity: qty,
      unit_price: unit,
      modifiers,
      item_emoji: li.emoji || li.item_emoji || null,
    };
  });
}

function computeTotal(normalized) {
  return normalized.reduce((sum, r) => sum + r.unit_price * r.quantity, 0);
}

function pickupTimeFromMinutes(pickupMinutes) {
  const m = Number(pickupMinutes);
  const pickupMs = m === 0 ? 5 * 60 * 1000 : (Number.isFinite(m) ? m : 15) * 60 * 1000;
  return new Date(Date.now() + pickupMs);
}

async function insertOrderWithItems(client, params) {
  const {
    squareOrderId,
    userId,
    customerName,
    notes,
    totalAmount,
    orderSource,
    pickupTime,
    cafeId = 1,
    status = 'confirmed',
    normalizedItems,
  } = params;

  const ins = await client.query(
    `INSERT INTO orders (square_order_id, user_id, customer_name, notes, total_amount, status, order_source, pickup_time, cafe_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      squareOrderId,
      userId || null,
      customerName,
      notes || null,
      totalAmount,
      status,
      orderSource,
      pickupTime,
      cafeId,
    ]
  );
  const orderId = ins.rows[0].id;
  for (const row of normalizedItems) {
    await client.query(
      `INSERT INTO order_items (order_id, square_variation_id, item_name, item_emoji, quantity, unit_price, modifiers)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        orderId,
        row.square_variation_id,
        row.item_name,
        row.item_emoji,
        row.quantity,
        row.unit_price,
        JSON.stringify(row.modifiers),
      ]
    );
  }
  return orderId;
}

/**
 * After Square order is created, persist mirror row + line items.
 */
async function persistOrderFromCheckout({
  squareOrderId,
  userId,
  customerName,
  note,
  pickupMinutes,
  rawLineItems,
  orderSource,
}) {
  const normalized = normalizeLineItems(rawLineItems);
  const totalAmount = computeTotal(normalized);
  const pickupTime = pickupTimeFromMinutes(pickupMinutes);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderId = await insertOrderWithItems(client, {
      squareOrderId,
      userId,
      customerName,
      notes: note,
      totalAmount,
      orderSource,
      pickupTime,
      normalizedItems: normalized,
    });
    await client.query('COMMIT');
    return { dbOrderId: orderId, totalAmount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Replace line items and update order header (editable statuses only — caller checks).
 */
async function updateOrderLineItemsAndMeta(orderId, userId, patch) {
  const {
    customer_name: customerName,
    note,
    pickup_minutes: pickupMinutes,
    line_items: rawLineItems,
  } = patch;

  const normalized = normalizeLineItems(rawLineItems);
  if (normalized.length === 0) {
    const err = new Error('line_items must contain at least one item');
    err.code = 'VALIDATION';
    throw err;
  }
  const totalAmount = computeTotal(normalized);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId]
    );
    if (sel.rows.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const ex = sel.rows[0];
    const status = ex.status;
    if (!['pending', 'confirmed'].includes(status)) {
      await client.query('ROLLBACK');
      const err = new Error('FORBIDDEN');
      err.code = 'FORBIDDEN';
      throw err;
    }

    const finalName = customerName !== undefined ? customerName : ex.customer_name;
    const finalNote = note !== undefined ? note : ex.notes;
    const finalPickupTime =
      pickupMinutes !== undefined ? pickupTimeFromMinutes(pickupMinutes) : ex.pickup_time;

    await client.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
    for (const row of normalized) {
      await client.query(
        `INSERT INTO order_items (order_id, square_variation_id, item_name, item_emoji, quantity, unit_price, modifiers)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          orderId,
          row.square_variation_id,
          row.item_name,
          row.item_emoji,
          row.quantity,
          row.unit_price,
          JSON.stringify(row.modifiers),
        ]
      );
    }

    await client.query(
      `UPDATE orders SET
        customer_name = $2,
        notes = $3,
        pickup_time = $4,
        total_amount = $5,
        updated_at = NOW()
      WHERE id = $1`,
      [orderId, finalName, finalNote, finalPickupTime, totalAmount]
    );

    await client.query('COMMIT');
    return { orderId, totalAmount, squareOrderId: ex.square_order_id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchOrderForUser(orderId, userId) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [
    orderId,
    userId,
  ]);
  if (rows.length === 0) return null;
  const order = rows[0];
  const items = await pool.query(
    `SELECT id, square_variation_id, item_name, item_emoji, quantity, unit_price, modifiers, created_at
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return { ...order, items: items.rows };
}

function mapItemRow(row) {
  return {
    id: row.id,
    square_variation_id: row.square_variation_id,
    item_name: row.item_name,
    item_emoji: row.item_emoji,
    quantity: row.quantity,
    unit_price: row.unit_price,
    modifiers: row.modifiers,
  };
}

function mapOrderRow(row, items) {
  return {
    id: row.id,
    square_order_id: row.square_order_id,
    customer_name: row.customer_name,
    notes: row.notes,
    total_amount: row.total_amount,
    status: row.status,
    pickup_time: row.pickup_time,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: (items || []).map(mapItemRow),
  };
}

module.exports = {
  pool,
  normalizeLineItems,
  computeTotal,
  pickupTimeFromMinutes,
  persistOrderFromCheckout,
  updateOrderLineItemsAndMeta,
  fetchOrderForUser,
  mapOrderRow,
  mapItemRow,
};

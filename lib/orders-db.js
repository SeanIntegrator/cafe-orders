const pool = require('../db');

const EMOJI_KIND = 'item_emoji';

/** Persist glyph inside modifiers JSON (no item_emoji column required on order_items). */
function modifiersWithOptionalEmoji(modifiers, glyph) {
  const base = Array.isArray(modifiers) ? [...modifiers] : [];
  if (glyph) {
    return [{ kind: EMOJI_KIND, glyph: String(glyph) }, ...base];
  }
  return base;
}

function splitEmojiFromModifiers(mods) {
  if (!Array.isArray(mods) || mods.length === 0) {
    return { glyph: null, modifiers: mods || [] };
  }
  const [first, ...rest] = mods;
  if (first && first.kind === EMOJI_KIND && first.glyph) {
    return { glyph: first.glyph, modifiers: rest };
  }
  return { glyph: null, modifiers: mods };
}

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((li) => {
    const qty = parseInt(String(li.quantity), 10) || 1;
    const unit = Math.round(Number(li.unit_price) || 0);
    const rawMods = Array.isArray(li.modifiers) ? li.modifiers : [];
    const glyph = li.emoji || li.item_emoji || null;
    return {
      square_variation_id: li.catalog_object_id || li.square_variation_id || null,
      item_name: String(li.item_name || 'Item').slice(0, 500),
      quantity: qty,
      unit_price: unit,
      modifiers: modifiersWithOptionalEmoji(rawMods, glyph),
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
      `INSERT INTO order_items (order_id, square_variation_id, item_name, quantity, unit_price, modifiers)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        orderId,
        row.square_variation_id,
        row.item_name,
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
        `INSERT INTO order_items (order_id, square_variation_id, item_name, quantity, unit_price, modifiers)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          orderId,
          row.square_variation_id,
          row.item_name,
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
    `SELECT id, square_variation_id, item_name, quantity, unit_price, modifiers, created_at
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return { ...order, items: items.rows };
}

function mapItemRow(row) {
  const { glyph, modifiers } = splitEmojiFromModifiers(row.modifiers);
  return {
    id: row.id,
    square_variation_id: row.square_variation_id,
    item_name: row.item_name,
    item_emoji: row.item_emoji ?? glyph,
    quantity: row.quantity,
    unit_price: row.unit_price,
    modifiers,
  };
}

/** Map DB order_items rows to KDS/Square-shaped line_items (name, quantity, modifiers with name). */
function kdsLineItemsFromDbRows(itemRows) {
  if (!Array.isArray(itemRows)) return [];
  return itemRows.map((row) => {
    const { modifiers } = splitEmojiFromModifiers(row.modifiers);
    const modForKds = (modifiers || [])
      .map((m) => {
        if (m && typeof m === 'object' && m.name != null) {
          return { name: String(m.name), catalog_object_id: m.catalog_object_id || '' };
        }
        return null;
      })
      .filter(Boolean);
    return {
      name: row.item_name || 'Item',
      quantity: row.quantity || 1,
      modifiers: modForKds,
    };
  });
}

/**
 * Open web_app orders mirrored in Postgres (for KDS hybrid list with Square).
 */
async function fetchOpenWebAppOrdersWithItems() {
  const { rows: orderRows } = await pool.query(
    `SELECT id, square_order_id, customer_name, notes, total_amount, status, pickup_time, created_at, updated_at, order_source
     FROM orders
     WHERE status IN ('pending', 'confirmed')
       AND order_source = 'web_app'
       AND square_order_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 100`
  );
  if (orderRows.length === 0) return [];
  const ids = orderRows.map((o) => o.id);
  const { rows: itemRows } = await pool.query(
    `SELECT id, order_id, square_variation_id, item_name, quantity, unit_price, modifiers
     FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id`,
    [ids]
  );
  const byOrder = {};
  for (const it of itemRows) {
    if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
    byOrder[it.order_id].push(it);
  }
  return orderRows.map((o) => ({ ...o, items: byOrder[o.id] || [] }));
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

/**
 * KDS "Done" — set Postgres row to completed so GET /api/orders hides it.
 * If no row exists yet (Square-only ticket), insert a minimal completed ledger row.
 * @param {{ customerName?: string, totalAmount?: number }} [snapshot] from Square order for INSERT fallback
 */
async function markOrderCompletedBySquareId(squareOrderId, snapshot = null) {
  if (!squareOrderId) return { updated: false };
  const { rowCount } = await pool.query(
    `UPDATE orders SET status = 'completed', updated_at = NOW()
     WHERE square_order_id = $1 AND status <> 'cancelled'`,
    [squareOrderId]
  );
  if (rowCount > 0) return { updated: true };

  const name = String(snapshot?.customerName || 'Walk-in').slice(0, 500);
  const raw = Number(snapshot?.totalAmount);
  const total = Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 0;

  await pool.query(
    `INSERT INTO orders (square_order_id, user_id, customer_name, notes, total_amount, status, order_source, pickup_time, cafe_id)
     VALUES ($1, NULL, $2, NULL, $3, 'completed', 'in_person', NULL, 1)
     ON CONFLICT (square_order_id) DO UPDATE SET
       status = 'completed',
       updated_at = NOW()
     WHERE orders.status <> 'cancelled'`,
    [squareOrderId, name, total]
  );
  return { updated: false, inserted: true };
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
  markOrderCompletedBySquareId,
  kdsLineItemsFromDbRows,
  fetchOpenWebAppOrdersWithItems,
};

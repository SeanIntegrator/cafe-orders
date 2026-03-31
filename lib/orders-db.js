const pool = require('../db');
const { lineItemsForPersistence } = require('./stripe-helpers');

const EMOJI_KIND = 'item_emoji';
const MIN_MODIFICATION_LEAD_MS = 5 * 60 * 1000;
const MAX_CUSTOMER_NOTE_LEN = 500;
const MAX_ALLERGEN_STRINGS = 24;
const MAX_ALLERGEN_ITEM_LEN = 120;

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

/** Sanitize allergens for JSONB storage; returns string[] */
function normalizeAllergensInput(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of arr) {
    if (out.length >= MAX_ALLERGEN_STRINGS) break;
    const s = String(raw ?? '')
      .trim()
      .slice(0, MAX_ALLERGEN_ITEM_LEN);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function normalizeCustomerNote(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, MAX_CUSTOMER_NOTE_LEN);
  return s || null;
}

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((li) => {
    const qty = parseInt(String(li.quantity), 10) || 1;
    const unit = Math.round(Number(li.unit_price) || 0);
    const rawMods = Array.isArray(li.modifiers) ? li.modifiers : [];
    const glyph = li.emoji || li.item_emoji || null;
    const customer_note = normalizeCustomerNote(li.customer_note);
    return {
      square_variation_id: li.catalog_object_id || li.square_variation_id || null,
      item_name: String(li.item_name || 'Item').slice(0, 500),
      quantity: qty,
      unit_price: unit,
      modifiers: modifiersWithOptionalEmoji(rawMods, glyph),
      customer_note,
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

function rowAllergens(row) {
  if (!row || row.allergens == null) return [];
  if (Array.isArray(row.allergens)) return row.allergens.map((x) => String(x));
  return normalizeAllergensInput(row.allergens);
}

async function insertOrderWithItems(client, params) {
  const {
    squareOrderId,
    userId,
    customerName,
    notes,
    allergens,
    totalAmount,
    orderSource,
    pickupTime,
    cafeId = 1,
    status = 'confirmed',
    normalizedItems,
    stripeSessionId = null,
    paymentSessionEntry = null,
    loyaltyDiscountPence = 0,
  } = params;

  const allergenJson = JSON.stringify(normalizeAllergensInput(allergens));
  const loyaltyDisc = Math.max(0, Math.round(Number(loyaltyDiscountPence) || 0));

  const ins = await client.query(
    `INSERT INTO orders (square_order_id, user_id, customer_name, notes, allergens, total_amount, status, order_source, pickup_time, cafe_id, stripe_session_id, loyalty_discount_pence)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      squareOrderId,
      userId || null,
      customerName,
      notes ?? null,
      allergenJson,
      totalAmount,
      status,
      orderSource,
      pickupTime,
      cafeId,
      stripeSessionId || null,
      loyaltyDisc,
    ]
  );
  const orderId = ins.rows[0].id;
  for (const row of normalizedItems) {
    await client.query(
      `INSERT INTO order_items (order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        orderId,
        row.square_variation_id,
        row.item_name,
        row.quantity,
        row.unit_price,
        JSON.stringify(row.modifiers),
        row.customer_note,
      ]
    );
  }
  if (params.paymentSessionEntry) {
    await client.query(
      `UPDATE orders SET payment_sessions = COALESCE(payment_sessions, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
      [orderId, JSON.stringify([params.paymentSessionEntry])]
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
  notes,
  allergens,
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
      notes: notes ?? null,
      allergens: normalizeAllergensInput(allergens),
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

async function insertPendingOrder({
  userId,
  lineItems,
  customerName,
  pickupMinutes,
  notes,
  allergens,
  totalAmount,
  originalOrderId = null,
  isIncremental = false,
  applyReward = false,
  loyaltyDiscountPence = 0,
}) {
  const disc = Math.max(0, Math.round(Number(loyaltyDiscountPence) || 0));
  const { rows } = await pool.query(
    `INSERT INTO pending_orders (user_id, line_items, customer_name, pickup_minutes, notes, allergens, total_amount, original_order_id, is_incremental, apply_reward, loyalty_discount_pence)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      userId || null,
      JSON.stringify(lineItems),
      customerName,
      pickupMinutes,
      notes ?? null,
      JSON.stringify(normalizeAllergensInput(allergens)),
      totalAmount,
      originalOrderId,
      Boolean(isIncremental),
      Boolean(applyReward),
      disc,
    ]
  );
  return rows[0].id;
}

function paymentSessionsInclude(sessions, stripeSessionId) {
  if (!stripeSessionId) return false;
  const arr = Array.isArray(sessions) ? sessions : [];
  return arr.some((e) => e && e.session_id === stripeSessionId);
}

function pickupAllowsModification(pickupTime) {
  if (!pickupTime) return false;
  const t = pickupTime instanceof Date ? pickupTime : new Date(pickupTime);
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() - Date.now() > MIN_MODIFICATION_LEAD_MS;
}

/**
 * Append paid incremental lines + payment session; delete pending. Caller owns transaction.
 */
async function persistIncrementalPaidOrderInClient(client, params) {
  const { parentOrderId, enrichedLineItems, paymentSessionEntry, pendingOrderId } = params;
  const forNorm = lineItemsForPersistence(enrichedLineItems);
  const normalized = normalizeLineItems(forNorm);
  const deltaTotal = computeTotal(normalized);

  for (const row of normalized) {
    await client.query(
      `INSERT INTO order_items (order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        parentOrderId,
        row.square_variation_id,
        row.item_name,
        row.quantity,
        row.unit_price,
        JSON.stringify(row.modifiers),
        row.customer_note,
      ]
    );
  }
  await client.query(
    `UPDATE orders SET
       total_amount = total_amount + $2,
       payment_sessions = COALESCE(payment_sessions, '[]'::jsonb) || $3::jsonb,
       updated_at = NOW()
     WHERE id = $1`,
    [parentOrderId, deltaTotal, JSON.stringify([paymentSessionEntry])]
  );
  if (pendingOrderId) {
    await deletePendingOrder(client, pendingOrderId);
  }
  return { dbOrderId: parentOrderId, deltaTotal };
}

async function fetchOrderRowForUser(orderId, userId) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [
    orderId,
    userId,
  ]);
  return rows[0] || null;
}

async function updatePendingOrderSessionId(pendingId, sessionId) {
  await pool.query(`UPDATE pending_orders SET session_id = $2 WHERE id = $1`, [pendingId, sessionId]);
}

async function fetchPendingOrderById(id) {
  const { rows } = await pool.query(`SELECT * FROM pending_orders WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function deletePendingOrder(client, id) {
  await client.query(`DELETE FROM pending_orders WHERE id = $1`, [id]);
}

/**
 * Insert order + items and remove pending row. Caller owns transaction (BEGIN/COMMIT).
 */
async function persistStripePaidOrderInClient(client, params) {
  const {
    squareOrderId,
    userId,
    customerName,
    notes,
    allergens,
    pickupMinutes,
    enrichedLineItems,
    stripeSessionId,
    pendingOrderId,
    paymentSessionEntry = null,
    loyaltyDiscountPence = 0,
    applyReward = false,
  } = params;
  const forNorm = lineItemsForPersistence(enrichedLineItems);
  const normalized = normalizeLineItems(forNorm);
  const itemsTotal = computeTotal(normalized);
  const disc = Math.max(0, Math.round(Number(loyaltyDiscountPence) || 0));
  const totalAmount = Math.max(0, itemsTotal - disc);
  const pickupTime = pickupTimeFromMinutes(pickupMinutes);
  const dbOrderId = await insertOrderWithItems(client, {
    squareOrderId,
    userId,
    customerName,
    notes: notes ?? null,
    allergens: normalizeAllergensInput(allergens),
    totalAmount,
    orderSource: 'web_app',
    pickupTime,
    normalizedItems: normalized,
    stripeSessionId,
    paymentSessionEntry,
    loyaltyDiscountPence: disc,
  });
  if (applyReward && userId) {
    const { redeemRewardInClient } = require('./loyalty');
    await redeemRewardInClient(client, userId, 1, dbOrderId);
  }
  if (pendingOrderId) {
    await deletePendingOrder(client, pendingOrderId);
  }
  return { dbOrderId, totalAmount };
}

async function findOrderIdByStripeSessionId(sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE stripe_session_id = $1 LIMIT 1`,
    [sessionId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Replace line items and update order header (editable statuses only — caller checks).
 */
async function updateOrderLineItemsAndMeta(orderId, userId, patch) {
  const {
    customer_name: customerName,
    note,
    allergens: allergensPatch,
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

    const psArr = Array.isArray(ex.payment_sessions) ? ex.payment_sessions : [];
    if (ex.stripe_session_id || psArr.length > 0) {
      await client.query('ROLLBACK');
      const err = new Error('Paid app orders cannot be edited here — use Add more items or cancel from the home screen.');
      err.code = 'FORBIDDEN';
      throw err;
    }

    const finalName = customerName !== undefined ? customerName : ex.customer_name;
    const finalNote = note !== undefined ? note : ex.notes;
    const finalAllergens =
      allergensPatch !== undefined
        ? normalizeAllergensInput(allergensPatch)
        : rowAllergens(ex);
    const finalPickupTime =
      pickupMinutes !== undefined ? pickupTimeFromMinutes(pickupMinutes) : ex.pickup_time;

    await client.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
    for (const row of normalized) {
      await client.query(
        `INSERT INTO order_items (order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          orderId,
          row.square_variation_id,
          row.item_name,
          row.quantity,
          row.unit_price,
          JSON.stringify(row.modifiers),
          row.customer_note,
        ]
      );
    }

    await client.query(
      `UPDATE orders SET
        customer_name = $2,
        notes = $3,
        allergens = $4::jsonb,
        pickup_time = $5,
        total_amount = $6,
        updated_at = NOW()
      WHERE id = $1`,
      [orderId, finalName, finalNote, JSON.stringify(finalAllergens), finalPickupTime, totalAmount]
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
    `SELECT id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note, created_at
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
    customer_note: row.customer_note ?? null,
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
    const out = {
      name: row.item_name || 'Item',
      quantity: row.quantity || 1,
      modifiers: modForKds,
    };
    const cn = row.customer_note != null ? String(row.customer_note).trim() : '';
    if (cn) out.customer_note = cn;
    return out;
  });
}

/**
 * Open web_app orders mirrored in Postgres (for KDS hybrid list with Square).
 */
async function fetchOpenWebAppOrdersWithItems() {
  const { rows: orderRows } = await pool.query(
    `SELECT id, square_order_id, stripe_session_id, payment_sessions, customer_name, notes, allergens, total_amount, status, pickup_time, created_at, updated_at, order_source
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
    `SELECT id, order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note
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
  const ps = row.payment_sessions;
  const psArr = Array.isArray(ps) ? ps : [];
  const isPaidViaStripe = Boolean(row.stripe_session_id || psArr.length > 0);
  return {
    id: row.id,
    square_order_id: row.square_order_id,
    stripe_session_id: row.stripe_session_id ?? null,
    is_paid_via_stripe: isPaidViaStripe,
    customer_name: row.customer_name,
    notes: row.notes,
    allergens: rowAllergens(row),
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
    `INSERT INTO orders (square_order_id, user_id, customer_name, notes, allergens, total_amount, status, order_source, pickup_time, cafe_id)
     VALUES ($1, NULL, $2, NULL, '[]'::jsonb, $3, 'completed', 'in_person', NULL, 1)
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
  insertOrderWithItems,
  normalizeLineItems,
  normalizeAllergensInput,
  computeTotal,
  pickupTimeFromMinutes,
  MIN_MODIFICATION_LEAD_MS,
  paymentSessionsInclude,
  pickupAllowsModification,
  persistOrderFromCheckout,
  persistStripePaidOrderInClient,
  persistIncrementalPaidOrderInClient,
  insertPendingOrder,
  updatePendingOrderSessionId,
  fetchPendingOrderById,
  deletePendingOrder,
  findOrderIdByStripeSessionId,
  fetchOrderRowForUser,
  updateOrderLineItemsAndMeta,
  fetchOrderForUser,
  mapOrderRow,
  mapItemRow,
  markOrderCompletedBySquareId,
  kdsLineItemsFromDbRows,
  fetchOpenWebAppOrdersWithItems,
};

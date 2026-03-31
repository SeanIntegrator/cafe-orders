/**
 * Authenticated customer order list, detail, PATCH (edit), and cancel + refund.
 */

const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  fetchOrderForUser,
  mapOrderRow,
  updateOrderLineItemsAndMeta,
  fetchOrderRowForUser,
  pickupAllowsModification,
} = require('../lib/orders-db');
const {
  getLoyaltyCardForUser,
  getLastStampDate,
  loyaltyConfig,
} = require('../lib/loyalty');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('STRIPE_SECRET_KEY not set'), { code: 'CONFIG' });
  return new Stripe(key);
}

async function ensurePaymentSessionsPopulated(order) {
  let sessions = Array.isArray(order.payment_sessions) ? order.payment_sessions : [];
  if (sessions.length > 0 || !order.stripe_session_id) {
    return sessions;
  }
  const stripe = getStripe();
  const s = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
  const pi = s.payment_intent;
  const entry = {
    session_id: s.id,
    payment_intent_id: typeof pi === 'string' ? pi : pi?.id || null,
    amount: s.amount_total != null ? Number(s.amount_total) : 0,
    timestamp: new Date().toISOString(),
    type: 'initial',
  };
  await pool.query(
    `UPDATE orders SET payment_sessions = COALESCE(payment_sessions, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
    [order.id, JSON.stringify([entry])]
  );
  return [entry];
}

module.exports = function createCustomerOrdersRouter(io) {
  const router = express.Router();

  router.get('/api/customer/orders', requireAuth, async (req, res) => {
    try {
      const statusQ = req.query.status;
      const daysQ = req.query.days;
      const values = [req.userId];
      let where = 'WHERE user_id = $1';
      let paramIdx = 1;

      if (statusQ) {
        const st = statusQ.split(',').map((s) => s.trim()).filter(Boolean);
        if (st.length) {
          values.push(st);
          paramIdx += 1;
          where += ` AND status = ANY($${paramIdx}::text[])`;
        }
      }

      if (daysQ !== undefined && daysQ !== '') {
        const d = parseInt(String(daysQ), 10);
        if (Number.isFinite(d) && d > 0 && d <= 730) {
          values.push(d);
          paramIdx += 1;
          where += ` AND created_at >= NOW() - ($${paramIdx}::integer * INTERVAL '1 day')`;
        }
      } else if (!statusQ) {
        where += ` AND created_at >= NOW() - INTERVAL '30 days'`;
      }

      const { rows: orders } = await pool.query(
        `SELECT id, square_order_id, stripe_session_id, payment_sessions, customer_name, notes, allergens, total_amount, status, pickup_time, created_at, updated_at
         FROM orders ${where}
         ORDER BY created_at DESC
         LIMIT 40`,
        values
      );

      if (orders.length === 0) {
        return res.json({ ok: true, orders: [] });
      }

      const ids = orders.map((o) => o.id);
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

      const payload = orders.map((o) => mapOrderRow(o, byOrder[o.id] || []));
      res.json({ ok: true, orders: payload });
    } catch (err) {
      console.error('GET /api/customer/orders error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/customer/order-by-checkout-session', requireAuth, async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ ok: false, error: 'session_id query required' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, square_order_id, stripe_session_id, payment_sessions, customer_name, notes, allergens, total_amount, status, pickup_time, created_at, updated_at
         FROM orders WHERE user_id = $2 AND (
           stripe_session_id = $1
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(payment_sessions, '[]'::jsonb)) AS e
             WHERE e->>'session_id' = $1
           )
         )
         LIMIT 1`,
        [sessionId, req.userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      const row = rows[0];
      const { rows: itemRows } = await pool.query(
        `SELECT id, order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note
         FROM order_items WHERE order_id = $1 ORDER BY id`,
        [row.id]
      );
      res.json({ ok: true, order: mapOrderRow(row, itemRows) });
    } catch (err) {
      console.error('GET /api/customer/order-by-checkout-session error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/customer/orders/:id/cancel', requireAuth, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ ok: false, error: 'Invalid order id' });
    }
    try {
      const order = await fetchOrderRowForUser(orderId, req.userId);
      if (!order) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      if (!['pending', 'confirmed'].includes(order.status)) {
        return res.status(400).json({
          ok: false,
          error: 'Cannot cancel order',
          reason: 'already_cancelled',
        });
      }
      if (!pickupAllowsModification(order.pickup_time)) {
        return res.status(400).json({
          ok: false,
          error: 'Cannot cancel order',
          reason: 'too_close_to_pickup',
        });
      }

      let sessions = await ensurePaymentSessionsPopulated(order);
      if (sessions.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'No Stripe payments to refund for this order',
        });
      }

      const stripe = getStripe();
      const refundRecords = [];
      let totalRefunded = 0;

      for (const ps of sessions) {
        let pi = ps.payment_intent_id;
        if (!pi && ps.session_id) {
          const s = await stripe.checkout.sessions.retrieve(ps.session_id);
          const p = s.payment_intent;
          pi = typeof p === 'string' ? p : p?.id;
        }
        if (!pi) {
          console.error('Cancel: missing payment_intent for session', ps.session_id);
          return res.status(500).json({ ok: false, error: 'Could not resolve payment for refund' });
        }
        const amt = Number(ps.amount) || 0;
        const refund = await stripe.refunds.create({
          payment_intent: pi,
          amount: amt,
          reason: 'requested_by_customer',
        });
        refundRecords.push({
          refund_id: refund.id,
          amount: amt,
          session_id: ps.session_id,
          timestamp: new Date().toISOString(),
          status: refund.status,
        });
        totalRefunded += amt;
      }

      const refundData = {
        refunds: refundRecords,
        total_refunded: totalRefunded,
        reason: 'requested_by_customer',
      };

      await pool.query(
        `UPDATE orders SET status = 'cancelled', refund_data = $2::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $3`,
        [orderId, JSON.stringify(refundData), req.userId]
      );

      if (io) {
        io.emit('orderCancelled', {
          dbOrderId: orderId,
          squareOrderId: order.square_order_id,
        });
      }

      return res.json({
        ok: true,
        cancelled: true,
        refunded_amount: totalRefunded,
        refund_ids: refundRecords.map((r) => r.refund_id),
        message: 'Refund will appear in 5–10 business days',
      });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('POST cancel order:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Cancel failed' });
    }
  });

  router.get('/api/customer/orders/:id', requireAuth, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ ok: false, error: 'Invalid order id' });
    }
    try {
      const full = await fetchOrderForUser(orderId, req.userId);
      if (!full) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      const { items, ...row } = full;
      res.json({ ok: true, order: mapOrderRow(row, items) });
    } catch (err) {
      console.error('GET /api/customer/orders/:id error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/customer/loyalty', requireAuth, async (req, res) => {
    try {
      const cfg = loyaltyConfig();
      const card = await getLoyaltyCardForUser(req.userId, 1);
      const lastStamp = await getLastStampDate(req.userId, 1);
      const stamps = card.stamps_count;
      const per = cfg.stampsPerReward;
      const stampsToNext = Math.max(0, per - stamps);
      res.json({
        ok: true,
        stamps_count: stamps,
        rewards_available: card.rewards_available,
        stamps_to_next_reward: stampsToNext,
        last_stamp_date: lastStamp ? new Date(lastStamp).toISOString() : null,
      });
    } catch (err) {
      console.error('GET /api/customer/loyalty error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/customer/rewards', requireAuth, async (req, res) => {
    try {
      const cfg = loyaltyConfig();
      const card = await getLoyaltyCardForUser(req.userId, 1);
      const n = Math.max(0, Number(card.rewards_available) || 0);
      const maxVal = cfg.rewardMaxPence;
      const available = Array.from({ length: n }, (_, i) => ({
        id: `reward_${i + 1}`,
        type: 'free_drink',
        value: maxVal,
        max_value: maxVal,
        expires_at: null,
      }));

      const { rows: redRows } = await pool.query(
        `SELECT t.created_at, t.order_id, COALESCE(o.loyalty_discount_pence, 0)::int AS discount_amount,
           (
             SELECT oi.item_name FROM order_items oi
             WHERE oi.order_id = o.id
             ORDER BY oi.id ASC
             LIMIT 1
           ) AS item_name
         FROM loyalty_transactions t
         LEFT JOIN orders o ON o.id = t.order_id
         WHERE t.user_id = $1 AND t.transaction_type = 'reward_redeemed'
         ORDER BY t.created_at DESC
         LIMIT 25`,
        [req.userId]
      );

      const recent_redemptions = redRows.map((r) => ({
        redeemed_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        order_id: r.order_id != null ? String(r.order_id) : null,
        discount_amount: Number(r.discount_amount) || 0,
        item_name: r.item_name || null,
      }));

      res.json({ ok: true, available, recent_redemptions });
    } catch (err) {
      console.error('GET /api/customer/rewards error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.patch('/api/customer/orders/:id', requireAuth, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ ok: false, error: 'Invalid order id' });
    }
    const body = req.body ?? {};
    if (!Array.isArray(body.line_items) || body.line_items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'line_items array required with at least one item',
      });
    }

    try {
      const result = await updateOrderLineItemsAndMeta(orderId, req.userId, {
        customer_name: body.customer_name,
        note: body.note,
        allergens: body.allergens,
        pickup_minutes: body.pickup_minutes,
        line_items: body.line_items,
      });
      if (io) {
        io.emit('orderUpdated', {
          type: 'updated',
          dbOrderId: result.orderId,
          squareOrderId: result.squareOrderId,
        });
      }
      const full = await fetchOrderForUser(orderId, req.userId);
      const { items, ...row } = full;
      res.json({ ok: true, order: mapOrderRow(row, items) });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      if (err.code === 'FORBIDDEN') {
        return res.status(403).json({
          ok: false,
          error: 'This order can no longer be edited',
        });
      }
      if (err.code === 'VALIDATION') {
        return res.status(400).json({ ok: false, error: err.message });
      }
      console.error('PATCH /api/customer/orders/:id error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};

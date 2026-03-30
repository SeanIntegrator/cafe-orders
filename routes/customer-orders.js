/**
 * Authenticated customer order list, detail, and PATCH (edit while pending/confirmed).
 */

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  fetchOrderForUser,
  mapOrderRow,
  updateOrderLineItemsAndMeta,
} = require('../lib/orders-db');

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
        `SELECT id, square_order_id, stripe_session_id, customer_name, notes, allergens, total_amount, status, pickup_time, created_at, updated_at
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
        `SELECT id, square_order_id, stripe_session_id, customer_name, notes, allergens, total_amount, status, pickup_time, created_at, updated_at
         FROM orders WHERE stripe_session_id = $1 AND user_id = $2 LIMIT 1`,
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

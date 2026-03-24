/**
 * KDS: list persisted orders by time window (analytics / recall).
 */

const express = require('express');
const pool = require('../db');

/** Match RecallContext: barista-facing history (excludes unpaid pending). */
const KDS_HISTORY_STATUSES = ['confirmed', 'ready', 'completed'];

module.exports = function createKdsHistoryRouter() {
  const router = express.Router();

  router.get('/api/kds/orders', async (req, res) => {
    const period = (req.query.period || 'today').toLowerCase();
    const cafeId = parseInt(req.query.cafe_id ?? '1', 10) || 1;

    const now = new Date();
    let since;
    if (period === 'hour') {
      since = new Date(now.getTime() - 60 * 60 * 1000);
    } else if (period === 'week') {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      since = d;
    }

    try {
      const { rows: orders } = await pool.query(
        `SELECT id, square_order_id, customer_name, notes, total_amount, status, order_source,
                pickup_time, created_at, updated_at, user_id
         FROM orders
         WHERE cafe_id = $1
           AND status = ANY($2::text[])
           AND created_at >= $3
         ORDER BY created_at DESC
         LIMIT 500`,
        [cafeId, KDS_HISTORY_STATUSES, since]
      );

      if (orders.length === 0) {
        return res.json({ ok: true, orders: [] });
      }

      const ids = orders.map((o) => o.id);
      const { rows: itemRows } = await pool.query(
        `SELECT id, order_id, square_variation_id, item_name, item_emoji, quantity, unit_price, modifiers
         FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id`,
        [ids]
      );

      const byOrder = {};
      for (const it of itemRows) {
        if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
        byOrder[it.order_id].push({
          id: it.id,
          square_variation_id: it.square_variation_id,
          item_name: it.item_name,
          item_emoji: it.item_emoji,
          quantity: it.quantity,
          unit_price: it.unit_price,
          modifiers: it.modifiers,
        });
      }

      const payload = orders.map((o) => ({
        id: o.id,
        square_order_id: o.square_order_id,
        customer_name: o.customer_name,
        notes: o.notes,
        total_amount: o.total_amount,
        status: o.status,
        order_source: o.order_source,
        pickup_time: o.pickup_time,
        created_at: o.created_at,
        updated_at: o.updated_at,
        user_id: o.user_id,
        items: byOrder[o.id] || [],
      }));

      res.json({ ok: true, orders: payload, period, since: since.toISOString() });
    } catch (err) {
      console.error('GET /api/kds/orders error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};

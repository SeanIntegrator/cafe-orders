/**
 * KDS: list persisted orders by time window (analytics / recall).
 */

const express = require('express');
const pool = require('../db');
const { mapItemRow } = require('../lib/orders-db');
const { searchAllOrders } = require('../lib/square');

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
        `SELECT id, square_order_id, customer_name, notes, allergens, total_amount, status, order_source,
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
        `SELECT id, order_id, square_variation_id, item_name, quantity, unit_price, modifiers, customer_note
         FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id`,
        [ids]
      );

      const byOrder = {};
      for (const it of itemRows) {
        if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
        byOrder[it.order_id].push(it);
      }

      const payload = orders.map((o) => ({
        id: o.id,
        square_order_id: o.square_order_id,
        customer_name: o.customer_name,
        notes: o.notes,
        allergens: o.allergens,
        total_amount: o.total_amount,
        status: o.status,
        order_source: o.order_source,
        pickup_time: o.pickup_time,
        created_at: o.created_at,
        updated_at: o.updated_at,
        user_id: o.user_id,
        items: (byOrder[o.id] || []).map(mapItemRow),
      }));

      res.json({ ok: true, orders: payload, period, since: since.toISOString() });
    } catch (err) {
      console.error('GET /api/kds/orders error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/square/orders
   * Fetch raw Square orders — all types, statuses, dates. Useful for debugging
   * and the recall feature.
   * Query params:
   *   states  - comma-separated Square states (default: all)
   *   from    - ISO 8601 created_at lower bound (default: 30 days ago)
   *   to      - ISO 8601 created_at upper bound
   *   limit   - max results per page (default: 100, max: 500)
   *   cursor  - pagination cursor from previous response
   */
  router.get('/api/square/orders', async (req, res) => {
    try {
      const states = req.query.states
        ? req.query.states.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : undefined;

      const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500);
      const cursor = req.query.cursor || undefined;

      // Default to last 30 days if no lower bound supplied
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const createdAfter = req.query.from || defaultFrom;
      const createdBefore = req.query.to || undefined;

      const result = await searchAllOrders({ states, createdAfter, createdBefore, limit, cursor });

      res.json({
        ok: true,
        orders: result.orders,
        cursor: result.cursor ?? null,
        count: result.orders.length,
      });
    } catch (err) {
      console.error('GET /api/square/orders error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};

/**
 * KDS: list persisted orders by time window (analytics / recall).
 */

const express = require('express');
const pool = require('../db');
const { mapItemRow, fetchWebAppOrderBySquareIdWithItems } = require('../lib/orders-db');
const { searchAllOrders, fetchOrder } = require('../lib/square');
const { overlayWebAppDbOnSquareOrder } = require('../lib/kds-merge');
const { kdsShouldDisplayOrder } = require('../lib/kds-visibility');

/** Match RecallContext: barista-facing history (excludes unpaid pending). */
const KDS_HISTORY_STATUSES = ['confirmed', 'ready', 'completed'];

/**
 * @param {import('socket.io').Server | null | undefined} io
 */
module.exports = function createKdsHistoryRouter(io) {
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
    } else if (period === '30d') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (period === 'all') {
      since = new Date('2020-01-01T00:00:00Z');
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
           AND order_source IN ('web_app', 'whatsapp')
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
   * POST /api/kds/recall
   * Body: { squareOrderId: string }
   * Re-opens completed app rows or removes POS ledger row, then emits new-order for all clients.
   */
  router.post('/api/kds/recall', async (req, res) => {
    const squareOrderId =
      req.body?.squareOrderId != null ? String(req.body.squareOrderId).trim() : '';
    if (!squareOrderId) {
      return res.status(400).json({ ok: false, error: 'squareOrderId required' });
    }
    try {
      const { rows: dbRows } = await pool.query(
        `SELECT id, square_order_id, status, order_source FROM orders WHERE square_order_id = $1`,
        [squareOrderId]
      );
      const dbRow = dbRows[0];
      if (dbRow && dbRow.status === 'completed') {
        const src = String(dbRow.order_source || '').toLowerCase();
        if (src === 'web_app' || src === 'whatsapp') {
          await pool.query(
            `UPDATE orders SET status = 'confirmed', updated_at = NOW()
             WHERE id = $1 AND status = 'completed'`,
            [dbRow.id]
          );
        } else if (src === 'in_person') {
          await pool.query(
            `DELETE FROM orders WHERE id = $1 AND order_source = 'in_person' AND status = 'completed'`,
            [dbRow.id]
          );
        }
      }

      const squareOrder = await fetchOrder(squareOrderId);
      if (!squareOrder) {
        return res.status(404).json({ ok: false, error: 'Order not found in Square' });
      }

      const dbOverlay = await fetchWebAppOrderBySquareIdWithItems(squareOrderId);
      const orderPayload = dbOverlay
        ? overlayWebAppDbOnSquareOrder(squareOrder, dbOverlay)
        : squareOrder;

      if (!kdsShouldDisplayOrder(orderPayload)) {
        return res.status(400).json({ ok: false, error: 'Order is not eligible for KDS display' });
      }

      const kdsRecallResetAtMs = Date.now();
      if (io) {
        io.emit('new-order', { order: orderPayload, kdsRecallResetAtMs });
      }
      res.json({ ok: true, order: orderPayload, kdsRecallResetAtMs });
    } catch (err) {
      console.error('POST /api/kds/recall error:', err);
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

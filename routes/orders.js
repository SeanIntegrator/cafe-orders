/**
 * Order routes: list open orders, complete order (fulfillment).
 */

const express = require('express');
const router = express.Router();
const square = require('../lib/square');
const { pool, markOrderCompletedBySquareId } = require('../lib/orders-db');

function snapshotFromSquareOrder(order) {
  if (!order) return null;
  const pickup = order.fulfillments?.[0]?.pickup_details;
  const name = pickup?.recipient?.display_name || 'Walk-in';
  const total = order.total_money?.amount;
  return {
    customerName: name,
    totalAmount: typeof total === 'number' ? total : parseInt(total, 10) || 0,
  };
}

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

router.get('/api/orders', async (req, res) => {
  try {
    let orders = await square.searchOpenOrders();
    orders = await filterOrdersHiddenByDb(orders);
    res.json({ ok: true, orders });
  } catch (err) {
    if (err.code === 'CONFIG') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    console.error('GET /api/orders error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/orders/:orderId/complete', async (req, res) => {
  const orderId = req.params.orderId;
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'orderId required' });
  }
  try {
    let version = req.body?.version;
    let fulfillments = req.body?.fulfillments;
    let orderState = req.body?.state;
    let order = null;

    if (version != null && Array.isArray(fulfillments) && fulfillments.length > 0) {
      order = {
        version,
        fulfillments,
        state: orderState,
        tenders: req.body?.tenders,
        total_money: req.body?.total_money,
      };
    }
    if (!order) {
      order = await square.fetchOrder(orderId);
      if (!order) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      version = order.version ?? 0;
      fulfillments = order.fulfillments || [];
      orderState = order.state;
    } else {
      version = order.version;
      fulfillments = order.fulfillments;
      orderState = order.state;
    }

    const snap = snapshotFromSquareOrder(order);

    if (orderState === 'COMPLETED') {
      await markOrderCompletedBySquareId(orderId, snap).catch((e) =>
        console.error('markOrderCompletedBySquareId:', e.message)
      );
      return res.json({ ok: true, already: true, completed: true });
    }
    if (orderState === 'CANCELED') {
      return res.json({ ok: true, already: true, completed: true });
    }

    if (!square.isOrderPaid(order)) {
      await markOrderCompletedBySquareId(orderId, snap).catch((e) =>
        console.error('markOrderCompletedBySquareId:', e.message)
      );
      return res.json({
        ok: true,
        completed: false,
        message: 'Order cleared from the board.',
      });
    }

    if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
      return res.status(400).json({ ok: false, error: 'Order has no fulfillments to complete' });
    }

    const numericVersion =
      typeof version === 'string' ? parseInt(version, 10) : version;
    const safeVersion = Number.isFinite(numericVersion) ? numericVersion : 0;

    const result = await square.completeOrderFulfillments(
      orderId,
      safeVersion,
      fulfillments
    );
    if (result.completed) {
      await markOrderCompletedBySquareId(orderId, snap).catch((e) =>
        console.error('markOrderCompletedBySquareId:', e.message)
      );
      return res.json({ ok: true, completed: true });
    }
    return res.status(400).json({
      ok: false,
      error: result.error || 'Could not complete order',
      completed: false,
    });
  } catch (err) {
    if (err.code === 'CONFIG') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    console.error('POST /api/orders/:orderId/complete error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

/**
 * Order routes: list open orders, complete order (fulfillment).
 */

const express = require('express');
const router = express.Router();
const square = require('../lib/square');
const dismissed = require('../lib/dismissed-orders');

router.get('/api/orders', async (req, res) => {
  try {
    let orders = await square.searchOpenOrders();
    orders = orders.filter((o) => !dismissed.has(o.id));
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

    if (orderState === 'COMPLETED' || orderState === 'CANCELED') {
      return res.json({ ok: true, already: true, completed: true });
    }

    if (!square.isOrderPaid(order)) {
      dismissed.add(orderId);
      return res.json({
        ok: true,
        completed: false,
        message: 'Removed from board. In sandbox, unpaid orders stay hidden on refresh.',
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

/**
 * Order routes: list open orders, complete order (fulfillment).
 */

const express = require('express');
const square = require('../lib/square');
const pool = require('../db');
const { markOrderCompletedBySquareId } = require('../lib/orders-db');
const { mergeOpenOrdersWithWebAppDb } = require('../lib/kds-merge');

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

/**
 * After KDS marks an order done in our DB, notify customer apps (pickup feedback).
 * @param {import('socket.io').Server | null | undefined} io
 * @param {string} squareOrderId
 */
async function notifyCustomerOrderCompleted(io, squareOrderId) {
  if (!io || !squareOrderId) return;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM orders WHERE square_order_id = $1 LIMIT 1',
      [squareOrderId]
    );
    const dbOrderId = rows[0]?.id ?? null;
    io.emit('customerOrderCompleted', { squareOrderId, dbOrderId });
  } catch (e) {
    console.error('notifyCustomerOrderCompleted:', e.message || e);
  }
}

module.exports = function createOrdersRouter(io) {
  const router = express.Router();

  router.get('/api/orders', async (req, res) => {
    try {
      const mergedList = await mergeOpenOrdersWithWebAppDb(() => square.searchOpenOrders());
      res.json({ ok: true, orders: mergedList });
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
        try {
          await markOrderCompletedBySquareId(orderId, snap);
        } catch (e) {
          console.error('markOrderCompletedBySquareId:', e.message);
        }
        await notifyCustomerOrderCompleted(io, orderId);
        return res.json({ ok: true, already: true, completed: true });
      }
      if (orderState === 'CANCELED') {
        return res.json({ ok: true, already: true, completed: true });
      }

      if (!square.isOrderPaid(order)) {
        try {
          await markOrderCompletedBySquareId(orderId, snap);
        } catch (e) {
          console.error('markOrderCompletedBySquareId:', e.message);
        }
        await notifyCustomerOrderCompleted(io, orderId);
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
        try {
          await markOrderCompletedBySquareId(orderId, snap);
        } catch (e) {
          console.error('markOrderCompletedBySquareId:', e.message);
        }
        await notifyCustomerOrderCompleted(io, orderId);
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

  return router;
};

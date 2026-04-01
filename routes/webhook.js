/**
 * Square webhook handler.
 *
 * Subscribe in Square Developer Dashboard (same URL) to at least:
 * - payment.created, payment.updated — POS / Register payments (resolve order via Payment.order_id)
 * - order.created, order.updated — API / Dashboard / Order Manager lifecycle (not all POS paths)
 * - order.fulfillment.updated — fulfillment state changes (UpdateOrder; useful when subscribed)
 *
 * Emits:
 * - new-order — full order for KDS when the order should be visible
 * - squareOrderClosed — { squareOrderId } when Square marks the order done / not on KDS (dismiss card)
 */

const square = require('../lib/square');

const PAYMENT_EVENTS = new Set(['payment.created', 'payment.updated']);
const ORDER_EVENTS = new Set(['order.created', 'order.updated']);
const FULFILLMENT_UPDATED = 'order.fulfillment.updated';

/**
 * @param {object} event
 * @returns {string|null}
 */
function orderIdFromOrderWebhook(event) {
  const orderFromObject = event.data?.object?.order;
  const orderIdFromCreated = event.data?.object?.order_created?.order_id;
  const orderIdFromUpdated = event.data?.object?.order_updated?.order_id;
  const orderIdFallback = event.data?.id || event.data?.object?.id;

  return (
    orderFromObject?.id ||
    orderIdFromCreated ||
    orderIdFromUpdated ||
    orderIdFallback ||
    null
  );
}

/**
 * @param {object} event
 * @returns {string|null}
 */
function orderIdFromPaymentWebhook(event) {
  const payment = event.data?.object?.payment ?? event.data?.object;
  const id = payment?.order_id;
  return id && typeof id === 'string' ? id : null;
}

/**
 * @param {import('socket.io').Server} io
 * @param {string} orderId
 * @param {object|null} partialOrder — optional payload snapshot if fetch fails
 */
async function emitOrderForKds(io, orderId, partialOrder = null) {
  const order = await square.fetchOrder(orderId);
  const resolved = order || partialOrder;
  if (!resolved?.id) {
    console.warn('Webhook: could not resolve order', orderId);
    return;
  }
  if (square.kdsShouldDisplayOrder(resolved)) {
    io.emit('new-order', resolved);
  } else {
    io.emit('squareOrderClosed', { squareOrderId: orderId });
  }
}

function attachWebhook(app, io) {
  app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const event = req.body;
    const type = event?.type;
    console.log('Square webhook event:', type);

    try {
      if (PAYMENT_EVENTS.has(type)) {
        const orderId = orderIdFromPaymentWebhook(event);
        if (!orderId) {
          console.log('Payment webhook: no order_id, skip');
          return;
        }
        await emitOrderForKds(io, orderId);
        return;
      }

      if (ORDER_EVENTS.has(type)) {
        const orderId = orderIdFromOrderWebhook(event);
        if (!orderId) {
          console.error('Webhook: no order ID in payload');
          return;
        }
        const partial = event.data?.object?.order;
        const partialUse =
          partial?.id === orderId ? partial : null;
        await emitOrderForKds(io, orderId, partialUse);
        return;
      }

      if (type === FULFILLMENT_UPDATED) {
        const orderId = event.data?.id;
        if (!orderId || typeof orderId !== 'string') {
          console.log('order.fulfillment.updated: no data.id, skip');
          return;
        }
        await emitOrderForKds(io, orderId);
        return;
      }

      console.log('Ignoring unhandled Square event type');
    } catch (err) {
      console.error('Square webhook handler error:', err.message || err);
    }
  });
}

module.exports = { attachWebhook };

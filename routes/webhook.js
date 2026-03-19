/**
 * Square webhook handler. Emits new-order via Socket.io.
 */

const square = require('../lib/square');

function attachWebhook(app, io) {
  app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const event = req.body;
    console.log('Square webhook event:', event?.type);

    if (event?.type !== 'order.created' && event?.type !== 'order.updated') {
      console.log('Ignoring non-order event');
      return;
    }

    const orderFromObject = event.data?.object?.order;
    const orderIdFromObject = orderFromObject?.id;
    const orderIdFromCreated = event.data?.object?.order_created?.order_id;
    const orderIdFromUpdated = event.data?.object?.order_updated?.order_id;
    const orderIdFallback = event.data?.id || event.data?.object?.id;

    const orderId =
      orderIdFromObject ||
      orderIdFromCreated ||
      orderIdFromUpdated ||
      orderIdFallback;

    if (orderFromObject?.id) {
      io.emit('new-order', orderFromObject);
      return;
    }

    if (!orderId) {
      console.error('Webhook: no order ID in payload');
      return;
    }

    const order = await square.fetchOrder(orderId);
    if (order) {
      io.emit('new-order', order);
      return;
    }

    const orderMeta =
      event.data?.object?.order_created ||
      event.data?.object?.order_updated ||
      {};
    const fallbackOrder = {
      id: orderId,
      state: orderMeta.state || 'OPEN',
      reference_id: orderMeta.order_id || orderId,
      line_items: [],
      total_money: null,
    };
    console.log('Webhook: emitting fallback order (test event?)');
    io.emit('new-order', fallbackOrder);
  });
}

module.exports = { attachWebhook };

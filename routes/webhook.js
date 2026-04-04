/**
 * Square webhook handler (requires raw JSON body — see index.js).
 *
 * Signature verification: DISABLED for now (no Dashboard access). When ready, uncomment
 * `const { WebhooksHelper } = require('square')` below and the block in createSquareWebhookHandler.
 * Then set:
 * - SQUARE_WEBHOOK_SIGNATURE_KEY — Developer Console → Webhooks → subscription signature key
 * - SQUARE_WEBHOOK_NOTIFICATION_URL — exact notification URL (scheme, host, path; must match Console)
 * Optional: SQUARE_WEBHOOK_SKIP_VERIFY=true — bypass HMAC (local/dev only) while verification code is enabled
 *
 * Subscribe in Square Developer Dashboard (same URL) to at least:
 * - payment.created, payment.updated — POS / Register payments (resolve order via Payment.order_id)
 * - order.created, order.updated — API / Dashboard / Order Manager lifecycle (not all POS paths)
 * - order.fulfillment.updated — fulfillment state changes (UpdateOrder; useful when subscribed)
 *
 * Emits:
 * - new-order — full order for KDS when the order should be visible
 * - squareOrderClosed — { squareOrderId } when Square marks the order done / not on KDS (dismiss card)
 *
 * Bursts of payment + order webhooks are debounced per order id so we fetch once and avoid
 * new-order / squareOrderClosed races. Override with SQUARE_WEBHOOK_DEBOUNCE_MS (default 350).
 *
 * new-order emissions are also deduped across webhook + poller via lib/emitted-orders.js
 * (KDS_NEW_ORDER_DEDUPE_MS, default 90s). squareOrderClosed is not deduped; forget() clears dedupe state.
 */

// When enabling HMAC verification, uncomment:
// const { WebhooksHelper } = require('square');
const square = require('../lib/square');
const emittedOrders = require('../lib/emitted-orders');

const KDS_WEBHOOK_DEBOUNCE_MS = Math.max(
  0,
  Number.parseInt(process.env.SQUARE_WEBHOOK_DEBOUNCE_MS || '350', 10) || 350
);

/** @type {Map<string, NodeJS.Timeout>} */
const pendingKdsSyncByOrderId = new Map();

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
    if (!emittedOrders.shouldEmitNewOrder(orderId)) {
      return;
    }
    io.emit('new-order', resolved);
    emittedOrders.recordNewOrderEmit(orderId);
  } else {
    io.emit('squareOrderClosed', { squareOrderId: orderId });
    emittedOrders.forget(orderId);
  }
}

/**
 * Coalesce rapid Square webhooks for the same order into one RetrieveOrder + one socket emit.
 * @param {import('socket.io').Server} io
 * @param {string} orderId
 */
function scheduleKdsSyncFromWebhook(io, orderId) {
  if (KDS_WEBHOOK_DEBOUNCE_MS <= 0) {
    emitOrderForKds(io, orderId, null).catch((e) =>
      console.error('KDS webhook sync:', e.message || e)
    );
    return;
  }
  const prev = pendingKdsSyncByOrderId.get(orderId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pendingKdsSyncByOrderId.delete(orderId);
    emitOrderForKds(io, orderId, null).catch((e) =>
      console.error('KDS webhook debounced sync:', e.message || e)
    );
  }, KDS_WEBHOOK_DEBOUNCE_MS);
  pendingKdsSyncByOrderId.set(orderId, t);
}

/**
 * @param {import('socket.io').Server} io
 * @param {object} event
 */
function processSquareWebhookEvent(io, event) {
  const type = event?.type;

  if (PAYMENT_EVENTS.has(type)) {
    const orderId = orderIdFromPaymentWebhook(event);
    if (!orderId) {
      console.log('Payment webhook: no order_id, skip');
      return;
    }
    scheduleKdsSyncFromWebhook(io, orderId);
    return;
  }

  if (ORDER_EVENTS.has(type)) {
    const orderId = orderIdFromOrderWebhook(event);
    if (!orderId) {
      console.error('Webhook: no order ID in payload');
      return;
    }
    scheduleKdsSyncFromWebhook(io, orderId);
    return;
  }

  if (type === FULFILLMENT_UPDATED) {
    const orderId = event.data?.id;
    if (!orderId || typeof orderId !== 'string') {
      console.log('order.fulfillment.updated: no data.id, skip');
      return;
    }
    scheduleKdsSyncFromWebhook(io, orderId);
    return;
  }

  console.log('Ignoring unhandled Square event type');
}

/**
 * Express handler: expects `express.raw({ type: 'application/json' })` so req.body is a Buffer.
 * @param {import('socket.io').Server} io
 */
function createSquareWebhookHandler(io) {
  return async (req, res) => {
    const raw = req.body;
    const bodyString = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    if (!bodyString) {
      return res.sendStatus(400);
    }

    /* --- Re-enable Square webhook HMAC when Dashboard signing key + notification URL are available ---
    const skipVerify = process.env.SQUARE_WEBHOOK_SKIP_VERIFY === 'true';
    if (!skipVerify) {
      const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
      const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
      if (!signatureKey || !notificationUrl) {
        console.error(
          'Square webhook: set SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_NOTIFICATION_URL, or SQUARE_WEBHOOK_SKIP_VERIFY=true for local dev'
        );
        return res.sendStatus(503);
      }
      const signatureHeader = req.get('x-square-hmacsha256-signature') || '';
      let valid = false;
      try {
        valid = await WebhooksHelper.verifySignature({
          requestBody: bodyString,
          signatureHeader,
          signatureKey,
          notificationUrl,
        });
      } catch (e) {
        console.error('Square webhook signature error:', e.message || e);
        return res.sendStatus(500);
      }
      if (!valid) {
        return res.sendStatus(403);
      }
    }
    --- end commented verification --- */

    let event;
    try {
      event = JSON.parse(bodyString);
    } catch {
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    console.log('Square webhook event:', event?.type);
    try {
      processSquareWebhookEvent(io, event);
    } catch (err) {
      console.error('Square webhook handler error:', err.message || err);
    }
  };
}

module.exports = { createSquareWebhookHandler };

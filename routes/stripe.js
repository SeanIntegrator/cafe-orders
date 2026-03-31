/**
 * Stripe Checkout: create session (JWT) + payment webhook (raw body).
 */

const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth');
const square = require('../lib/square');
const { enrichLineItemsForCheckout, totalSmallestUnit } = require('../lib/stripe-helpers');
const db = require('../db');
const {
  insertPendingOrder,
  updatePendingOrderSessionId,
  fetchPendingOrderById,
  findOrderIdByStripeSessionId,
  persistStripePaidOrderInClient,
  persistIncrementalPaidOrderInClient,
  normalizeAllergensInput,
  paymentSessionsInclude,
  fetchOrderRowForUser,
  pickupAllowsModification,
} = require('../lib/orders-db');
const {
  computeFreeDrinkRewardDiscountPence,
  assertRewardAvailable,
  loyaltyConfig,
} = require('../lib/loyalty');

function squarePickupNoteFromAllergens(allergensArr) {
  const a = normalizeAllergensInput(allergensArr);
  if (a.length === 0) return '';
  const joined = a.join(', ');
  const cap = 450;
  return joined.length > cap ? `Allergens: ${joined.slice(0, cap - 20)}…` : `Allergens: ${joined}`;
}

function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('STRIPE_SECRET_KEY is not set');
    err.code = 'CONFIG';
    throw err;
  }
  return new Stripe(key);
}

function checkoutCurrency() {
  return (process.env.STRIPE_CURRENCY || 'gbp').toLowerCase();
}

/** Stripe success/cancel URLs; read from cafe-orders env (not customer-app Vite). */
function resolveFrontendBaseUrl() {
  let raw = String(process.env.FRONTEND_URL || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  return raw.replace(/\/$/, '');
}

function paymentIntentIdFromSession(session) {
  const pi = session.payment_intent;
  if (typeof pi === 'string') return pi;
  if (pi && typeof pi === 'object' && pi.id) return pi.id;
  return null;
}

function buildPaymentSessionEntry(session, type) {
  return {
    session_id: session.id,
    payment_intent_id: paymentIntentIdFromSession(session),
    amount: session.amount_total != null ? Number(session.amount_total) : 0,
    timestamp: new Date().toISOString(),
    type,
  };
}

function createCheckoutRouter() {
  const router = express.Router();

  router.post('/create-checkout-session', requireAuth, async (req, res) => {
    const frontendUrl = resolveFrontendBaseUrl();
    if (!frontendUrl) {
      return res.status(500).json({
        ok: false,
        error:
          'FRONTEND_URL is not set on the cafe-orders server (e.g. cafe-orders/.env or Railway Variables). Use the full customer-app URL, e.g. https://customer-app-production-xxxx.up.railway.app — not customer-app/.env.',
      });
    }

    const {
      line_items: lineItems,
      customer_name: customerName,
      pickup_minutes: pickupMinutes,
      notes,
      allergens,
      apply_reward: applyRewardRaw,
    } = req.body ?? {};
    const applyReward = Boolean(applyRewardRaw);

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'line_items array required with at least one item',
      });
    }
    if (!customerName || typeof customerName !== 'string') {
      return res.status(400).json({ ok: false, error: 'customer_name is required' });
    }

    const pickupM = parseInt(String(pickupMinutes ?? 15), 10);
    const pickupSafe = Number.isFinite(pickupM) ? pickupM : 15;

    try {
      const [catalogItems, modifierCategories] = await Promise.all([
        square.listCatalogItems(),
        square.listModifierCategories(),
      ]);

      let enriched;
      try {
        enriched = enrichLineItemsForCheckout(lineItems, catalogItems, modifierCategories);
      } catch (e) {
        if (e.code === 'CATALOG') {
          return res.status(400).json({ ok: false, error: e.message });
        }
        throw e;
      }

      const subtotal = totalSmallestUnit(enriched);
      if (subtotal <= 0) {
        return res.status(400).json({ ok: false, error: 'Order total must be greater than zero' });
      }

      const lcfg = loyaltyConfig();
      let loyaltyDiscountPence = 0;
      if (applyReward) {
        try {
          await assertRewardAvailable(req.userId, 1);
        } catch (e) {
          if (e.code === 'NO_REWARD') {
            return res.status(400).json({ ok: false, error: 'No rewards available to redeem' });
          }
          throw e;
        }
        const varById = new Map(catalogItems.map((i) => [i.id, i]));
        const { discountPence, eligible } = computeFreeDrinkRewardDiscountPence(
          enriched,
          varById,
          lcfg.rewardMaxPence
        );
        if (!eligible || discountPence <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Add a drink to your basket to use a free drink reward',
          });
        }
        loyaltyDiscountPence = discountPence;
      }

      const totalAmount = Math.max(0, subtotal - loyaltyDiscountPence);
      if (totalAmount < lcfg.stripeMinAmountPence) {
        return res.status(400).json({
          ok: false,
          error: `Order total after reward must be at least £${(lcfg.stripeMinAmountPence / 100).toFixed(2)}`,
        });
      }

      const pendingId = await insertPendingOrder({
        userId: req.userId,
        lineItems: enriched,
        customerName: String(customerName).slice(0, 255),
        pickupMinutes: pickupSafe,
        notes: notes != null ? String(notes).slice(0, 2000) : null,
        allergens: allergens ?? [],
        totalAmount,
        applyReward,
        loyaltyDiscountPence,
      });

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: checkoutCurrency(),
              product_data: {
                name: `Order for ${String(customerName).slice(0, 120)}`,
              },
              unit_amount: totalAmount,
            },
            quantity: 1,
          },
        ],
        success_url: `${frontendUrl.replace(/\/$/, '')}/order/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl.replace(/\/$/, '')}/order/cancelled`,
        metadata: {
          pending_order_id: String(pendingId),
          user_id: String(req.userId),
        },
      });

      await updatePendingOrderSessionId(pendingId, session.id);

      return res.json({
        ok: true,
        sessionId: session.id,
        url: session.url,
      });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('create-checkout-session:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Checkout failed' });
    }
  });

  router.post('/create-incremental-checkout', requireAuth, async (req, res) => {
    const frontendUrl = resolveFrontendBaseUrl();
    if (!frontendUrl) {
      return res.status(500).json({ ok: false, error: 'FRONTEND_URL is not configured' });
    }

    const { order_id: orderIdRaw, additional_line_items: lineItems, apply_reward: applyRewardRaw } =
      req.body ?? {};
    if (Boolean(applyRewardRaw)) {
      return res.status(400).json({
        ok: false,
        error: 'Rewards cannot be applied when adding items to an existing order',
      });
    }
    const orderId = parseInt(String(orderIdRaw), 10);
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ ok: false, error: 'order_id required' });
    }
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ ok: false, error: 'additional_line_items must be a non-empty array' });
    }

    try {
      const parent = await fetchOrderRowForUser(orderId, req.userId);
      if (!parent) {
        return res.status(404).json({ ok: false, error: 'Order not found' });
      }
      if (!['pending', 'confirmed'].includes(parent.status)) {
        return res.status(400).json({
          ok: false,
          error: 'Cannot modify order',
          reason: 'order_not_modifiable',
        });
      }
      if (!parent.square_order_id) {
        return res.status(400).json({ ok: false, error: 'Order has no Square ticket' });
      }
      if (!pickupAllowsModification(parent.pickup_time)) {
        return res.status(400).json({
          ok: false,
          error: 'Cannot modify order',
          reason: 'too_close_to_pickup',
        });
      }

      const [catalogItems, modifierCategories] = await Promise.all([
        square.listCatalogItems(),
        square.listModifierCategories(),
      ]);

      let enriched;
      try {
        enriched = enrichLineItemsForCheckout(lineItems, catalogItems, modifierCategories);
      } catch (e) {
        if (e.code === 'CATALOG') {
          return res.status(400).json({ ok: false, error: e.message });
        }
        throw e;
      }

      const deltaAmount = totalSmallestUnit(enriched);
      if (deltaAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'Additional total must be greater than zero' });
      }

      const originalTotal = Number(parent.total_amount) || 0;
      const newTotal = originalTotal + deltaAmount;

      const pendingId = await insertPendingOrder({
        userId: req.userId,
        lineItems: enriched,
        customerName: String(parent.customer_name || 'Customer').slice(0, 255),
        pickupMinutes: 0,
        notes: null,
        allergens: parent.allergens ?? [],
        totalAmount: deltaAmount,
        originalOrderId: orderId,
        isIncremental: true,
      });

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: checkoutCurrency(),
              product_data: {
                name: `Add to order #${orderId}`,
              },
              unit_amount: deltaAmount,
            },
            quantity: 1,
          },
        ],
        success_url: `${frontendUrl.replace(/\/$/, '')}/order/success?session_id={CHECKOUT_SESSION_ID}&incremental=1`,
        cancel_url: `${frontendUrl.replace(/\/$/, '')}/order/cancelled`,
        metadata: {
          pending_order_id: String(pendingId),
          original_order_id: String(orderId),
          user_id: String(req.userId),
          incremental: 'true',
        },
      });

      await updatePendingOrderSessionId(pendingId, session.id);

      return res.json({
        ok: true,
        sessionId: session.id,
        url: session.url,
        difference: deltaAmount,
        original_total: originalTotal,
        new_total: newTotal,
      });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('create-incremental-checkout:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Checkout failed' });
    }
  });

  return router;
}

async function handleCheckoutSessionCompleted(io, session) {
  const sessionId = session.id;
  const meta = session.metadata || {};
  const isIncremental = meta.incremental === 'true' && meta.original_order_id;

  if (isIncremental) {
    const originalOrderId = parseInt(String(meta.original_order_id), 10);
    const pendingId = meta.pending_order_id;
    if (!Number.isFinite(originalOrderId) || !pendingId) {
      console.error('Stripe webhook incremental: bad metadata');
      return { status: 400, body: 'Bad metadata' };
    }

    const parentEarly = await fetchOrderRowForUser(originalOrderId, meta.user_id);
    if (!parentEarly) {
      return { status: 404, body: 'Order not found' };
    }
    if (paymentSessionsInclude(parentEarly.payment_sessions, sessionId)) {
      return { status: 200, json: { received: true } };
    }

    const pending = await fetchPendingOrderById(pendingId);
    if (!pending || !pending.is_incremental || Number(pending.original_order_id) !== originalOrderId) {
      console.error('Stripe webhook incremental: pending missing or mismatch');
      return { status: 404, body: 'Pending order not found' };
    }

    let enriched = pending.line_items;
    if (typeof enriched === 'string') enriched = JSON.parse(enriched);

    const sessionTotal = session.amount_total != null ? Number(session.amount_total) : null;
    if (sessionTotal != null && sessionTotal !== Number(pending.total_amount)) {
      console.error('Stripe webhook incremental: amount mismatch', sessionTotal, pending.total_amount);
      return { status: 400, body: 'Amount mismatch' };
    }

    if (!parentEarly.square_order_id) {
      return { status: 500, body: 'Parent order missing Square id' };
    }

    const sqAppend = await square.appendLineItemsToOrder(
      parentEarly.square_order_id,
      enriched,
      `stripe-incr-${sessionId}`
    );
    if (sqAppend.error) {
      console.error('Stripe webhook incremental: Square failed:', sqAppend.error);
      return { status: 500, body: 'Square order failed' };
    }

    const paymentEntry = buildPaymentSessionEntry(session, 'incremental');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query(
        `SELECT id, payment_sessions FROM orders WHERE id = $1 FOR UPDATE`,
        [originalOrderId]
      );
      if (lockRows.length === 0) {
        await client.query('ROLLBACK');
        return { status: 404, body: 'Order not found' };
      }
      if (paymentSessionsInclude(lockRows[0].payment_sessions, sessionId)) {
        await client.query('ROLLBACK');
        return { status: 200, json: { received: true } };
      }

      try {
        await persistIncrementalPaidOrderInClient(client, {
          parentOrderId: originalOrderId,
          enrichedLineItems: enriched,
          paymentSessionEntry: paymentEntry,
          pendingOrderId: pendingId,
        });
      } catch (insErr) {
        if (insErr.code === '23505') {
          await client.query('ROLLBACK');
          return { status: 200, json: { received: true } };
        }
        throw insErr;
      }
      await client.query('COMMIT');

      if (io) {
        io.emit('orderUpdated', {
          type: 'items_added',
          dbOrderId: originalOrderId,
          squareOrderId: parentEarly.square_order_id,
        });
      }
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('Stripe webhook incremental DB:', dbErr);
      return { status: 500, body: 'Database error' };
    } finally {
      client.release();
    }

    return { status: 200, json: { received: true } };
  }

  const existing = await findOrderIdByStripeSessionId(sessionId);
  if (existing != null) {
    return { status: 200, json: { received: true } };
  }

  const pendingId = meta.pending_order_id;
  if (!pendingId) {
    console.error('Stripe webhook: missing pending_order_id in metadata');
    return { status: 400, body: 'Missing metadata' };
  }

  const pending = await fetchPendingOrderById(pendingId);
  if (!pending) {
    const again = await findOrderIdByStripeSessionId(sessionId);
    if (again != null) return { status: 200, json: { received: true } };
    console.error('Stripe webhook: pending order not found', pendingId);
    return { status: 404, body: 'Pending order not found' };
  }

  if (pending.is_incremental) {
    return { status: 400, body: 'Use incremental handler' };
  }

  let enriched = pending.line_items;
  if (typeof enriched === 'string') {
    enriched = JSON.parse(enriched);
  }

  const sessionTotal = session.amount_total != null ? Number(session.amount_total) : null;
  if (sessionTotal != null && sessionTotal !== Number(pending.total_amount)) {
    console.error('Stripe webhook: amount mismatch', sessionTotal, pending.total_amount);
    return { status: 400, body: 'Amount mismatch' };
  }

  const locationId = await square.getLocationId();
  if (!locationId) {
    console.error('Stripe webhook: no Square location');
    return { status: 500, body: 'Square not configured' };
  }

  const allergensNorm = normalizeAllergensInput(pending.allergens);
  const squareNote = squarePickupNoteFromAllergens(allergensNorm);

  const squareLineItems = enriched.map((li) => ({
    catalog_object_id: li.catalog_object_id,
    quantity: li.quantity,
    square_modifier_ids: li.square_modifier_ids,
  }));

  const result = await square.createOrder(locationId, squareLineItems, {
    customerName: pending.customer_name,
    note: squareNote,
    pickupMinutes: pending.pickup_minutes,
    idempotencyKey: `stripe-checkout-${sessionId}`,
  });

  if (result.error) {
    console.error('Stripe webhook: Square createOrder failed:', result.error);
    return { status: 500, body: 'Square order failed' };
  }

  const paymentEntry = buildPaymentSessionEntry(session, 'initial');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM orders WHERE stripe_session_id = $1 LIMIT 1 FOR UPDATE`,
      [sessionId]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { status: 200, json: { received: true } };
    }

    let dbOrderId;
    try {
      const out = await persistStripePaidOrderInClient(client, {
        squareOrderId: result.orderId,
        userId: pending.user_id,
        customerName: pending.customer_name,
        notes: pending.notes,
        allergens: pending.allergens,
        pickupMinutes: pending.pickup_minutes,
        enrichedLineItems: enriched,
        stripeSessionId: sessionId,
        pendingOrderId: pendingId,
        paymentSessionEntry: paymentEntry,
        loyaltyDiscountPence: Number(pending.loyalty_discount_pence) || 0,
        applyReward: Boolean(pending.apply_reward),
      });
      dbOrderId = out.dbOrderId;
    } catch (insErr) {
      if (insErr.code === '23505') {
        await client.query('ROLLBACK');
        return { status: 200, json: { received: true } };
      }
      throw insErr;
    }
    await client.query('COMMIT');

    if (io) {
      io.emit('orderUpdated', {
        type: 'created',
        dbOrderId,
        squareOrderId: result.orderId,
      });
    }
  } catch (dbErr) {
    await client.query('ROLLBACK');
    console.error('Stripe webhook: database error:', dbErr);
    return { status: 500, body: 'Database error' };
  } finally {
    client.release();
  }

  return { status: 200, json: { received: true } };
}

function createWebhookHandler(io) {
  return async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error('STRIPE_WEBHOOK_SECRET is not set');
      return res.status(500).send('Webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).send('Missing stripe-signature');
    }

    let event;
    try {
      const stripe = getStripeClient();
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== 'checkout.session.completed') {
      return res.json({ received: true });
    }

    try {
      const session = event.data.object;
      const out = await handleCheckoutSessionCompleted(io, session);
      if (out.json) {
        return res.status(out.status).json(out.json);
      }
      return res.status(out.status).send(out.body);
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).send('Stripe not configured');
      }
      console.error('Stripe webhook:', err);
      return res.status(500).send('Webhook handler error');
    }
  };
}

module.exports = {
  createCheckoutRouter,
  createWebhookHandler,
};

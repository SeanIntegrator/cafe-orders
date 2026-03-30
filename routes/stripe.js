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
  normalizeAllergensInput,
} = require('../lib/orders-db');

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
    } = req.body ?? {};

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

      const totalAmount = totalSmallestUnit(enriched);
      if (totalAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'Order total must be greater than zero' });
      }

      const pendingId = await insertPendingOrder({
        userId: req.userId,
        lineItems: enriched,
        customerName: String(customerName).slice(0, 255),
        pickupMinutes: pickupSafe,
        notes: notes != null ? String(notes).slice(0, 2000) : null,
        allergens: allergens ?? [],
        totalAmount,
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

  return router;
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

    const session = event.data.object;
    const sessionId = session.id;

    try {
      const existing = await findOrderIdByStripeSessionId(sessionId);
      if (existing != null) {
        return res.json({ received: true });
      }

      const pendingId = session.metadata?.pending_order_id;
      if (!pendingId) {
        console.error('Stripe webhook: missing pending_order_id in metadata');
        return res.status(400).send('Missing metadata');
      }

      const pending = await fetchPendingOrderById(pendingId);
      if (!pending) {
        const again = await findOrderIdByStripeSessionId(sessionId);
        if (again != null) return res.json({ received: true });
        console.error('Stripe webhook: pending order not found', pendingId);
        return res.status(404).send('Pending order not found');
      }

      let enriched = pending.line_items;
      if (typeof enriched === 'string') {
        enriched = JSON.parse(enriched);
      }

      const sessionTotal = session.amount_total != null ? Number(session.amount_total) : null;
      if (sessionTotal != null && sessionTotal !== Number(pending.total_amount)) {
        console.error('Stripe webhook: amount mismatch', sessionTotal, pending.total_amount);
        return res.status(400).send('Amount mismatch');
      }

      const locationId = await square.getLocationId();
      if (!locationId) {
        console.error('Stripe webhook: no Square location');
        return res.status(500).send('Square not configured');
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
        return res.status(500).send('Square order failed');
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const dup = await client.query(
          `SELECT id FROM orders WHERE stripe_session_id = $1 LIMIT 1 FOR UPDATE`,
          [sessionId]
        );
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.json({ received: true });
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
          });
          dbOrderId = out.dbOrderId;
        } catch (insErr) {
          if (insErr.code === '23505') {
            await client.query('ROLLBACK');
            return res.json({ received: true });
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
        return res.status(500).send('Database error');
      } finally {
        client.release();
      }

      return res.json({ received: true });
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

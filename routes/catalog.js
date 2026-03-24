/**
 * Catalog and create-order routes.
 */

const express = require('express');
const square = require('../lib/square');
const { requireAuth } = require('../middleware/auth');
const { persistOrderFromCheckout } = require('../lib/orders-db');

module.exports = function createCatalogRouter(io) {
  const router = express.Router();

  async function handleCreateOrder(req, res) {
    const { line_items: lineItems, customer_name, note, pickup_minutes } = req.body ?? {};
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'line_items array required with at least one item',
      });
    }
    try {
      const locationId = await square.getLocationId();
      if (!locationId) {
        return res.status(500).json({ ok: false, error: 'No location found in Square' });
      }
      const orderLineItems = lineItems.map((li) => ({
        catalog_object_id: li.catalog_object_id,
        quantity: String(li.quantity || 1),
      }));
      const result = await square.createOrder(locationId, orderLineItems, {
        customerName: customer_name,
        note,
        pickupMinutes: pickup_minutes,
      });
      if (result.error) {
        return res.status(500).json({ ok: false, error: result.error });
      }

      try {
        const { dbOrderId } = await persistOrderFromCheckout({
          squareOrderId: result.orderId,
          userId: req.userId || null,
          customerName: customer_name || 'Walk-in',
          note,
          pickupMinutes: pickup_minutes,
          rawLineItems: lineItems,
          orderSource: req.userId ? 'web_app' : 'kds_test',
        });
        if (io) {
          io.emit('orderUpdated', {
            type: 'created',
            dbOrderId,
            squareOrderId: result.orderId,
          });
        }
        res.json({
          ok: true,
          order_id: result.orderId,
          db_order_id: dbOrderId,
        });
      } catch (dbErr) {
        console.error('Persist order failed:', dbErr);
        res.status(500).json({
          ok: false,
          error: 'Order created in Square but could not be saved to the database',
          order_id: result.orderId,
        });
      }
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('Create order error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }

  router.get('/api/catalog-items', async (req, res) => {
    try {
      const items = await square.listCatalogItems();
      res.json({ ok: true, items });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('GET /api/catalog-items error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/modifier-categories', async (req, res) => {
    try {
      const categories = await square.listModifierCategories();
      res.json({ ok: true, categories });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('GET /api/modifier-categories error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Same-origin KDS / test tooling (no session). */
  router.post('/api/create-order', handleCreateOrder);

  /** Customer app: requires Google session JWT. */
  router.post('/api/customer/create-order', requireAuth, handleCreateOrder);

  return router;
};

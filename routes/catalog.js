/**
 * Catalog and create-order routes.
 */

const express = require('express');
const router = express.Router();
const square = require('../lib/square');
const { requireAuth } = require('../middleware/auth');

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
    res.json({ ok: true, order_id: result.orderId });
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

module.exports = router;

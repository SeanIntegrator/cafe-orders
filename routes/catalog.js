/**
 * Catalog and create-order routes.
 */

const express = require('express');
const square = require('../lib/square');
const { requireAuth } = require('../middleware/auth');
const { persistOrderFromCheckout, normalizeAllergensInput } = require('../lib/orders-db');

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
let catalogItemsCache = { data: null, expiresAt: 0 };
let modifierCategoriesCache = { data: null, expiresAt: 0 };

async function getCachedCatalogItems() {
  const now = Date.now();
  if (catalogItemsCache.data && now < catalogItemsCache.expiresAt) {
    return catalogItemsCache.data;
  }
  const items = await square.listCatalogItems();
  catalogItemsCache = { data: items, expiresAt: now + CATALOG_CACHE_TTL_MS };
  return items;
}

async function getCachedModifierCategories() {
  const now = Date.now();
  if (modifierCategoriesCache.data && now < modifierCategoriesCache.expiresAt) {
    return modifierCategoriesCache.data;
  }
  const categories = await square.listModifierCategories();
  modifierCategoriesCache = { data: categories, expiresAt: now + CATALOG_CACHE_TTL_MS };
  return categories;
}

function squarePickupNoteFromAllergens(allergensArr) {
  const a = normalizeAllergensInput(allergensArr);
  if (a.length === 0) return '';
  const joined = a.join(', ');
  const cap = 450;
  return joined.length > cap ? `Allergens: ${joined.slice(0, cap - 20)}…` : `Allergens: ${joined}`;
}

module.exports = function createCatalogRouter(io) {
  const router = express.Router();

  async function handleCreateOrder(req, res) {
    const { line_items: lineItems, customer_name, pickup_minutes, allergens } = req.body ?? {};
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
      const allergensNorm = normalizeAllergensInput(allergens);
      const squareNote = squarePickupNoteFromAllergens(allergensNorm);
      const result = await square.createOrder(locationId, orderLineItems, {
        customerName: customer_name,
        note: squareNote,
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
          notes: null,
          allergens: allergensNorm,
          pickupMinutes: pickup_minutes,
          rawLineItems: lineItems,
          orderSource: 'web_app',
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
      const items = await getCachedCatalogItems();
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
      const categories = await getCachedModifierCategories();
      res.json({ ok: true, categories });
    } catch (err) {
      if (err.code === 'CONFIG') {
        return res.status(500).json({ ok: false, error: err.message });
      }
      console.error('GET /api/modifier-categories error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Customer app: requires Google session JWT. */
  router.post('/api/customer/create-order', requireAuth, handleCreateOrder);

  return router;
};

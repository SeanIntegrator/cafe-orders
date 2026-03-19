/**
 * Square API helpers. All functions require SQUARE_ACCESS_TOKEN and use SQUARE_ENV.
 */

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || 'production';
const SQUARE_BASE_URL =
  SQUARE_ENV === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

const squareHeaders = {
  Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
  'Square-Version': '2024-11-20',
};

function requireToken() {
  if (!SQUARE_ACCESS_TOKEN) {
    const err = new Error('SQUARE_ACCESS_TOKEN not set');
    err.code = 'CONFIG';
    throw err;
  }
}

/**
 * @returns {Promise<string|null>} First location ID or null
 */
async function getLocationId() {
  requireToken();
  const res = await fetch(`${SQUARE_BASE_URL}/v2/locations`, {
    method: 'GET',
    headers: squareHeaders,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Square locations failed:', res.status, text);
    return null;
  }
  const data = await res.json();
  return data.locations?.[0]?.id ?? null;
}

/**
 * @param {string} orderId
 * @returns {Promise<object|null>} Order object or null
 */
async function fetchOrder(orderId) {
  requireToken();
  try {
    console.log('Fetching order from Square:', orderId);
    const res = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      method: 'GET',
      headers: squareHeaders,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('Square Orders API non-200:', res.status, text);
      return null;
    }
    const data = await res.json();
    return data.order ?? null;
  } catch (err) {
    console.error('Error fetching order from Square:', err);
    return null;
  }
}

/**
 * @param {object} order - Square order object
 * @returns {boolean} True if order has been paid (has tenders or state COMPLETED)
 */
function isOrderPaid(order) {
  if (!order) return false;
  if (order.state === 'COMPLETED') return true;
  return Array.isArray(order.tenders) && order.tenders.length > 0;
}

/**
 * @returns {Promise<object[]>} Array of open orders
 */
async function searchOpenOrders() {
  requireToken();
  const locationId = await getLocationId();
  if (!locationId) {
    console.error('No Square location found');
    return [];
  }
  const searchBody = {
    location_ids: [locationId],
    query: {
      filter: {
        state_filter: { states: ['OPEN'] },
      },
    },
    limit: 100,
  };
  const res = await fetch(`${SQUARE_BASE_URL}/v2/orders/search`, {
    method: 'POST',
    headers: squareHeaders,
    body: JSON.stringify(searchBody),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('SearchOrders failed:', res.status, text);
    return [];
  }
  const data = await res.json();
  return data.orders ?? [];
}

/**
 * Set fulfillments to COMPLETED. Fails if order is not paid.
 * @param {string} orderId
 * @param {number} version
 * @param {object[]} fulfillments - Array of { uid, type?, state? }
 * @returns {{ completed: boolean, error?: string }}
 */
async function completeOrderFulfillments(orderId, version, fulfillments) {
  requireToken();
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    return { completed: false, error: 'No fulfillments to complete' };
  }
  const safeVersion = Number.isFinite(version) ? version : 0;
  const updatedFulfillments = fulfillments.map((f) => ({
    uid: f.uid,
    type: f.type || 'PICKUP',
    state: 'COMPLETED',
  }));
  const idempotencyKey = `complete-${orderId}-${safeVersion}-${Date.now()}`;
  const body = {
    idempotency_key: idempotencyKey,
    order: {
      version: safeVersion,
      fulfillments: updatedFulfillments,
    },
  };
  const res = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
    method: 'PUT',
    headers: squareHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('UpdateOrder failed:', res.status, text);
    let message = 'Failed to complete order';
    try {
      const errJson = JSON.parse(text);
      const detail = errJson?.errors?.[0]?.detail;
      if (detail) message = detail;
    } catch (_) {}
    return { completed: false, error: message };
  }
  return { completed: true };
}

/**
 * @returns {Promise<{ id: string, name: string }[]>}
 */
async function listCatalogItems() {
  requireToken();
  const res = await fetch(`${SQUARE_BASE_URL}/v2/catalog/list?types=ITEM`, {
    method: 'GET',
    headers: squareHeaders,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Catalog list failed:', res.status, text);
    return [];
  }
  const data = await res.json();
  const objects = data.objects ?? [];
  const items = [];
  for (const obj of objects) {
    const variations = obj.item_data?.variations;
    const name = obj.item_data?.name || obj.id;
    if (variations?.length && variations[0].id && name) {
      const priceAmount = variations[0].item_variation_data?.price_money?.amount ?? null;
      items.push({ id: variations[0].id, name, price: priceAmount });
    }
  }
  return items;
}

/**
 * Returns modifier lists (categories) with option IDs for display ordering.
 * Categories are ordered by name so e.g. "Milk" comes before "Syrup".
 * @returns {Promise<{ id: string, name: string, optionIds: string[] }[]>}
 */
async function listModifierCategories() {
  requireToken();
  const res = await fetch(
    `${SQUARE_BASE_URL}/v2/catalog/list?types=MODIFIER_LIST`,
    { method: 'GET', headers: squareHeaders }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('Catalog modifier lists failed:', res.status, text);
    return [];
  }
  const data = await res.json();
  const objects = data.objects ?? [];
  const categories = objects
    .filter((obj) => obj.type === 'MODIFIER_LIST' && obj.modifier_list_data)
    .map((obj) => ({
      id: obj.id,
      name: obj.modifier_list_data.name || obj.id,
      optionIds: (obj.modifier_list_data.modifiers || []).map((m) => m.id).filter(Boolean),
      modifiers: (obj.modifier_list_data.modifiers || [])
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          name: m.modifier_data?.name || m.id,
          price: m.modifier_data?.price_money?.amount ?? 0,
        })),
    }))
    .filter((c) => c.optionIds.length > 0);
  categories.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return categories;
}

/**
 * @param {string} locationId
 * @param {Array<{ catalog_object_id: string, quantity: string }>} lineItems
 * @param {{ customerName?: string, note?: string }} [options]
 * @returns {Promise<{ orderId: string }|{ error: string }>}
 */
async function createOrder(locationId, lineItems, options = {}) {
  requireToken();
  const customerName = options.customerName || 'Walk-in';
  const note = options.note || '';
  const pickupMinutes = options.pickupMinutes ?? 15;
  const pickupMs = pickupMinutes === 0 ? 5 * 60 * 1000 : pickupMinutes * 60 * 1000;
  const idempotencyKey = `order-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const orderBody = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: locationId,
      reference_id: `T${Date.now().toString().slice(-4)}`,
      fulfillments: [
        {
          type: 'PICKUP',
          state: 'PROPOSED',
          pickup_details: {
            recipient: { display_name: customerName },
            note,
            pickup_at: new Date(Date.now() + pickupMs).toISOString(),
          },
        },
      ],
      line_items: lineItems.map((li) => ({
        quantity: String(li.quantity || 1),
        catalog_object_id: li.catalog_object_id,
      })),
    },
  };
  const res = await fetch(`${SQUARE_BASE_URL}/v2/orders`, {
    method: 'POST',
    headers: squareHeaders,
    body: JSON.stringify(orderBody),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('CreateOrder failed:', res.status, text);
    return { error: 'Create order failed' };
  }
  const result = await res.json();
  const orderId = result.order?.id;
  if (!orderId) return { error: 'No order ID in response' };
  console.log('Order created:', orderId);
  return { orderId };
}

module.exports = {
  SQUARE_BASE_URL,
  SQUARE_ENV,
  getLocationId,
  fetchOrder,
  isOrderPaid,
  searchOpenOrders,
  completeOrderFulfillments,
  listCatalogItems,
  listModifierCategories,
  createOrder,
};

/** API fetch wrappers for communication with the Express backend. */

import { orders, modifierSortOrder } from './state.js';
import { showToast } from './ui.js';
import { dismissOrder } from './board.js';

export async function loadModifierCategories() {
  try {
    const res = await fetch('/api/modifier-categories');
    const data = await res.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.categories)) {
      modifierSortOrder.clear();
      data.categories.forEach((cat, idx) => {
        (cat.optionIds || []).forEach((oid) => modifierSortOrder.set(oid, idx));
      });
    }
  } catch (e) {
    console.warn('Could not load modifier categories:', e);
  }
}

export async function loadLiveOrders(addOrUpdateOrder) {
  try {
    const res = await fetch('/api/orders');
    const data = await res.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.orders) && data.orders.length > 0) {
      data.orders.forEach((order) => addOrUpdateOrder(order));
      return true;
    }
  } catch (e) {
    console.warn('Could not load live orders:', e);
  }
  return false;
}

export async function handleDone(id) {
  if (id.startsWith('demo-')) {
    dismissOrder(id);
    return;
  }
  const btn = document.querySelector(`#card-${id} .kds-callout-btn`);
  if (btn) btn.disabled = true;

  const record = orders[id];
  const order = record?.order;
  const payload = {};
  if (order) {
    payload.version = order.version;
    payload.fulfillments = order.fulfillments;
    payload.state = order.state;
    payload.tenders = order.tenders;
    if (order.total_money) payload.total_money = order.total_money;
  }

  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok || data.already) {
      dismissOrder(id);
      if (data.completed === false && data.message) {
        showToast(data.message, 'success');
      }
    } else {
      showToast(data.error || 'Could not complete order', 'error');
      if (btn) btn.disabled = false;
    }
  } catch (e) {
    showToast('Network error', 'error');
    if (btn) btn.disabled = false;
  }
}


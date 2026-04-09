/** API fetch wrappers for communication with the Express backend. */

import { orders, modifierSortOrder, serviceModifierOptionIds } from './state.js';
import { showToast } from './ui.js';
import { dismissOrder, addOrUpdateOrder } from './board.js';

/** Same idea as board wait timers (`createdAt`); not the green/amber/red thresholds in board.js. */
const DISMISS_OLD_WAIT_MS = 30 * 60 * 1000;

export async function loadModifierCategories() {
  try {
    const res = await fetch('/api/modifier-categories');
    const data = await res.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.categories)) {
      modifierSortOrder.clear();
      serviceModifierOptionIds.clear();
      data.categories.forEach((cat, idx) => {
        const catName = String(cat.name || '');
        const isServiceList = /\bservice\b/i.test(catName);
        (cat.optionIds || []).forEach((oid) => {
          modifierSortOrder.set(oid, idx);
          if (isServiceList) serviceModifierOptionIds.add(oid);
        });
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

  const record = orders[id];
  const order = record?.order;
  const createdAt = record?.createdAt;
  const payload = {};
  if (order) {
    payload.version = order.version;
    payload.fulfillments = order.fulfillments;
    payload.state = order.state;
    payload.tenders = order.tenders;
    if (order.total_money) payload.total_money = order.total_money;
  }

  /** Optimistic: remove from the board immediately; restore if the request fails. */
  dismissOrder(id);

  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok || data.already) {
      if (data.completed === false && data.message) {
        showToast(data.message, 'success');
      }
    } else {
      showToast(data.error || 'Could not complete order', 'error');
      if (order && typeof createdAt === 'number') {
        addOrUpdateOrder(order, { createdAtMs: createdAt });
      }
    }
  } catch (e) {
    showToast('Network error', 'error');
    if (order && typeof createdAt === 'number') {
      addOrUpdateOrder(order, { createdAtMs: createdAt });
    }
  }
}

/**
 * Call out / complete every order whose on-board wait time is at least 30 minutes
 * (same basis as the red timer on each card).
 */
export async function dismissOrdersPastWaitThreshold() {
  const now = Date.now();
  const ids = Object.entries(orders)
    .filter(([, data]) => now - data.createdAt >= DISMISS_OLD_WAIT_MS)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
  if (ids.length === 0) {
    showToast('No orders over 30 minutes', 'info');
    return;
  }
  if (!window.confirm(`Dismiss ${ids.length} order(s) waiting over 30 minutes?`)) {
    return;
  }
  for (const id of ids) {
    if (!orders[id]) continue;
    await handleDone(id);
  }
}

export async function recallLatestDismissedOrder() {
  try {
    const res = await fetch('/api/kds/recall-next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || 'No recallable completed orders' };
    }
    return {
      ok: true,
      order: data.order,
      kdsRecallResetAtMs: data.kdsRecallResetAtMs,
      squareOrderId: data.squareOrderId,
    };
  } catch (_e) {
    return { ok: false, error: 'Network error' };
  }
}


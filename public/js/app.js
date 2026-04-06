/** Entry point — socket setup, init sequence, and demo data. */

import { loadModifierCategories, loadLiveOrders, dismissOrdersPastWaitThreshold } from './api.js';
import { addOrUpdateOrder, updateTimers, dismissOrder } from './board.js';
import { setConnectionStatus } from './ui.js';
import './history.js';

setConnectionStatus('reconnecting');

/* global io */
const socket = io({
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  console.log('Connected to server');
  setConnectionStatus('connected');
  loadModifierCategories();
  loadLiveOrders(addOrUpdateOrder);
});

socket.on('disconnect', () => {
  setConnectionStatus('reconnecting');
});

socket.on('reconnect', () => {
  setConnectionStatus('connected');
});

socket.on('reconnect_failed', () => {
  setConnectionStatus('failed');
});

if (socket.io) {
  socket.io.on('reconnect_attempt', () => {
    setConnectionStatus('reconnecting');
  });
}

socket.on('new-order', (payload) => {
  console.log('Received new-order event from server:', payload);
  const list = Array.isArray(payload) ? payload : [payload];
  list.forEach((item) => {
    const order = item?.order ?? item;
    if (!order?.id) return;
    const reset = item?.kdsRecallResetAtMs;
    const opts =
      typeof reset === 'number' && !Number.isNaN(reset) ? { createdAtMs: reset } : undefined;
    addOrUpdateOrder(order, opts);
  });
});

socket.on('orderUpdated', () => {
  loadLiveOrders(addOrUpdateOrder);
});

socket.on('orderCancelled', (payload) => {
  const sq = payload?.squareOrderId != null ? String(payload.squareOrderId) : '';
  if (sq) dismissOrder(sq);
  loadLiveOrders(addOrUpdateOrder);
});

/** Square order fully completed/canceled in Dashboard, POS, or API — remove from KDS without a full page reload */
socket.on('squareOrderClosed', (payload) => {
  const sq = payload?.squareOrderId != null ? String(payload.squareOrderId) : '';
  if (sq) dismissOrder(sq);
});

// Toggle completion state when clicking a line item
document.getElementById('board-container').addEventListener('click', (event) => {
  const line = event.target.closest('[data-kds-line]');
  if (!line) return;
  line.classList.toggle('completed');
});

setInterval(updateTimers, 1000);

document.getElementById('dismiss-old-orders-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('dismiss-old-orders-btn');
  if (!btn) return;
  btn.disabled = true;
  try {
    await dismissOrdersPastWaitThreshold();
  } finally {
    btn.disabled = false;
  }
});

// Modifier order for milk chips on cards, then live Square orders only
loadModifierCategories().then(() => loadLiveOrders(addOrUpdateOrder));

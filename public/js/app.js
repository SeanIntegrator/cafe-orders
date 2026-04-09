/** Entry point — socket setup, init sequence, and demo data. */

import {
  loadModifierCategories,
  loadLiveOrders,
  dismissOrdersPastWaitThreshold,
  recallLatestDismissedOrder,
} from './api.js';
import { addOrUpdateOrder, updateTimers, dismissOrder, applyViewMode } from './board.js';
import { setConnectionStatus, showToast } from './ui.js';
import { setViewMode, viewMode } from './state.js';
import './history.js';

setConnectionStatus('reconnecting');

const drawerOverlay = document.getElementById('header-drawer-overlay');
const menuBtn = document.getElementById('header-menu-btn');
const drawerCloseBtn = document.getElementById('header-drawer-close');

function closeHeaderDrawer() {
  if (!drawerOverlay || !menuBtn) return;
  drawerOverlay.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
}

function openHeaderDrawer() {
  if (!drawerOverlay || !menuBtn) return;
  drawerOverlay.classList.remove('hidden');
  menuBtn.setAttribute('aria-expanded', 'true');
}

function syncViewToggleUi() {
  document.querySelectorAll('#view-toggle .view-toggle__btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewMode);
  });
}

document.getElementById('view-toggle')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-view]');
  if (!btn) return;
  const v = btn.getAttribute('data-view');
  if (v !== 'cards' && v !== 'flow') return;
  setViewMode(v);
  applyViewMode();
  syncViewToggleUi();
  closeHeaderDrawer();
});

menuBtn?.addEventListener('click', () => {
  const isOpen = !drawerOverlay?.classList.contains('hidden');
  if (isOpen) closeHeaderDrawer();
  else openHeaderDrawer();
});

drawerCloseBtn?.addEventListener('click', closeHeaderDrawer);

drawerOverlay?.addEventListener('click', (event) => {
  if (event.target === drawerOverlay) closeHeaderDrawer();
});

document.getElementById('history-recall-btn')?.addEventListener('click', () => {
  closeHeaderDrawer();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeHeaderDrawer();
});

applyViewMode();
syncViewToggleUi();

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

/** Debounce so FLIP / swipe animations can finish before a full list refresh replaces flow DOM. */
let orderUpdatedDebounce = null;
socket.on('orderUpdated', () => {
  clearTimeout(orderUpdatedDebounce);
  orderUpdatedDebounce = setTimeout(() => {
    orderUpdatedDebounce = null;
    loadLiveOrders(addOrUpdateOrder);
  }, 450);
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
    closeHeaderDrawer();
  }
});

document.getElementById('instant-recall-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('instant-recall-btn');
  if (!btn) return;
  btn.disabled = true;
  try {
    const result = await recallLatestDismissedOrder();
    if (!result.ok) {
      showToast(result.error || 'No recallable completed orders', 'info');
      return;
    }
    addOrUpdateOrder(result.order, { createdAtMs: result.kdsRecallResetAtMs });
  } finally {
    btn.disabled = false;
  }
});

// Modifier order for milk chips on cards, then live Square orders only
loadModifierCategories().then(() => loadLiveOrders(addOrUpdateOrder));

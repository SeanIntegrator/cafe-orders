/**
 * KDS — recent orders modal: merged Postgres (app) + Square orders,
 * service-type filter, text search, period range.
 */

import { orders, serviceModifierOptionIds } from './state.js';
import { addOrUpdateOrder } from './board.js';
import { showToast } from './ui.js';
import {
  getServiceLabel,
  getServiceChoiceFromModifiers,
  isEatInOrder,
} from './helpers.js';

const overlay = document.getElementById('history-modal-overlay');
const closeBtn = document.getElementById('history-modal-close');
const openBtn = document.getElementById('history-recall-btn');
const listEl = document.getElementById('history-modal-list');
const periodSelect = document.getElementById('history-period-select');
const serviceSelect = document.getElementById('history-service-filter');
const searchInput = document.getElementById('history-order-search');

let currentPeriod = 'today';
let squareCursor = null;
let squareAccumulated = [];
/** @type {any[]} */
let cachedDbOrders = [];
/** @type {{ kind: 'db'|'square', order: any, serviceBucket: string|null, haystack: string, sortKey: string }[]} */
let cachedBaseMergedRows = [];

let searchDebounceTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(pence) {
  const n = Number(pence) || 0;
  return `£${(n / 100).toFixed(2)}`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function modifierLabel(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (m.kind === 'item_emoji') return '';
  return m.name || m.id || '';
}

/** Modifier name list for Flow-style pills (same order as main KDS line). */
function modifierPartsFromDb(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return [];
  return mods.map(modifierLabel).filter(Boolean);
}

/** Square line_item.modifiers → pill labels */
function modifierPartsFromSquare(it) {
  if (!Array.isArray(it.modifiers) || it.modifiers.length === 0) return [];
  return it.modifiers.map((m) => (m && m.name ? String(m.name) : '')).filter(Boolean);
}

function modifiersPrepHtml(parts) {
  if (!parts.length) return '';
  const pills = parts
    .map((p) => `<span class="flow-chip-pill">${escapeHtml(p)}</span>`)
    .join('');
  return `<div class="history-line-prep" role="presentation">${pills}</div>`;
}

function squareCustomerName(order) {
  const ff = order.fulfillments;
  if (Array.isArray(ff) && ff.length) {
    const displayName =
      ff[0]?.pickup_details?.recipient?.display_name ||
      ff[0]?.delivery_details?.recipient?.display_name ||
      ff[0]?.shipment_details?.recipient?.display_name;
    if (displayName) return displayName;
  }
  return null;
}

/** @returns {string|null} 'PICKUP' | 'TAKEAWAY' | 'SIT IN' | null (null = unclassified, only in All) */
function serviceBucketSquare(order) {
  return getServiceLabel(order, isEatInOrder(order), serviceModifierOptionIds);
}

/** @returns {string|null} */
function serviceBucketDb(order) {
  const line_items = (order.items || []).map((it) => ({
    name: it.item_name || 'Item',
    modifiers: (it.modifiers || []).map((m) => ({
      name: modifierLabel(m),
      catalog_object_id: (m && m.catalog_object_id) || '',
    })),
  }));
  return getServiceChoiceFromModifiers({ line_items }, serviceModifierOptionIds);
}

function haystackDb(order) {
  const parts = [order.customer_name, order.notes];
  for (const it of order.items || []) {
    parts.push(it.item_name, it.customer_note);
    for (const m of it.modifiers || []) parts.push(modifierLabel(m));
  }
  return parts
    .filter((x) => x != null && String(x).trim())
    .join('\n')
    .toLowerCase();
}

function haystackSquare(order) {
  const parts = [squareCustomerName(order), order.note];
  for (const it of order.line_items || []) {
    parts.push(it.name, it.note);
    for (const m of it.modifiers || []) parts.push(m && m.name ? String(m.name) : '');
  }
  return parts
    .filter((x) => x != null && String(x).trim())
    .join('\n')
    .toLowerCase();
}

/**
 * Square wins when the same square id exists in both feeds; DB-only rows stay for recall without Square mirror.
 * @param {any[]} dbOrders
 * @param {any[]} squareOrders
 */
function buildMergedRows(dbOrders, squareOrders) {
  const sqIds = new Set(
    (squareOrders || []).map((o) => (o && o.id ? String(o.id) : '')).filter(Boolean)
  );
  /** @type {{ kind: 'db'|'square', order: any, serviceBucket: string|null, haystack: string, sortKey: string }[]} */
  const rows = [];

  for (const o of squareOrders || []) {
    if (!o) continue;
    rows.push({
      kind: 'square',
      order: o,
      serviceBucket: serviceBucketSquare(o),
      haystack: haystackSquare(o),
      sortKey: String(o.created_at || ''),
    });
  }

  for (const o of dbOrders || []) {
    if (!o) continue;
    const sid = o.square_order_id != null ? String(o.square_order_id).trim() : '';
    if (sid && sqIds.has(sid)) continue;
    rows.push({
      kind: 'db',
      order: o,
      serviceBucket: serviceBucketDb(o),
      haystack: haystackDb(o),
      sortKey: String(o.created_at || ''),
    });
  }

  rows.sort((a, b) => {
    const ta = new Date(a.sortKey).getTime();
    const tb = new Date(b.sortKey).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return rows;
}

function filterKeyToServiceBucket(key) {
  const k = String(key || 'all').toLowerCase();
  if (k === 'pickup') return 'PICKUP';
  if (k === 'takeaway') return 'TAKEAWAY';
  if (k === 'sit_in') return 'SIT IN';
  return null;
}

function getCurrentServiceFilterKey() {
  return (serviceSelect && serviceSelect.value) || 'all';
}

function getCurrentSearchQuery() {
  return (searchInput && searchInput.value) || '';
}

function filterMergedRows(baseRows) {
  const serviceKey = getCurrentServiceFilterKey();
  const targetBucket = filterKeyToServiceBucket(serviceKey);
  let rows = baseRows;
  if (targetBucket) {
    rows = rows.filter((r) => r.serviceBucket === targetBucket);
  }
  const q = getCurrentSearchQuery().trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.haystack.includes(q));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// DB orders (web_app / Postgres)
// ---------------------------------------------------------------------------

function recallButtonHtml(squareId) {
  if (!squareId) return '';
  const esc = escapeHtml(squareId);
  return `<button type="button" class="history-recall-btn history-recall-btn--primary" data-recall-square-id="${esc}" aria-label="Recall order to board">Recall</button>`;
}

function showRecallForDb(order) {
  if (String(order.status || '').toLowerCase() !== 'completed') return false;
  const sq = order.square_order_id;
  if (!sq) return false;
  if (orders[sq]) return false;
  return true;
}

function showRecallForSquare(order) {
  if (order.state !== 'COMPLETED') return false;
  if (!order.id) return false;
  if (orders[order.id]) return false;
  return true;
}

async function recallOrderToBoard(squareOrderId, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await fetch('/api/kds/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squareOrderId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showToast(data.error || 'Could not recall order', 'error');
      if (triggerBtn) triggerBtn.disabled = false;
      return;
    }
    addOrUpdateOrder(data.order, { createdAtMs: data.kdsRecallResetAtMs });
    showToast('Order recalled back to board', 'success');
  } catch (e) {
    showToast('Network error', 'error');
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

function dbOrderChannelLabel(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'web_app' || s === 'whatsapp') return 'App order';
  return 'Walk in';
}

function dbStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'confirmed') return 'Confirmed';
  if (s === 'ready') return 'Ready';
  if (s === 'completed') return 'Collected';
  if (s === 'cancelled') return 'Cancelled';
  if (s === 'pending') return 'Pending';
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
}

function dbStatusBadgeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'cancelled') return 'status-cancelled';
  if (s === 'ready') return 'takeaway';
  if (s === 'completed') return 'eat-in';
  if (s === 'confirmed') return 'paid';
  return 'unpaid';
}

function dbLineItemRow(it) {
  const emoji = it.item_emoji ? `<span class="history-line-emoji" aria-hidden="true">${escapeHtml(it.item_emoji)}</span>` : '';
  const parts = modifierPartsFromDb(it.modifiers);
  const modHtml = modifiersPrepHtml(parts);
  return `<li class="history-line-item">
    <div class="history-line-top">
      ${emoji}
      <div class="history-line-text-row">
        <span class="history-line-main"><span class="history-line-qty">${it.quantity}×</span> ${escapeHtml(it.item_name || 'Item')}</span>
        ${modHtml || ''}
      </div>
    </div>
  </li>`;
}

function renderDbOrder(order) {
  const items = order.items || [];
  const lines = items.map(dbLineItemRow).join('');
  const notes = order.notes
    ? `<div class="history-notes"><span class="history-notes-label">Note</span> ${escapeHtml(order.notes)}</div>`
    : '';
  const channel = dbOrderChannelLabel(order.order_source);
  const sq = order.square_order_id;
  const onBoard = Boolean(sq && orders[sq]);
  let stLabel = dbStatusLabel(order.status);
  let badgeCls = dbStatusBadgeClass(order.status);
  if (onBoard) {
    stLabel = 'Tendered';
    badgeCls = 'tendered';
  }
  const recallHtml = showRecallForDb(order) ? recallButtonHtml(order.square_order_id) : '';

  return `
    <article class="history-order-card">
      <div class="history-order-top">
        <div class="history-order-meta">
          <div class="history-order-name">${escapeHtml(order.customer_name || 'Customer')}</div>
          <div class="history-order-sub">${formatWhen(order.created_at)} · ${escapeHtml(channel)}</div>
        </div>
        <div class="history-order-right">
          <div class="history-order-badges">
            ${recallHtml}
            <span class="badge ${badgeCls}">${escapeHtml(stLabel)}</span>
          </div>
          <span class="history-order-total">${formatMoney(order.total_amount)}</span>
        </div>
      </div>
      <ul class="history-order-lines">${lines || '<li class="history-line-item history-line-empty">No items listed</li>'}</ul>
      ${notes}
    </article>
  `;
}

async function fetchDbHistory(period) {
  const res = await fetch(`/api/kds/orders?period=${encodeURIComponent(period)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Square orders (all types incl. POS)
// ---------------------------------------------------------------------------

function periodToSquareFrom(period) {
  const now = Date.now();
  if (period === 'hour') return new Date(now - 60 * 60 * 1000).toISOString();
  if (period === 'week') return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (period === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (period === 'all') return '2020-01-01T00:00:00Z';
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function squareStateLabel(state) {
  if (!state) return '—';
  if (state === 'OPEN') return 'Open';
  if (state === 'COMPLETED') return 'Completed';
  if (state === 'CANCELED') return 'Cancelled';
  if (state === 'DRAFT') return 'Draft';
  return state.charAt(0) + state.slice(1).toLowerCase();
}

function squareStateBadgeClass(state) {
  if (state === 'OPEN') return 'paid';
  if (state === 'COMPLETED') return 'eat-in';
  if (state === 'CANCELED') return 'status-cancelled';
  return 'takeaway';
}

function squareSourceLabel(order) {
  const name = order.source?.name;
  if (!name) return 'Square';
  const n = name.toLowerCase();
  if (n.includes('point of sale') || n === 'square') return 'POS';
  if (n.includes('online')) return 'Online';
  return name;
}

function squareLineItemRow(it) {
  const qty = it.quantity || '1';
  const name = it.name || it.catalog_object_id || 'Item';
  const parts = modifierPartsFromSquare(it);
  const modHtml = modifiersPrepHtml(parts);
  const note = it.note
    ? `<div class="history-line-mods-wrap--note"><span class="history-line-note-text">${escapeHtml(it.note)}</span></div>`
    : '';
  return `<li class="history-line-item">
    <div class="history-line-top">
      <div class="history-line-text-row">
        <span class="history-line-main"><span class="history-line-qty">${escapeHtml(qty)}×</span> ${escapeHtml(name)}</span>
        ${modHtml || ''}
      </div>
    </div>
    ${note}
  </li>`;
}

function renderSquareOrder(order) {
  const items = order.line_items || [];
  const lines = items.map(squareLineItemRow).join('');
  const customerName = squareCustomerName(order) || 'Walk-in';
  const sourceLbl = squareSourceLabel(order);
  const total = order.total_money?.amount ?? order.net_amounts?.total_money?.amount;
  const onBoard = Boolean(order.id && orders[order.id]);
  let stateLabel = squareStateLabel(order.state);
  let badgeClass = squareStateBadgeClass(order.state);
  if (onBoard) {
    stateLabel = 'Tendered';
    badgeClass = 'tendered';
  }
  const orderId = order.id ? `<span class="history-square-id" title="Square order ID">#${escapeHtml(order.id.slice(-6))}</span>` : '';
  const recallHtml = showRecallForSquare(order) ? recallButtonHtml(order.id) : '';

  return `
    <article class="history-order-card">
      <div class="history-order-top">
        <div class="history-order-meta">
          <div class="history-order-name">${escapeHtml(customerName)} ${orderId}</div>
          <div class="history-order-sub">${formatWhen(order.created_at)} · ${escapeHtml(sourceLbl)}</div>
        </div>
        <div class="history-order-right">
          <div class="history-order-badges">
            ${recallHtml}
            <span class="badge ${badgeClass}">${escapeHtml(stateLabel)}</span>
          </div>
          ${total != null ? `<span class="history-order-total">${formatMoney(total)}</span>` : ''}
        </div>
      </div>
      <ul class="history-order-lines">${lines || '<li class="history-line-item history-line-empty">No line items</li>'}</ul>
    </article>
  `;
}

async function fetchSquareOrders(period, cursor) {
  const from = periodToSquareFrom(period);
  const params = new URLSearchParams({ from, limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/square/orders?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function setLoading() {
  listEl.innerHTML = `<div class="history-loading" role="status" aria-live="polite">
    <span class="history-loading-spinner" aria-hidden="true"></span>
    <span class="history-loading-text">Loading orders…</span>
  </div>`;
}

function setError(msg) {
  listEl.innerHTML = `<div class="history-error">${escapeHtml(msg)}</div>`;
}

function renderMergedRows(rows, nextCursor) {
  if (!rows.length) {
    const baseEmpty = !cachedBaseMergedRows.length;
    listEl.innerHTML = baseEmpty
      ? '<div class="history-empty">No orders in this time range.<br>' +
        '<span class="history-empty-hint">Try a wider time range, or check back after new orders complete.</span></div>'
      : '<div class="history-empty">No orders match this filter or search.<br>' +
        '<span class="history-empty-hint">Try All, clear the search, or widen the time range.</span></div>';
    return;
  }

  const html = rows
    .map((r) => (r.kind === 'square' ? renderSquareOrder(r.order) : renderDbOrder(r.order)))
    .join('');

  const loadMore = nextCursor
    ? `<div class="history-load-more-wrap">
        <button type="button" id="history-load-more" class="history-load-more-btn">Load more</button>
       </div>`
    : '';

  const count = `<div class="history-result-count">${rows.length} order${rows.length !== 1 ? 's' : ''}${nextCursor ? '+' : ''}</div>`;

  listEl.innerHTML = count + html + loadMore;

  document.getElementById('history-load-more')?.addEventListener('click', loadMoreSquare);
}

function applyFiltersAndRender() {
  const filtered = filterMergedRows(cachedBaseMergedRows);
  renderMergedRows(filtered, squareCursor);
}

// ---------------------------------------------------------------------------
// Load & render
// ---------------------------------------------------------------------------

async function loadAndRender() {
  squareCursor = null;
  squareAccumulated = [];
  cachedDbOrders = [];
  cachedBaseMergedRows = [];
  setLoading();
  try {
    const [dbSettled, sqSettled] = await Promise.allSettled([
      fetchDbHistory(currentPeriod),
      fetchSquareOrders(currentPeriod, null),
    ]);

    if (dbSettled.status === 'fulfilled') {
      cachedDbOrders = dbSettled.value.orders || [];
    } else {
      cachedDbOrders = [];
      console.warn('Recent orders: DB fetch failed', dbSettled.reason);
    }

    if (sqSettled.status === 'fulfilled') {
      squareAccumulated = sqSettled.value.orders || [];
      squareCursor = sqSettled.value.cursor || null;
    } else {
      squareAccumulated = [];
      squareCursor = null;
      console.warn('Recent orders: Square fetch failed', sqSettled.reason);
    }

    if (dbSettled.status === 'rejected' && sqSettled.status === 'rejected') {
      const e1 = dbSettled.reason?.message || String(dbSettled.reason);
      const e2 = sqSettled.reason?.message || String(sqSettled.reason);
      setError(e1 || e2 || 'Could not load orders');
      return;
    }

    cachedBaseMergedRows = buildMergedRows(cachedDbOrders, squareAccumulated);
    applyFiltersAndRender();
  } catch (e) {
    setError(e.message || 'Could not load orders');
  }
}

async function loadMoreSquare() {
  const btn = document.getElementById('history-load-more');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
  }
  try {
    const data = await fetchSquareOrders(currentPeriod, squareCursor);
    squareAccumulated = squareAccumulated.concat(data.orders || []);
    squareCursor = data.cursor || null;
    cachedBaseMergedRows = buildMergedRows(cachedDbOrders, squareAccumulated);
    applyFiltersAndRender();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Load more';
    }
    const errEl = document.createElement('div');
    errEl.className = 'history-error';
    errEl.textContent = e.message || 'Could not load more';
    listEl.appendChild(errEl);
  }
}

// ---------------------------------------------------------------------------
// Modal open/close
// ---------------------------------------------------------------------------

function syncToolbarControls() {
  if (periodSelect) periodSelect.value = currentPeriod;
}

function openModal() {
  overlay.classList.add('visible');
  syncToolbarControls();
  loadAndRender();
}

function closeModal() {
  overlay.classList.remove('visible');
}

openBtn?.addEventListener('click', openModal);
closeBtn?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !overlay?.classList.contains('visible')) return;
  closeModal();
});

// ---------------------------------------------------------------------------
// Toolbar: service filter, search, period
// ---------------------------------------------------------------------------

serviceSelect?.addEventListener('change', () => {
  applyFiltersAndRender();
});

function scheduleSearchApply() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    applyFiltersAndRender();
  }, 200);
}

searchInput?.addEventListener('input', scheduleSearchApply);
searchInput?.addEventListener('change', scheduleSearchApply);

periodSelect?.addEventListener('change', () => {
  const p = periodSelect.value;
  if (!p) return;
  currentPeriod = p;
  loadAndRender();
});

syncToolbarControls();

listEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-recall-square-id]');
  if (!btn || !listEl.contains(btn)) return;
  e.preventDefault();
  const id = btn.getAttribute('data-recall-square-id');
  if (!id) return;
  recallOrderToBoard(id, btn);
});

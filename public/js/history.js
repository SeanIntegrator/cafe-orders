/**
 * KDS — recent orders from GET /api/kds/orders (tablet-friendly, no expand/collapse).
 */

const overlay = document.getElementById('history-modal-overlay');
const closeBtn = document.getElementById('history-modal-close');
const openBtn = document.getElementById('history-recall-btn');
const listEl = document.getElementById('history-modal-list');
const periodButtons = document.querySelectorAll('[data-history-period]');

let currentPeriod = 'today';

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

/** Barista-facing labels (not raw order_source enums). */
function orderChannelLabel(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'web_app') return 'App order';
  if (s === 'whatsapp') return 'App order';
  return 'Walk in';
}

function statusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'confirmed') return 'Confirmed';
  if (s === 'ready') return 'Ready';
  if (s === 'completed') return 'Collected';
  if (s === 'cancelled') return 'Cancelled';
  if (s === 'pending') return 'Pending';
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
}

function modifierLabel(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (m.kind === 'item_emoji') return '';
  return m.name || m.id || '';
}

function renderModifiers(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  const parts = mods.map(modifierLabel).filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

function lineItemRow(it) {
  const emoji = it.item_emoji ? `<span class="history-line-emoji" aria-hidden="true">${escapeHtml(it.item_emoji)}</span>` : '';
  const mods = renderModifiers(it.modifiers);
  const modHtml = mods ? `<span class="history-line-mods">${escapeHtml(mods)}</span>` : '';
  return `<li class="history-line-item">
    ${emoji}
    <span class="history-line-main"><span class="history-line-qty">${it.quantity}×</span> ${escapeHtml(it.item_name || 'Item')}</span>
    ${modHtml ? `<span class="history-line-mods-wrap">${modHtml}</span>` : ''}
  </li>`;
}

function renderOrder(order) {
  const items = order.items || [];
  const lines = items.map(lineItemRow).join('');
  const notes = order.notes
    ? `<div class="history-notes"><span class="history-notes-label">Note</span> ${escapeHtml(order.notes)}</div>`
    : '';

  const channel = orderChannelLabel(order.order_source);
  const stLabel = statusLabel(order.status);

  return `
    <article class="history-order-card">
      <div class="history-order-top">
        <div class="history-order-meta">
          <div class="history-order-name">${escapeHtml(order.customer_name || 'Customer')}</div>
          <div class="history-order-sub">${formatWhen(order.created_at)} · ${escapeHtml(channel)}</div>
        </div>
        <div class="history-order-right">
          <span class="badge ${statusBadgeClass(order.status)}">${escapeHtml(stLabel)}</span>
          <span class="history-order-total">${formatMoney(order.total_amount)}</span>
        </div>
      </div>
      <ul class="history-order-lines">${lines || '<li class="history-line-item history-line-empty">No items listed</li>'}</ul>
      ${notes}
    </article>
  `;
}

function statusBadgeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'ready') return 'takeaway';
  if (s === 'completed') return 'eat-in';
  if (s === 'confirmed') return 'paid';
  return 'unpaid';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchHistory(period) {
  const res = await fetch(`/api/kds/orders?period=${encodeURIComponent(period)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function setLoading() {
  listEl.innerHTML = '<div class="history-loading">Loading…</div>';
}

function setError(msg) {
  listEl.innerHTML = `<div class="history-error">${escapeHtml(msg)}</div>`;
}

function renderList(orders) {
  if (!orders.length) {
    listEl.innerHTML =
      '<div class="history-empty">No orders in this time range yet.<br><span class="history-empty-hint">Orders from the customer app appear here after checkout.</span></div>';
    return;
  }
  listEl.innerHTML = orders.map(renderOrder).join('');
}

async function loadAndRender() {
  setLoading();
  try {
    const data = await fetchHistory(currentPeriod);
    renderList(data.orders || []);
  } catch (e) {
    setError(e.message || 'Could not load orders');
  }
}

function openModal() {
  overlay.classList.remove('hidden');
  loadAndRender();
}

function closeModal() {
  overlay.classList.add('hidden');
}

openBtn?.addEventListener('click', openModal);
closeBtn?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

periodButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = btn.getAttribute('data-history-period');
    if (!p) return;
    currentPeriod = p;
    periodButtons.forEach((b) => b.classList.toggle('active', b === btn));
    loadAndRender();
  });
});

periodButtons.forEach((btn) => {
  if (btn.getAttribute('data-history-period') === 'today') btn.classList.add('active');
});

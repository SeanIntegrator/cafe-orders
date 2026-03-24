/**
 * KDS recall modal — lists persisted orders from GET /api/kds/orders.
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
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function modifierLabel(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  return m.name || m.id || '';
}

function renderModifiers(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  const parts = mods.map(modifierLabel).filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

function renderOrder(order) {
  const expanded = false;
  const items = order.items || [];
  const lines = items
    .map((it) => {
      const mods = renderModifiers(it.modifiers);
      const modHtml = mods
        ? `<div class="history-modifiers">${mods}</div>`
        : '';
      return `<li><strong>${it.quantity}×</strong> ${escapeHtml(it.item_name || 'Item')}${modHtml}</li>`;
    })
    .join('');

  const notes = order.notes ? `<div class="history-notes">${escapeHtml(order.notes)}</div>` : '';

  return `
    <div class="history-order" data-order-id="${order.id}">
      <button type="button" class="history-order-summary" aria-expanded="${expanded}">
        <div class="history-order-meta">
          <div class="history-order-name">${escapeHtml(order.customer_name || 'Customer')}</div>
          <div class="history-order-sub">${formatWhen(order.created_at)} · ${escapeHtml(order.order_source || '')}</div>
        </div>
        <div class="history-order-right">
          <span class="badge ${statusBadgeClass(order.status)}">${escapeHtml(order.status || '')}</span>
          <span class="history-order-total">${formatMoney(order.total_amount)}</span>
        </div>
      </button>
      <div class="history-order-details">
        <div>DB #${order.id}${order.square_order_id ? ` · Square ${escapeHtml(String(order.square_order_id).slice(0, 12))}…` : ''}</div>
        <ul>${lines || '<li>No line items</li>'}</ul>
        ${notes}
      </div>
    </div>
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
      '<div class="history-empty">No saved orders in this window yet.<br><span style="font-size:0.8rem;opacity:0.85">Orders appear here after checkout from the customer app or KDS test order (Postgres).</span></div>';
    return;
  }
  listEl.innerHTML = orders.map(renderOrder).join('');
  listEl.querySelectorAll('.history-order-summary').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.history-order');
      const open = card.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
}

async function loadAndRender() {
  setLoading();
  try {
    const data = await fetchHistory(currentPeriod);
    renderList(data.orders || []);
  } catch (e) {
    setError(e.message || 'Could not load history');
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

// Default active tab
periodButtons.forEach((btn) => {
  if (btn.getAttribute('data-history-period') === 'today') btn.classList.add('active');
});

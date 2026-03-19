/** Order creation modal — UI logic and event listeners. */

import { catalogItems, setCatalogItems, currentOrder, setCurrentOrder } from './state.js';
import { getInitial } from './helpers.js';
import { createOrder } from './api.js';
import { showToast } from './ui.js';

const overlay = document.getElementById('order-modal-overlay');
const itemsContainer = document.getElementById('order-modal-items');
const currentList = document.getElementById('order-modal-current-list');
const createBtn = document.getElementById('order-modal-create-btn');
const openBtn = document.getElementById('create-test-order-btn');

function renderItems() {
  itemsContainer.innerHTML = catalogItems.map((item) => `
    <button type="button" class="order-modal-item-btn" data-id="${item.id}" data-name="${item.name.replace(/"/g, '&quot;')}">
      <span class="item-initial">${getInitial(item.name)}</span>
      <span>${item.name}</span>
    </button>
  `).join('');
}

function renderSidebar() {
  if (currentOrder.length === 0) {
    currentList.innerHTML = '<div class="order-modal-empty">Add items from the left</div>';
    createBtn.disabled = true;
    createBtn.textContent = 'Create order';
    return;
  }
  const byId = {};
  currentOrder.forEach(({ id, name }) => {
    byId[id] = byId[id] || { id, name, qty: 0 };
    byId[id].qty += 1;
  });
  currentList.innerHTML = Object.values(byId).map((e) => `
    <div class="order-modal-current-item" data-id="${e.id}">
      <span class="item-name">${e.name}${e.qty > 1 ? ' ×' + e.qty : ''}</span>
      <button type="button" class="item-remove" data-id="${e.id}" aria-label="Remove">×</button>
    </div>
  `).join('');
  createBtn.disabled = false;
  createBtn.textContent = `Create order (${currentOrder.length} item${currentOrder.length !== 1 ? 's' : ''})`;
}

openBtn.addEventListener('click', async () => {
  openBtn.disabled = true;
  setCurrentOrder([]);
  overlay.classList.remove('hidden');
  renderSidebar();
  try {
    const res = await fetch('/api/catalog-items');
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.items?.length) {
      setCatalogItems(data.items);
      renderItems();
    } else {
      setCatalogItems([]);
      itemsContainer.innerHTML = '<div class="order-modal-empty">No items in catalog</div>';
    }
  } catch {
    itemsContainer.innerHTML = '<div class="order-modal-empty">Failed to load items</div>';
  } finally {
    openBtn.disabled = false;
  }
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.add('hidden');
});

document.getElementById('order-modal-close').addEventListener('click', () => {
  overlay.classList.add('hidden');
});

itemsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.order-modal-item-btn');
  if (!btn) return;
  const { id, name } = btn.dataset;
  if (id && name) {
    currentOrder.push({ id, name });
    renderSidebar();
  }
});

currentList.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.item-remove');
  if (!removeBtn) return;
  const idx = currentOrder.findIndex((i) => i.id === removeBtn.dataset.id);
  if (idx !== -1) {
    currentOrder.splice(idx, 1);
    renderSidebar();
  }
});

createBtn.addEventListener('click', async () => {
  if (currentOrder.length === 0) return;
  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';

  const byId = {};
  currentOrder.forEach(({ id }) => { byId[id] = (byId[id] || 0) + 1; });
  const line_items = Object.entries(byId).map(([catalog_object_id, quantity]) => ({
    catalog_object_id,
    quantity: String(quantity),
  }));

  try {
    const data = await createOrder(line_items);
    if (data.ok) {
      overlay.classList.add('hidden');
      showToast('Order created — card will appear in a moment.', 'success');
    } else {
      showToast(data.error || 'Request failed', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  } finally {
    createBtn.disabled = false;
    renderSidebar();
  }
});

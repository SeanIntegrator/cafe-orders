/** Board DOM logic: rendering and managing order cards. */

import { orders, modifierSortOrder } from './state.js';
import {
  isEatInOrder,
  getCustomerName,
  getModifiers,
  getMilkChipClass,
  isDrinkItem,
  getOrderReadyAt,
  getEtaLabelText,
} from './helpers.js';
import { handleDone } from './api.js';

const boardTakeaway = document.getElementById('board-takeaway');
const boardEatIn = document.getElementById('board-eat-in');
const boardRows = document.getElementById('board-rows');
const emptyState = document.getElementById('empty-state');
const orderCount = document.getElementById('order-count');

export function addOrUpdateOrder(order) {
  if (orders[order.id]) return; // already showing
  const isDemo = String(order.id || '').startsWith('demo-');
  if (!isDemo && (order.state === 'COMPLETED' || order.state === 'CANCELED')) return;
  orders[order.id] = { order, createdAt: Date.now() };
  renderCard(order);
  updateCount();
}

export function renderCard(order) {
  emptyState.style.display = 'none';
  boardRows.classList.remove('hidden');

  const card = document.createElement('div');
  card.className = 'card';
  card.id = `card-${order.id}`;

  const isEatIn = isEatInOrder(order);
  const rawNote = order.fulfillments?.[0]?.pickup_details?.note || order.note || '';
  const noteMatch = rawNote.match(/\|\s*Note:\s*(.+)/i);
  const note = noteMatch ? noteMatch[1].trim() : '';
  const customerName = getCustomerName(order);

  const items = order.line_items || [];
  const drinkItems = [];
  const foodItems = [];
  items.forEach((item) => {
    if (isDrinkItem(item)) drinkItems.push(item);
    else foodItems.push(item);
  });

  function renderItem(item) {
    const mods = getModifiers(item, modifierSortOrder);
    const milk = mods.length ? mods[0] : null;
    const extraMods = mods.slice(1);
    if (item.variation_name && item.variation_name !== 'Regular') {
      extraMods.unshift(item.variation_name);
    }
    const milkClass = milk ? getMilkChipClass(milk) : '';
    return `
      <div class="line-item">
        <div class="line-item-main">
          <div class="item-main-left">
            <span class="item-name">${item.name || 'Item'}</span>
            ${milk ? `<span class="milk-chip ${milkClass}">${milk}</span>` : ''}
          </div>
          <span class="item-qty">×${item.quantity || 1}</span>
        </div>
        ${extraMods.length ? `<div class="item-mods">${extraMods.map((m) => `<span class="mod">${m}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  const drinksHtml = drinkItems.map(renderItem).join('');
  const foodsHtml = foodItems.map(renderItem).join('');
  const itemsHtml = [
    drinksHtml,
    drinksHtml && foodsHtml ? '<div class="card-items-spacer"></div><div class="card-divider"></div>' : '',
    foodsHtml,
  ].join('');

  const hasEta = !isEatIn && getOrderReadyAt(order) != null;
  const etaLabel = getEtaLabelText(order);

  card.innerHTML = `
    <div class="card-top ${isEatIn ? 'card-top--eat-in' : 'card-top--takeaway'}">
      <div class="card-badges">
        <span class="order-name">${customerName}</span>
        <span class="service-label" id="eta-label-${order.id}" data-has-eta="${hasEta ? '1' : ''}">${etaLabel}</span>
      </div>
      <div class="card-note">${note}</div>
    </div>
    <div class="card-items">
      ${itemsHtml || '<div style="color:#555;font-size:0.8rem">No items</div>'}
    </div>
    <div class="card-footer">
      <button class="dismiss-btn" id="dismiss-${order.id}">
        <span>Done</span>
        <span class="dismiss-timer" id="timer-${order.id}">Just now</span>
      </button>
    </div>
  `;

  card.querySelector(`#dismiss-${order.id}`).addEventListener('click', () => handleDone(order.id));

  const targetBoard = isEatIn ? boardEatIn : boardTakeaway;
  targetBoard.insertBefore(card, targetBoard.firstChild);
}

export function dismissOrder(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  card.classList.add('removing');
  setTimeout(() => {
    card.remove();
    delete orders[id];
    updateCount();
    if (Object.keys(orders).length === 0) {
      emptyState.style.display = 'flex';
      boardRows.classList.add('hidden');
    }
  }, 300);
}

export function updateCount() {
  const n = Object.keys(orders).length;
  orderCount.textContent = `${n} active`;
}

export function updateTimers() {
  const now = Date.now();
  for (const [id, data] of Object.entries(orders)) {
    const el = document.getElementById(`timer-${id}`);
    if (!el) continue;
    const btn = el.closest('.dismiss-btn');
    const diffMs = now - data.createdAt;
    const totalSecs = Math.floor(diffMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    let label;
    if (mins === 0 && secs < 10) {
      label = 'Just now';
    } else {
      const mm = String(mins).padStart(2, '0');
      const ss = String(secs).padStart(2, '0');
      label = `${mm}:${ss}`;
    }
    el.textContent = label;

    const etaLabelEl = document.getElementById(`eta-label-${id}`);
    if (etaLabelEl?.dataset.hasEta === '1') {
      etaLabelEl.textContent = getEtaLabelText(data.order);
    }

    // Switch dismiss button to "late" style after 4 minutes
    if (btn) {
      btn.classList.toggle('late', totalSecs >= 4 * 60);
    }
  }
}

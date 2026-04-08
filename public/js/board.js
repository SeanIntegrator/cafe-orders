/** Board DOM logic: rendering and managing order cards (Concept C). */

import { orders, modifierSortOrder, viewMode } from './state.js';
import {
  renderFlowOrder,
  detachFlowDom,
  updateFlowTimers,
  rerenderFlowBoard,
} from './flow-board.js';
import {
  isEatInOrder,
  getCustomerName,
  escapeHtml,
  shouldShowOrderOnKds,
} from './helpers.js';
import { handleDone } from './api.js';
import {
  buildDrinkLineModel,
  buildFoodLineModel,
  partitionLineItems,
  serviceLabelUpper,
} from './kds-order-model.js';
import { sortSquareModifiers, sortRoundModifiers } from './kds-modifier-config.js';

const MULT = '\u00D7';

const MILK_TEXT_BY_KEY = {
  whole: 'Whole milk',
  semi: 'Semi-skimmed milk',
  oat: 'Oat milk',
  almond: 'Almond milk',
  coconut: 'Coconut milk',
  soy: 'Soy milk',
};

function milkTextForCard(milkKey) {
  return MILK_TEXT_BY_KEY[milkKey] || 'Milk';
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

const boardGrid = document.getElementById('board-grid');
const flowGrid = document.getElementById('flow-grid');
const emptyState = document.getElementById('empty-state');
const orderCount = document.getElementById('order-count');

const TIMER_GREEN_MAX = 3 * 60;
const TIMER_AMBER_MAX = 5 * 60;

function resortBoard() {
  if (!boardGrid) return;
  const ids = Object.entries(orders)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
  for (const id of ids) {
    const el = document.getElementById(`card-${id}`);
    if (el) boardGrid.appendChild(el);
  }
}

function detachCardDom(id) {
  document.getElementById(`card-${id}`)?.remove();
}

export function refreshBoardVisibility() {
  const n = Object.keys(orders).length;
  if (!emptyState) return;
  if (n === 0) {
    emptyState.style.display = 'flex';
    boardGrid?.classList.add('hidden');
    flowGrid?.classList.add('hidden');
  } else {
    emptyState.style.display = 'none';
    if (viewMode === 'flow') {
      flowGrid?.classList.remove('hidden');
      boardGrid?.classList.add('hidden');
    } else {
      boardGrid?.classList.remove('hidden');
      flowGrid?.classList.add('hidden');
    }
  }
}

/**
 * Apply stored view mode: body class, clear inactive grid, re-render active grid from `orders`.
 */
export function applyViewMode() {
  document.body.classList.toggle('kds-flow-active', viewMode === 'flow');
  if (viewMode === 'flow') {
    if (boardGrid) boardGrid.innerHTML = '';
    rerenderFlowBoard(handleDone);
  } else {
    if (flowGrid) flowGrid.innerHTML = '';
    rerenderCardBoard();
  }
  refreshBoardVisibility();
}

export function rerenderCardBoard() {
  if (!boardGrid) return;
  boardGrid.innerHTML = '';
  const ids = Object.entries(orders)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
  for (const id of ids) {
    const data = orders[id];
    if (data?.order) renderCard(data.order);
  }
}

function renderDrinkLine(model) {
  const milkClass = model.hasMilk ? `kds-drink-line--milk-${model.milkKey}` : '';
  const beanKind = model.bean.kind.toLowerCase();
  const beanClass = `kds-bean--${beanKind}`;
  const showBeanBadge = beanKind !== 'ho';
  const noBadgeClass = showBeanBadge ? '' : ' kds-drink-line--no-bean-badge';
  const badgeHtml = showBeanBadge
    ? `<span class="kds-drink-line__badge ${beanClass}">${escapeHtml(model.bean.label)}</span>`
    : '';
  const allergy = model.showAllergyBar
    ? `<div class="kds-drink-line__allergy" role="alert">⚠ Allergy: ${model.allergyLabelEscaped}</div>`
    : '';
  const displaySquare = sortSquareModifiers([
    ...(model.milkTempLabel ? [model.milkTempLabel] : []),
    ...model.squareMods,
  ]);
  const displayRound = sortRoundModifiers([...model.roundMods, ...model.syrupMods]);
  const squareRow = displaySquare.length
    ? `<div class="kds-drink-line__chips kds-drink-line__chips--square">${displaySquare
        .map((m) => `<span class="kds-chip kds-chip--square">${escapeHtml(m)}</span>`)
        .join('')}</div>`
    : '';
  const roundRow = displayRound.length
    ? `<div class="kds-drink-line__chips kds-drink-line__chips--round">${displayRound
        .map((m) => `<span class="kds-chip kds-chip--round">${escapeHtml(m)}</span>`)
        .join('')}</div>`
    : '';
  const note = model.note
    ? `<div class="kds-drink-line__note">${escapeHtml(model.note)}</div>`
    : '';
  const milkText = model.hasMilk ? milkTextForCard(model.milkKey) : '';

  return `
    <div class="kds-drink-line ${milkClass}${noBadgeClass}" data-kds-line="drink">
      <div class="kds-drink-line__stack">
        ${squareRow}
        <div class="kds-drink-line__top-row">
          <div class="kds-drink-line__name-block">
            ${badgeHtml}
            <div class="kds-drink-line__name-milk">
              <span class="kds-drink-line__name">${escapeHtml(model.name)}</span>
              ${milkText ? `<span class="kds-drink-line__milk-text">${escapeHtml(milkText)}</span>` : ''}
            </div>
          </div>
          <span class="kds-drink-line__qty">${MULT}${model.qty}</span>
        </div>
        ${roundRow}
        ${note}
        ${allergy}
      </div>
    </div>`;
}

function renderFoodRow(model) {
  return `
    <div class="kds-food-line" data-kds-line="food">
      <span class="kds-food-line__name">${escapeHtml(model.name)}</span>
      <span class="kds-food-line__qty">${MULT}${model.qty}</span>
    </div>`;
}

export function removeCardSilently(id) {
  detachCardDom(id);
  detachFlowDom(id);
  delete orders[id];
  refreshBoardVisibility();
  updateCount();
}

/**
 * @param {object} order
 * @param {{ createdAtMs?: number, resetTimerFromSquare?: boolean }} [options]
 *   - createdAtMs: KDS timer epoch (e.g. recall).
 *   - resetTimerFromSquare: if true and updating an existing card, use Square `created_at` instead of keeping the on-board timer.
 * Session rule: timer stays stable across poller / loadLiveOrders unless recall passes createdAtMs or resetTimerFromSquare.
 */
export function addOrUpdateOrder(order, options = {}) {
  if (!order?.id) return;
  const isDemo = String(order.id || '').startsWith('demo-');
  if (!isDemo && !shouldShowOrderOnKds(order)) return;
  const prev = orders[order.id];
  detachCardDom(order.id);
  detachFlowDom(order.id);

  let createdAt = Date.now();
  const overrideMs = options.createdAtMs;
  if (typeof overrideMs === 'number' && !Number.isNaN(overrideMs)) {
    createdAt = overrideMs;
  } else if (prev && !options.resetTimerFromSquare) {
    createdAt = prev.createdAt;
  } else if (order.created_at) {
    const t = new Date(order.created_at).getTime();
    if (!Number.isNaN(t)) createdAt = t;
  }
  orders[order.id] = { order, createdAt };
  if (viewMode === 'flow') {
    renderFlowOrder(order, handleDone);
  } else {
    renderCard(order);
  }
  updateCount();
  refreshBoardVisibility();
}

export function renderCard(order) {
  emptyState.style.display = 'none';
  boardGrid.classList.remove('hidden');

  const card = document.createElement('article');
  card.className = 'kds-card';
  card.id = `card-${order.id}`;
  card.setAttribute('role', 'listitem');

  const isEatIn = isEatInOrder(order);
  const customerName = getCustomerName(order);
  const webAllergens = Array.isArray(order.web_app_allergens) ? order.web_app_allergens : [];
  const hasAllergens = webAllergens.length > 0;
  const allergyLabelEscaped = webAllergens.map((a) => escapeHtml(String(a))).join(', ');

  const { drinkItems, foodItems } = partitionLineItems(order);

  const drinksHtml = drinkItems
    .map((item) =>
      renderDrinkLine(
        buildDrinkLineModel(item, modifierSortOrder, order, hasAllergens, allergyLabelEscaped)
      )
    )
    .join('');

  const noDrinksLabel =
    drinkItems.length === 0 && foodItems.length > 0
      ? '<div class="kds-card__no-drinks">NO DRINKS</div>'
      : '';

  const foodSection =
    foodItems.length > 0
      ? `<div class="kds-card__food-wrap">
          ${drinkItems.length > 0 ? '<div class="kds-card__food-rule"></div>' : ''}
          <div class="kds-card__food">${foodItems.map((it) => renderFoodRow(buildFoodLineModel(it))).join('')}</div>
        </div>`
      : '';

  const drinksBlock =
    drinkItems.length > 0
      ? `<div class="kds-card__drinks">${drinksHtml}</div>`
      : '';

  card.innerHTML = `
    <div class="kds-card__header">
      <span class="kds-card__service">${serviceLabelUpper(order, isEatIn)}</span>
      <span class="kds-timer kds-timer--green" id="timer-${order.id}" aria-live="polite">0:00</span>
    </div>
    <div class="kds-card__body">
      ${drinksBlock}
      ${noDrinksLabel}
      ${foodSection}
      ${
        !drinksBlock && !foodSection
          ? '<div class="kds-card__empty-items">No items</div>'
          : ''
      }
    </div>
    <div class="kds-card__footer">
      <button type="button" class="kds-callout-btn" id="dismiss-${order.id}" aria-label="Mark ${escapeAttr(customerName)} done">
        <span class="kds-callout-btn__left">DONE</span>
        <span class="kds-callout-btn__name">${escapeHtml(customerName)}</span>
      </button>
    </div>
  `;

  if (hasAllergens) card.classList.add('kds-card--allergy');

  const btn = card.querySelector(`#dismiss-${order.id}`);
  btn.addEventListener('click', () => handleDone(order.id));
  btn.addEventListener('pointerdown', () => {
    btn.classList.add('kds-callout-btn--revealed');
  });

  boardGrid.appendChild(card);
  resortBoard();
}

export function dismissOrder(id) {
  const card = document.getElementById(`card-${id}`);
  const flow = document.getElementById(`flow-order-${id}`);
  const el = card || flow;
  if (!el) {
    delete orders[id];
    updateCount();
    refreshBoardVisibility();
    return;
  }
  el.classList.add('removing');
  setTimeout(() => {
    el.remove();
    delete orders[id];
    updateCount();
    refreshBoardVisibility();
  }, 300);
}

export function updateCount() {
  const n = Object.keys(orders).length;
  orderCount.textContent = `${n} active`;
}

function formatElapsed(totalSecs) {
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function updateTimers() {
  const now = Date.now();
  for (const [id, data] of Object.entries(orders)) {
    const el = document.getElementById(`timer-${id}`);
    if (!el) continue;
    const diffMs = now - data.createdAt;
    const totalSecs = Math.floor(diffMs / 1000);

    el.textContent = formatElapsed(totalSecs);
    el.classList.remove('kds-timer--green', 'kds-timer--amber', 'kds-timer--red');
    if (totalSecs < TIMER_GREEN_MAX) {
      el.classList.add('kds-timer--green');
    } else if (totalSecs < TIMER_AMBER_MAX) {
      el.classList.add('kds-timer--amber');
    } else {
      el.classList.add('kds-timer--red');
    }

  }
  updateFlowTimers();
}

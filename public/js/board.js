/** Board DOM logic: rendering and managing order cards (Concept C). */

import { orders, modifierSortOrder } from './state.js';
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

/** Inline SVG milk cues — reinforces row tint at a glance (right of drink name). */
const MILK_ICON_ARIA = {
  whole: 'Whole milk',
  semi: 'Skim or semi-skimmed milk',
  oat: 'Oat milk',
  almond: 'Almond milk',
  coconut: 'Coconut milk',
  soy: 'Soya milk',
};

function milkIconMarkup(milkKey) {
  const label = MILK_ICON_ARIA[milkKey] || 'Milk';
  const a = escapeAttr(label);
  const svgOpen =
    '<svg class="kds-milk-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">';
  const wrap = (inner) =>
    `<span class="kds-milk-icon-wrap" role="img" aria-label="${a}">${svgOpen}${inner}</svg></span>`;

  switch (milkKey) {
    case 'whole':
      return wrap(
        '<path fill="#1d4ed8" d="M12 5 7 10h10L12 5zM8 10h8v10H8V10z"/>'
      );
    case 'semi':
      return wrap(
        '<path fill="#15803d" d="M12 5 7 10h10L12 5zM8 10h8v10H8V10z"/>'
      );
    case 'oat':
      return wrap(
        '<ellipse cx="12" cy="8" fill="#8b6914" rx="2.2" ry="4.2" transform="rotate(-12 12 8)"/>' +
          '<ellipse cx="9.5" cy="15" fill="#a67c00" rx="2" ry="3.6" transform="rotate(8 9.5 15)"/>' +
          '<ellipse cx="14.5" cy="15" fill="#6b5a2a" rx="2" ry="3.6" transform="rotate(-6 14.5 15)"/>'
      );
    case 'almond':
      return wrap(
        '<path fill="#c9a66b" stroke="#9a7349" stroke-width="0.4" d="M12 5.2c-1.3 2.8-4.2 5.4-4.2 8.9 0 2.3 1.7 4 4.2 4s4.2-1.7 4.2-4c0-3.5-2.9-6.1-4.2-8.9z"/>'
      );
    case 'coconut':
      return wrap(
        '<circle cx="12" cy="12" r="7.2" fill="#5c4a3a"/>' +
          '<circle cx="9.2" cy="10.8" r="1.3" fill="#3d3228" opacity="0.45"/>' +
          '<circle cx="14.1" cy="10.2" r="1.1" fill="#3d3228" opacity="0.4"/>' +
          '<path fill="#3d3228" opacity="0.35" d="M12 15.8c-1.6 0-2.7.9-3 1.7h6c-.3-.8-1.4-1.7-3-1.7z"/>'
      );
    case 'soy':
      return wrap(
        '<ellipse cx="9.8" cy="12" fill="#4d5c24" rx="3.3" ry="5.6" transform="rotate(-30 9.8 12)"/>' +
          '<ellipse cx="14.2" cy="12" fill="#6b7c35" rx="3.3" ry="5.6" transform="rotate(30 14.2 12)"/>'
      );
    default:
      return wrap('<circle cx="12" cy="12" r="6" fill="currentColor" opacity="0.25"/>');
  }
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

const boardGrid = document.getElementById('board-grid');
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

function renderDrinkLine(model) {
  const milkClass = `kds-drink-line--milk-${model.milkKey}`;
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
  const milkIcon = milkIconMarkup(model.milkKey);

  return `
    <div class="kds-drink-line ${milkClass}${noBadgeClass}" data-kds-line="drink">
      <div class="kds-drink-line__stack">
        ${squareRow}
        <div class="kds-drink-line__top-row">
          <div class="kds-drink-line__name-block">
            ${badgeHtml}
            <div class="kds-drink-line__name-milk">
              <span class="kds-drink-line__name">${escapeHtml(model.name)}</span>
              ${milkIcon}
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
  const card = document.getElementById(`card-${id}`);
  if (card) card.remove();
  delete orders[id];
  if (Object.keys(orders).length === 0) {
    emptyState.style.display = 'flex';
    boardGrid.classList.add('hidden');
  }
  updateCount();
}

export function addOrUpdateOrder(order) {
  if (!order?.id) return;
  const isDemo = String(order.id || '').startsWith('demo-');
  if (!isDemo && !shouldShowOrderOnKds(order)) return;
  if (orders[order.id]) {
    removeCardSilently(order.id);
  }
  let createdAt = Date.now();
  if (order.created_at) {
    const t = new Date(order.created_at).getTime();
    if (!Number.isNaN(t)) createdAt = t;
  }
  orders[order.id] = { order, createdAt };
  renderCard(order);
  updateCount();
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
      <button type="button" class="kds-callout-btn" id="dismiss-${order.id}" aria-label="Call out ${escapeAttr(customerName)} and mark done">
        <span class="kds-callout-btn__left">CALL OUT</span>
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
  if (!card) return;
  card.classList.add('removing');
  setTimeout(() => {
    card.remove();
    delete orders[id];
    updateCount();
    if (Object.keys(orders).length === 0) {
      emptyState.style.display = 'flex';
      boardGrid.classList.add('hidden');
    }
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

    const btn = document.querySelector(`#card-${id} .kds-callout-btn`);
    if (btn) {
      btn.classList.toggle('kds-callout-btn--urgent', totalSecs >= TIMER_AMBER_MAX);
    }
  }
}

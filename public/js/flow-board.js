/** Flow view: full-width dark cards, 3-column drink/food rows. */

import { orders, modifierSortOrder, serviceModifierOptionIds } from './state.js';
import { isEatInOrder, escapeHtml, shouldShowOrderOnKds, getServiceLabel } from './helpers.js';
import {
  buildFlowDrinkModel,
  buildFlowFoodModel,
  partitionLineItems,
} from './kds-order-model.js';

const DEFAULT_SHOTS = 2;

/**
 * @param {{ texture?: string, milk?: string, temp?: string }} segments
 */
function flowMilkChipInnerHtml(segments) {
  const texture = segments?.texture?.trim() || '';
  const milk = segments?.milk?.trim() || '';
  const temp = segments?.temp?.trim() || '';
  const parts = [];
  if (texture) parts.push(`<span class="flow-milk-chip__texture">${escapeHtml(texture)}</span>`);
  if (texture && milk) parts.push('<span class="flow-milk-chip__sep"> | </span>');
  if (milk) parts.push(`<span class="flow-milk-chip__milk">${escapeHtml(milk)}</span>`);
  if (temp && (texture || milk)) parts.push('<span class="flow-milk-chip__sep"> | </span>');
  if (temp) parts.push(`<span class="flow-milk-chip__temp">${escapeHtml(temp)}</span>`);
  return parts.join('');
}

const flowGrid = document.getElementById('flow-grid');
const emptyState = document.getElementById('empty-state');
const boardGrid = document.getElementById('board-grid');

function beanBadgeHtml(bean, totalBeans) {
  const kind = bean.kind.toLowerCase();
  const showNum = totalBeans > 1 || bean.shots !== DEFAULT_SHOTS;
  const stateClass = bean.isGhost ? 'flow-bean--ghost' : 'flow-bean--elevated';
  if (!showNum) {
    return `<span class="flow-bean flow-bean--${kind} ${stateClass}" aria-hidden="true">${escapeHtml(
      bean.label
    )}</span>`;
  }
  return `<span class="flow-bean flow-bean--${kind} ${stateClass} flow-bean--split" aria-hidden="true"><span class="flow-bean__left">${escapeHtml(bean.label)}</span><span class="flow-bean__right">${escapeHtml(String(bean.shots))}</span></span>`;
}

function renderFlowDrinkRow(model) {
  const beansInner =
    model.beans.length > 0
      ? `<div class="flow-row__beans">${model.beans
          .map((b) => beanBadgeHtml(b, model.beans.length))
          .join('')}</div>`
      : '';
  const badgeSlotHtml = `<div class="flow-row__badge-slot">${beansInner}</div>`;

  const sizeHtml = model.sizeChip
    ? `<div class="flow-row__size">${escapeHtml(model.sizeChip)}</div>`
    : '';

  const w = model.milkChipWidthPx ?? 50;
  const milkClass = `flow-milk-chip flow-milk-chip--${model.milkKey || 'whole'} flow-milk-chip--w${w}`;
  const milkHtml =
    model.showMilkChip && model.milkChipLabel
      ? `<span class="${milkClass}">${flowMilkChipInnerHtml(model.milkChipSegments)}</span>`
      : `<span class="flow-milk-chip flow-milk-chip--w50 flow-milk-chip--placeholder" aria-hidden="true"></span>`;

  const syrupHtml = model.syrupChips
    .map((chip) => {
      const display = typeof chip === 'string' ? chip : chip.display;
      const variant = typeof chip === 'string' ? null : chip.variant;
      if (!display) return '';
      const mod = variant ? ` flow-chip-pill--syrup-${variant}` : '';
      return `<span class="flow-chip-pill${mod}">${escapeHtml(display)}</span>`;
    })
    .filter(Boolean)
    .join('');

  const toppingHtml = model.toppingChips
    .map((m) => `<span class="flow-chip-pill">${escapeHtml(m)}</span>`)
    .join('');

  const extraSq = model.extraSquareChips
    .map((m) => `<span class="flow-chip-square">${escapeHtml(m)}</span>`)
    .join('');

  const extraRd = model.extraRoundChips
    .map((m) => `<span class="flow-chip-pill">${escapeHtml(m)}</span>`)
    .join('');

  const prepInner =
    milkHtml +
    extraSq +
    syrupHtml +
    toppingHtml +
    extraRd;

  const prepHtml = prepInner
    ? `<div class="flow-row__prep">${prepInner}</div>`
    : '<div class="flow-row__prep"></div>';

  const noteHtml = model.note
    ? `<div class="flow-row__note">${escapeHtml(model.note)}</div>`
    : '';

  const allergyHtml = model.showAllergyBar
    ? `<div class="flow-row__allergy" role="alert">⚠ ${model.allergyLabelEscaped}</div>`
    : '';

  return `
    <div class="flow-row" data-kds-line="drink">
      <div class="flow-row__base">
        <span class="flow-row__qty" aria-label="Quantity ${model.qty}">${escapeHtml(String(model.qty))}</span>
        ${badgeSlotHtml}
        <div class="flow-row__title">
          <div class="flow-row__title-stack">
            <span class="flow-row__name">${escapeHtml(model.name)}</span>
            ${sizeHtml}
          </div>
        </div>
      </div>
      ${prepHtml}
      <div class="flow-row__detail">
        ${noteHtml}
        ${allergyHtml}
      </div>
    </div>`;
}

function renderFlowFoodRow(model) {
  const prepHtml = model.prepText
    ? `<div class="flow-row__prep-text">${escapeHtml(model.prepText)}</div>`
    : '';

  return `
    <div class="flow-row" data-kds-line="food">
      <div class="flow-row__base">
        <span class="flow-row__qty" aria-label="Quantity ${model.qty}">${escapeHtml(String(model.qty))}</span>
        <div class="flow-row__badge-slot" aria-hidden="true"></div>
        <div class="flow-row__title">
          <div class="flow-row__title-stack">
            <span class="flow-row__name">${escapeHtml(model.name)}</span>
          </div>
        </div>
      </div>
      <div class="flow-row__prep">${prepHtml}</div>
      <div class="flow-row__detail"></div>
    </div>`;
}

function resortFlowBoard() {
  if (!flowGrid) return;
  const ids = Object.entries(orders)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
  for (const id of ids) {
    const el = document.getElementById(`flow-order-${id}`);
    if (el) flowGrid.appendChild(el);
  }
}

/**
 * Remove flow order DOM only (does not mutate `orders`).
 */
export function detachFlowDom(id) {
  document.getElementById(`flow-order-${id}`)?.remove();
}

/**
 * @param {object} order
 * @param {(id: string) => void} onComplete - e.g. handleDone from api.js (injected to avoid circular imports)
 */
export function renderFlowOrder(order, onComplete) {
  if (!flowGrid || !emptyState) return;
  const done = typeof onComplete === 'function' ? onComplete : () => {};

  emptyState.style.display = 'none';
  flowGrid.classList.remove('hidden');
  if (boardGrid) boardGrid.classList.add('hidden');

  const article = document.createElement('article');
  article.className = 'flow-order';
  article.id = `flow-order-${order.id}`;
  article.setAttribute('role', 'listitem');

  const isEatIn = isEatInOrder(order);
  const service = getServiceLabel(order, isEatIn, serviceModifierOptionIds);

  const webAllergens = Array.isArray(order.web_app_allergens) ? order.web_app_allergens : [];
  const hasAllergens = webAllergens.length > 0;
  const allergyLabelEscaped = webAllergens.map((a) => escapeHtml(String(a))).join(', ');

  const { drinkItems, foodItems } = partitionLineItems(order);

  const drinksHtml = drinkItems
    .map((item) =>
      renderFlowDrinkRow(
        buildFlowDrinkModel(item, modifierSortOrder, order, hasAllergens, allergyLabelEscaped)
      )
    )
    .join('');

  const noDrinksLabel =
    drinkItems.length === 0 && foodItems.length > 0
      ? '<div class="flow-order__no-drinks">NO DRINKS</div>'
      : '';

  const foodRows =
    foodItems.length > 0
      ? foodItems.map((it) => renderFlowFoodRow(buildFlowFoodModel(it, modifierSortOrder))).join('')
      : '';

  const headerInner = `
    <div class="flow-order__header-left">
      <span class="flow-order__service">${escapeHtml(service)}</span>
    </div>
    <div class="flow-order__header-right">
      <span class="flow-timer flow-timer--green" id="flow-timer-${order.id}" aria-live="polite">0:00</span>
    </div>`;

  article.innerHTML = `
    <div class="flow-order__header" role="button" tabindex="0" aria-label="Call out order and mark done">
      ${headerInner}
    </div>
    <div class="flow-order__body">
      ${drinksHtml}
      ${noDrinksLabel}
      ${foodRows}
      ${
        drinkItems.length === 0 && foodItems.length === 0
          ? '<div class="flow-order__empty-items">No items</div>'
          : ''
      }
    </div>
  `;

  if (hasAllergens) article.classList.add('flow-order--allergy');

  const header = article.querySelector('.flow-order__header');
  const dismiss = () => done(order.id);
  header?.addEventListener('click', dismiss);
  header?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dismiss();
    }
  });

  flowGrid.appendChild(article);
  resortFlowBoard();
}

/**
 * @param {(id: string) => void} onComplete
 */
export function rerenderFlowBoard(onComplete) {
  if (!flowGrid) return;
  flowGrid.innerHTML = '';
  const ids = Object.entries(orders)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
  if (ids.length === 0) {
    flowGrid.classList.add('hidden');
    return;
  }
  for (const id of ids) {
    const data = orders[id];
    if (data?.order) renderFlowOrder(data.order, onComplete);
  }
}

const TIMER_GREEN_MAX = 3 * 60;
const TIMER_AMBER_MAX = 5 * 60;

function formatElapsed(totalSecs) {
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function updateFlowTimers() {
  const now = Date.now();
  for (const [id, data] of Object.entries(orders)) {
    const el = document.getElementById(`flow-timer-${id}`);
    if (!el) continue;
    const diffMs = now - data.createdAt;
    const totalSecs = Math.floor(diffMs / 1000);

    el.textContent = formatElapsed(totalSecs);
    el.classList.remove('flow-timer--green', 'flow-timer--amber', 'flow-timer--red');
    if (totalSecs < TIMER_GREEN_MAX) {
      el.classList.add('flow-timer--green');
    } else if (totalSecs < TIMER_AMBER_MAX) {
      el.classList.add('flow-timer--amber');
    } else {
      el.classList.add('flow-timer--red');
    }
  }
}

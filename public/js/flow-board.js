/** Flow view: full-width dark cards, 3-column drink/food rows. */

import { orders, modifierSortOrder, serviceModifierOptionIds } from './state.js';
import { isEatInOrder, escapeHtml, shouldShowOrderOnKds, getServiceLabel } from './helpers.js';
import {
  buildFlowDrinkModel,
  buildFlowFoodModel,
  partitionLineItems,
  sortDrinkItemsForFlow,
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
  if (temp) parts.push(`<span class="flow-milk-chip__temp">${escapeHtml(temp)}</span>`);
  return parts.join('');
}

const flowGrid = document.getElementById('flow-grid');
const emptyState = document.getElementById('empty-state');
const boardGrid = document.getElementById('board-grid');

const g = typeof window !== 'undefined' ? window.gsap : null;
const FlipPlugin = typeof window !== 'undefined' ? window.Flip : null;
if (g && FlipPlugin) {
  g.registerPlugin(FlipPlugin);
}

/** Fallback when GSAP is unavailable (same thresholds as legacy swipe). */
const FLOW_SWIPE_MIN_DX = 72;
const FLOW_SWIPE_MAX_VERT = 90;
const THROW_VEL_PX_PER_MS = 0.4;
const THROW_DIST_FRAC = 0.35;

/**
 * Swipe-dismiss synthesizes a click on the touched line; stop it from reaching the delegated
 * line-toggle handler on `#board-container` (see app.js).
 */
function suppressNextClickBubblingFromArticle(article) {
  const fn = (ev) => {
    ev.stopPropagation();
    article.removeEventListener('click', fn, true);
  };
  article.addEventListener('click', fn, true);
  setTimeout(() => article.removeEventListener('click', fn, true), 400);
}

function applyDismissFromFlow(id) {
  import('./board.js')
    .then((m) => m.applyOrderDismissState(id))
    .catch(() => {
      delete orders[id];
    });
}

/** GSAP transform target: inner wrapper keeps `.flow-order` rounded + overflow clipping. */
function getFlowSlideEl(article) {
  return article.querySelector('.flow-order__slide') || article;
}

function remainingFlowOrderArticles(exclude) {
  return [...(flowGrid?.querySelectorAll('.flow-order') || [])].filter((node) => node !== exclude);
}

/**
 * Animate a flow card off-screen (header tap, socket close), then FLIP remaining cards.
 * @param {string} id - Square order id
 */
export function animateOutFlowOrder(id) {
  const el = document.getElementById(`flow-order-${id}`);
  if (!el || !flowGrid) {
    applyDismissFromFlow(id);
    return;
  }
  if (!g || !FlipPlugin) {
    el.remove();
    applyDismissFromFlow(id);
    return;
  }

  const slide = getFlowSlideEl(el);
  slide.style.animation = 'none';
  const others = remainingFlowOrderArticles(el);
  const state = others.length ? FlipPlugin.getState(others) : null;
  const rect = el.getBoundingClientRect();
  const deltaX = window.innerWidth - rect.left + 48;
  const curX = parseFloat(g.getProperty(slide, 'x', 'px')) || 0;

  g.to(slide, {
    x: curX + deltaX,
    opacity: 0,
    duration: 0.22,
    ease: 'power2.in',
    onComplete: () => {
      el.remove();
      if (state) {
        FlipPlugin.from(state, {
          duration: 0.35,
          ease: 'power2.out',
          absolute: true,
        });
      }
      applyDismissFromFlow(id);
    },
  });
}

function completeSwipeDismiss(article, orderId, onDismiss) {
  if (!flowGrid) {
    article.remove();
    onDismiss(orderId);
    return;
  }
  if (!FlipPlugin) {
    article.remove();
    onDismiss(orderId);
    return;
  }
  const others = remainingFlowOrderArticles(article);
  const state = others.length ? FlipPlugin.getState(others) : null;
  article.remove();
  if (state) {
    FlipPlugin.from(state, {
      duration: 0.35,
      ease: 'power2.out',
      absolute: true,
    });
  }
  onDismiss(orderId);
}

const FLOW_FADE_DISMISS_MS = 0.38;

/**
 * Double-click dismiss: fade the card out while siblings reflow immediately (absolute lift + FLIP).
 * @param {HTMLElement} article
 * @param {string} orderId
 * @param {(id: string) => void} onDismiss
 */
function beginFlowOrderFadeDismiss(article, orderId, onDismiss) {
  if (!flowGrid || article.dataset.flowDismissing === '1') return;
  article.dataset.flowDismissing = '1';

  if (!g || !FlipPlugin) {
    article.remove();
    onDismiss(orderId);
    return;
  }

  const slide = getFlowSlideEl(article);
  slide.style.animation = 'none';
  g.killTweensOf(slide);
  g.set(slide, { x: 0, opacity: 1, zIndex: 3 });

  const others = remainingFlowOrderArticles(article);
  const flipState = others.length ? FlipPlugin.getState(others) : null;

  const gridRect = flowGrid.getBoundingClientRect();
  const artRect = article.getBoundingClientRect();
  article.style.position = 'absolute';
  article.style.left = `${artRect.left - gridRect.left + flowGrid.scrollLeft}px`;
  article.style.top = `${artRect.top - gridRect.top + flowGrid.scrollTop}px`;
  article.style.width = `${artRect.width}px`;
  article.style.boxSizing = 'border-box';
  article.style.zIndex = '5';
  article.style.pointerEvents = 'none';

  if (flipState) {
    FlipPlugin.from(flipState, {
      duration: 0.35,
      ease: 'power2.out',
      absolute: true,
    });
  }

  g.set(slide, { filter: 'brightness(1)', boxShadow: 'none' });
  g.to(slide, {
    opacity: 0,
    x: '+=36',
    y: '-=28',
    filter: 'brightness(1.1) saturate(1.2) hue-rotate(36deg)',
    boxShadow: '0 14px 40px rgba(70, 190, 120, 0.42), inset 0 0 48px rgba(95, 210, 145, 0.14)',
    duration: FLOW_FADE_DISMISS_MS,
    ease: 'power2.in',
    onComplete: () => {
      g.set(slide, { clearProps: 'zIndex,opacity,x,y,filter,boxShadow' });
      article.remove();
      onDismiss(orderId);
    },
  });
}

/** Touch / pen: double-tap does not fire `dblclick`; use two `touchend` within this window (~294ms, −30% vs 420ms). */
const FLOW_DOUBLE_TAP_MS = 294;

/**
 * Mouse: `dblclick` / second `click` (detail >= 2). Touch: two `touchend` on the card within FLOW_DOUBLE_TAP_MS.
 * @param {HTMLElement} article
 * @param {string} orderId
 * @param {(id: string) => void} onDismiss
 */
function attachFlowOrderDoubleDismiss(article, orderId, onDismiss) {
  const run = (e) => {
    e.preventDefault();
    e.stopPropagation();
    suppressNextClickBubblingFromArticle(article);
    beginFlowOrderFadeDismiss(article, orderId, onDismiss);
  };

  article.addEventListener('dblclick', (e) => run(e), true);

  article.addEventListener(
    'click',
    (e) => {
      if (e.detail >= 2) run(e);
    },
    true
  );

  let tapCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let tapResetTimer = null;

  article.addEventListener(
    'touchend',
    (e) => {
      if (e.changedTouches.length !== 1) return;
      tapCount += 1;
      if (tapResetTimer) clearTimeout(tapResetTimer);
      if (tapCount >= 2) {
        tapCount = 0;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        suppressNextClickBubblingFromArticle(article);
        beginFlowOrderFadeDismiss(article, orderId, onDismiss);
        return;
      }
      tapResetTimer = setTimeout(() => {
        tapCount = 0;
        tapResetTimer = null;
      }, FLOW_DOUBLE_TAP_MS);
    },
    { capture: true, passive: false }
  );
}

/**
 * @param {HTMLElement} article - `.flow-order`
 * @param {string} orderId
 * @param {(id: string) => void} onDismiss
 */
function attachFlowOrderSwipeDismiss(article, orderId, onDismiss) {
  let startX = 0;
  let startY = 0;
  let activePointer = null;
  let lastX = 0;
  let lastT = 0;
  /** @type {number} */
  let velX = 0;

  article.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      activePointer = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastT = e.timeStamp;
      velX = 0;
      try {
        article.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      const slide = getFlowSlideEl(article);
      if (g) {
        slide.style.animation = 'none';
        g.set(slide, { zIndex: 2 });
      }
    },
    true
  );

  article.addEventListener(
    'pointermove',
    (e) => {
      if (activePointer !== e.pointerId) return;
      const slide = getFlowSlideEl(article);
      const dt = Math.max(1, e.timeStamp - lastT);
      velX = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;

      const dx = Math.max(0, e.clientX - startX);
      const dy = e.clientY - startY;
      if (Math.abs(dy) > FLOW_SWIPE_MAX_VERT && Math.abs(dy) > dx) {
        return;
      }
      if (g) {
        g.set(slide, { x: dx });
      } else {
        slide.style.transform = `translateX(${dx}px)`;
      }
    },
    true
  );

  article.addEventListener(
    'pointerup',
    (e) => {
      if (activePointer !== e.pointerId) return;
      activePointer = null;
      try {
        article.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }

      const slide = getFlowSlideEl(article);
      const dx = Math.max(0, e.clientX - startX);
      const dy = e.clientY - startY;
      const cardW = article.offsetWidth || 320;

      const fallbackDismiss =
        dx >= FLOW_SWIPE_MIN_DX &&
        Math.abs(dy) <= FLOW_SWIPE_MAX_VERT &&
        dx >= Math.abs(dy);

      if (!g) {
        if (fallbackDismiss) {
          suppressNextClickBubblingFromArticle(article);
          onDismiss(orderId);
        } else {
          slide.style.transform = '';
        }
        return;
      }

      const throwByVel = velX > THROW_VEL_PX_PER_MS;
      const throwByDist = dx > THROW_DIST_FRAC * cardW;
      const mostlyHorizontal = Math.abs(dy) <= FLOW_SWIPE_MAX_VERT || dx > Math.abs(dy);
      const shouldThrow = mostlyHorizontal && (throwByVel || throwByDist) && dx > 8;

      if (!shouldThrow) {
        g.to(slide, {
          x: 0,
          opacity: 1,
          duration: 0.4,
          ease: 'back.out(1.7)',
          onComplete: () => {
            g.set(slide, { clearProps: 'zIndex' });
          },
        });
        return;
      }

      suppressNextClickBubblingFromArticle(article);
      const rect = article.getBoundingClientRect();
      const deltaX = window.innerWidth - rect.left + 48;
      const curX = parseFloat(g.getProperty(slide, 'x', 'px')) || 0;

      g.to(slide, {
        x: curX + deltaX,
        opacity: 0,
        duration: 0.35,
        ease: 'power2.out',
        onComplete: () => {
          g.set(slide, { clearProps: 'zIndex' });
          completeSwipeDismiss(article, orderId, onDismiss);
        },
      });
    },
    true
  );

  article.addEventListener(
    'pointercancel',
    (e) => {
      if (activePointer === e.pointerId) {
        activePointer = null;
        const slide = getFlowSlideEl(article);
        if (g) {
          g.to(slide, {
            x: 0,
            duration: 0.25,
            ease: 'power2.out',
            onComplete: () => g.set(slide, { clearProps: 'zIndex' }),
          });
        }
      }
    },
    true
  );
}

function beanBadgeHtml(bean, totalBeans) {
  if (bean.isGhost) return '';
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
    ? `<div class="flow-row__allergy" role="alert"><span class="flow-row__allergy-icon" aria-hidden="true">⚠</span><span class="flow-row__allergy-text">${model.allergyLabelEscaped}</span></div>`
    : '';

  const lineAllergyHtml = model.lineAllergyNoteEscaped
    ? `<div class="flow-row__allergy flow-row__allergy--line" role="alert"><span class="flow-row__allergy-icon" aria-hidden="true">⚠</span><span class="flow-row__allergy-text">${model.lineAllergyNoteEscaped}</span></div>`
    : '';

  return `
    <div class="flow-row" data-kds-line="drink">
      <div class="flow-row__base">
        <span class="flow-row__qty${model.qty > 1 ? ' flow-row__qty--multi' : ''}" aria-label="Quantity ${model.qty}">${escapeHtml(String(model.qty))}</span>
        <div class="flow-row__title">
          <div class="flow-row__title-stack">
            <span class="flow-row__name">${escapeHtml(model.name)}</span>
            ${sizeHtml}
          </div>
        </div>
        ${badgeSlotHtml}
      </div>
      ${prepHtml}
      <div class="flow-row__detail">
        ${noteHtml}
        ${allergyHtml}
        ${lineAllergyHtml}
      </div>
    </div>`;
}

/** Absolutely positioned so it does not change .flow-row height; dashes start after qty strip. */
function renderFlowFoodLine() {
  return `<div class="flow-row__food-line" role="presentation" aria-hidden="true">
      <span class="flow-row__food-line__rule flow-row__food-line__rule--start"></span>
      <span class="flow-row__food-line__label">FOOD</span>
      <span class="flow-row__food-line__rule flow-row__food-line__rule--end"></span>
    </div>`;
}

/**
 * @param {object} model
 * @param {boolean} [isFirstFood]
 */
function renderFlowFoodRow(model, isFirstFood) {
  const prepHtml = model.prepText
    ? `<div class="flow-row__prep-text">${escapeHtml(model.prepText)}</div>`
    : '';

  const lineAllergyHtml = model.lineAllergyNoteEscaped
    ? `<div class="flow-row__allergy flow-row__allergy--line" role="alert"><span class="flow-row__allergy-icon" aria-hidden="true">⚠</span><span class="flow-row__allergy-text">${model.lineAllergyNoteEscaped}</span></div>`
    : '';

  const rowClass = `flow-row${isFirstFood ? ' flow-row--food-first' : ''}`;

  const foodLineHtml = isFirstFood ? renderFlowFoodLine() : '';

  return `
    <div class="${rowClass}" data-kds-line="food">
      ${foodLineHtml}
      <div class="flow-row__base">
        <span class="flow-row__qty${model.qty > 1 ? ' flow-row__qty--multi' : ''}" aria-label="Quantity ${model.qty}">${escapeHtml(String(model.qty))}</span>
        <div class="flow-row__title">
          <div class="flow-row__title-stack">
            <span class="flow-row__name">${escapeHtml(model.name)}</span>
          </div>
        </div>
        <div class="flow-row__badge-slot" aria-hidden="true"></div>
      </div>
      <div class="flow-row__prep">${prepHtml}</div>
      <div class="flow-row__detail">${lineAllergyHtml}</div>
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
  article.title = 'Swipe right, or double-tap / double-click to dismiss';

  const isEatIn = isEatInOrder(order);
  const service = getServiceLabel(order, isEatIn, serviceModifierOptionIds);

  const webAllergens = Array.isArray(order.web_app_allergens) ? order.web_app_allergens : [];
  const hasAllergens = webAllergens.length > 0;
  const allergyLabelEscaped = webAllergens.map((a) => escapeHtml(String(a))).join(', ');

  const { drinkItems, foodItems } = partitionLineItems(order);
  const drinkItemsFlow = sortDrinkItemsForFlow(drinkItems, modifierSortOrder, order);

  const drinksHtml = drinkItemsFlow
    .map((item) =>
      renderFlowDrinkRow(
        buildFlowDrinkModel(item, modifierSortOrder, order, hasAllergens, allergyLabelEscaped)
      )
    )
    .join('');

  const noDrinksLabel =
    drinkItems.length === 0 && foodItems.length > 0
      ? '<div class="flow-order__no-drinks">No drinks</div>'
      : '';

  const foodRows =
    foodItems.length > 0
      ? foodItems
          .map((it, index) =>
            renderFlowFoodRow(buildFlowFoodModel(it, modifierSortOrder), index === 0)
          )
          .join('')
      : '';

  const headerInner = `
    <div class="flow-order__header-left">
      <span class="flow-order__service">${escapeHtml(service)}</span>
    </div>
    <div class="flow-order__header-right">
      <span class="flow-timer flow-timer--green" id="flow-timer-${order.id}" aria-live="polite">0:00</span>
    </div>`;

  const headerClass = `flow-order__header${service === 'SIT IN' ? ' flow-order__header--sitin' : ''}`;

  article.innerHTML = `
    <div class="flow-order__slide">
      <div class="${headerClass}" role="region" aria-label="Order type and wait time">
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
    </div>
  `;

  if (hasAllergens) article.classList.add('flow-order--allergy');

  attachFlowOrderSwipeDismiss(article, order.id, done);
  attachFlowOrderDoubleDismiss(article, order.id, done);

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

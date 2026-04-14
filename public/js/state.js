/** Shared mutable state for the orders board. */

// Active orders keyed by order ID: { [id]: { order, createdAt } }
export const orders = {};

// Map: modifier option catalog_object_id -> sort index (0 = first category, e.g. Milk)
export const modifierSortOrder = new Map();

/** Catalog IDs of modifier options that belong to a Square list whose name matches "service" (Flow header). */
export const serviceModifierOptionIds = new Set();

const VIEW_MODE_STORAGE_KEY = 'kds-view-mode';

function readStoredViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (v === 'flow') return 'flow';
    /** Soft launch: Flow-only; migrate stored Cards preference. */
    if (v === 'cards') {
      try {
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'flow');
      } catch (_) {
        /* ignore */
      }
      return 'flow';
    }
  } catch (_) {
    /* ignore */
  }
  return 'flow';
}

/** @type {'cards' | 'flow'} */
export let viewMode = readStoredViewMode();

/**
 * @param {'cards' | 'flow'} mode
 */
export function setViewMode(mode) {
  viewMode = mode === 'flow' ? 'flow' : 'cards';
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  } catch (_) {
    /* ignore */
  }
}


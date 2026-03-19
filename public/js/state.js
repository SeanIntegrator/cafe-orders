/** Shared mutable state for the orders board. */

// Active orders keyed by order ID: { [id]: { order, createdAt } }
export const orders = {};

// Map: modifier option catalog_object_id -> sort index (0 = first category, e.g. Milk)
export const modifierSortOrder = new Map();

// Catalog items loaded from /api/catalog-items for the order modal
export let catalogItems = [];
export function setCatalogItems(items) { catalogItems = items; }

// Line items in the currently-being-built order in the modal
export let currentOrder = [];
export function setCurrentOrder(items) { currentOrder = items; }

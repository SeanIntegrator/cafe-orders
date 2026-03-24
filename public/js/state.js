/** Shared mutable state for the orders board. */

// Active orders keyed by order ID: { [id]: { order, createdAt } }
export const orders = {};

// Map: modifier option catalog_object_id -> sort index (0 = first category, e.g. Milk)
export const modifierSortOrder = new Map();


/**
 * Shared in-memory dedupe for KDS `new-order` socket emissions (webhook + poller).
 * Does not survive process restart.
 *
 * Env:
 * - KDS_NEW_ORDER_DEDUPE_MS — min ms between new-order for same id (default 90000). Set 0 to disable.
 * - KDS_EMITTED_ORDERS_MAX_AGE_MS — drop map entries older than this (default 600000 = 10m).
 */

const DEDUPE_MS = Math.max(
  0,
  Number.parseInt(process.env.KDS_NEW_ORDER_DEDUPE_MS || '90000', 10) || 90000
);

const MAX_MAP_AGE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.KDS_EMITTED_ORDERS_MAX_AGE_MS || '600000', 10) || 600_000
);

/** @type {Map<string, number>} orderId -> last new-order emit (Date.now()) */
const lastEmittedAt = new Map();

function shouldEmitNewOrder(orderId) {
  if (!orderId) return false;
  if (DEDUPE_MS <= 0) return true;
  const prev = lastEmittedAt.get(orderId);
  if (prev == null) return true;
  return Date.now() - prev >= DEDUPE_MS;
}

function recordNewOrderEmit(orderId) {
  if (!orderId) return;
  lastEmittedAt.set(orderId, Date.now());
}

function forget(orderId) {
  if (orderId) lastEmittedAt.delete(orderId);
}

function cleanup() {
  const now = Date.now();
  for (const [id, t] of lastEmittedAt) {
    if (now - t > MAX_MAP_AGE_MS) {
      lastEmittedAt.delete(id);
    }
  }
}

module.exports = {
  shouldEmitNewOrder,
  recordNewOrderEmit,
  forget,
  cleanup,
};

/**
 * Periodic SearchOrders safety net for KDS when webhooks are missed.
 * Uses the same Square window + DB merge as GET /api/orders, then kdsShouldDisplayOrder.
 *
 * Emits `new-order` only for order IDs that were **not** visible on the previous successful
 * poll (diff vs in-memory set). That avoids spamming clients every interval; `emitted-orders`
 * still dedupes races with webhooks on first arrival (KDS_NEW_ORDER_DEDUPE_MS).
 *
 * Env:
 * - KDS_POLL_INTERVAL_MS — default 30000
 */

const square = require('./square');
const { mergeKdsBoardOrdersWithWebAppDb } = require('./kds-merge');
const { kdsShouldDisplayOrder } = require('./kds-visibility');
const emittedOrders = require('./emitted-orders');

const POLL_MS = Math.max(
  5000,
  Number.parseInt(process.env.KDS_POLL_INTERVAL_MS || '30000', 10) || 30000
);

/**
 * @param {import('socket.io').Server} io
 * @returns {() => void} stop polling
 */
function startPolling(io) {
  let stopped = false;
  /** @type {Set<string>} Square order ids visible on last successful poll */
  let previousVisibleIds = new Set();

  async function tick() {
    if (stopped) return;
    try {
      emittedOrders.cleanup();
      const mergedList = await mergeKdsBoardOrdersWithWebAppDb(() => square.searchKdsBoardSquareOrders());
      const visible = mergedList.filter((o) => o?.id && kdsShouldDisplayOrder(o));
      const currentSet = new Set(visible.map((o) => o.id));

      for (const order of visible) {
        const id = order.id;
        if (previousVisibleIds.has(id)) continue;
        if (!emittedOrders.shouldEmitNewOrder(id)) continue;
        io.emit('new-order', order);
        emittedOrders.recordNewOrderEmit(id);
      }
      previousVisibleIds = currentSet;
    } catch (e) {
      console.error('KDS orders poller:', e.message || e);
    }
  }

  const intervalId = setInterval(tick, POLL_MS);
  tick();

  return () => {
    stopped = true;
    clearInterval(intervalId);
  };
}

module.exports = { startPolling };

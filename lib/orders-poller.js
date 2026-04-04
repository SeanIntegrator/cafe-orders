/**
 * Periodic SearchOrders safety net for KDS when webhooks are missed (OPEN + COMPLETED, filtered by kdsShouldDisplayOrder).
 *
 * Env:
 * - KDS_POLL_INTERVAL_MS — default 30000
 * - KDS_POLL_UPDATED_SINCE_MINUTES — lookback for updated_at, default 3
 */

const square = require('./square');
const emittedOrders = require('./emitted-orders');

const POLL_MS = Math.max(
  5000,
  Number.parseInt(process.env.KDS_POLL_INTERVAL_MS || '30000', 10) || 30000
);

const LOOKBACK_MINUTES = Math.max(
  1,
  Number.parseFloat(process.env.KDS_POLL_UPDATED_SINCE_MINUTES || '3', 10) || 3
);

/**
 * @param {import('socket.io').Server} io
 * @returns {() => void} stop polling
 */
function startPolling(io) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      emittedOrders.cleanup();
      const startAt = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString();
      const orders = await square.searchKdsPollOrdersUpdatedSince(startAt);
      for (const order of orders) {
        const id = order.id;
        if (!id || !square.kdsShouldDisplayOrder(order)) continue;
        if (!emittedOrders.shouldEmitNewOrder(id)) continue;
        io.emit('new-order', order);
        emittedOrders.recordNewOrderEmit(id);
      }
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

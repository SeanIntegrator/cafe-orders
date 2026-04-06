/**
 * Periodic SearchOrders safety net for KDS when webhooks are missed.
 * Uses the same Square window + DB merge as GET /api/orders, then kdsShouldDisplayOrder.
 *
 * Env:
 * - KDS_POLL_INTERVAL_MS — default 30000
 */

const square = require('./square');
const { mergeOpenOrdersWithWebAppDb } = require('./kds-merge');
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

  async function tick() {
    if (stopped) return;
    try {
      emittedOrders.cleanup();
      const mergedList = await mergeOpenOrdersWithWebAppDb(() => square.searchKdsBoardSquareOrders());
      for (const order of mergedList) {
        const id = order.id;
        if (!id || !kdsShouldDisplayOrder(order)) continue;
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

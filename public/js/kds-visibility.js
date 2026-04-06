/**
 * Browser copy of lib/kds-visibility.js — keep logic identical.
 */

function isOrderPaid(order) {
  if (!order) return false;
  if (order.state === 'COMPLETED') return true;
  return Array.isArray(order.tenders) && order.tenders.length > 0;
}

/**
 * @param {object} order
 * @returns {boolean}
 */
export function shouldShowOrderOnKds(order) {
  if (!order?.id) return false;
  if (order.state === 'CANCELED') return false;
  if (order.state === 'OPEN') return true;
  if (order.state === 'COMPLETED') {
    if (!isOrderPaid(order)) return false;
    const ff = order.fulfillments;
    if (!Array.isArray(ff) || ff.length === 0) {
      return true;
    }
    return ff.some((f) => {
      const fs = f.state;
      return fs && !['COMPLETED', 'CANCELED'].includes(fs);
    });
  }
  return false;
}

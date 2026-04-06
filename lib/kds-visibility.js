/**
 * Single spec for which Square-shaped orders appear on the KDS.
 *
 * - App / online: fulfillment lifecycle — show COMPLETED only while a fulfillment is still active.
 * - POS: paid orders are often COMPLETED with no fulfillments; those must show until barista dismisses
 *   (DB row inserted as completed on dismiss — see filterOrdersHiddenByDb in kds-merge).
 *
 * Client: keep public/js/kds-visibility.js in sync.
 */

/**
 * @param {object} order - Square order object
 * @returns {boolean}
 */
function isOrderPaid(order) {
  if (!order) return false;
  if (order.state === 'COMPLETED') return true;
  return Array.isArray(order.tenders) && order.tenders.length > 0;
}

/**
 * @param {object} order - Square order object
 * @returns {boolean}
 */
function kdsShouldDisplayOrder(order) {
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

module.exports = {
  isOrderPaid,
  kdsShouldDisplayOrder,
};

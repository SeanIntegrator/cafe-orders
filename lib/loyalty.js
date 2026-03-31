const pool = require('../db');
const { catalogItemIsDrink } = require('./menu-bucket');

function intEnv(name, def) {
  const v = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(v) ? v : def;
}

function boolEnv(name, def) {
  const s = String(process.env[name] ?? '').toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

function loyaltyConfig() {
  return {
    stampThresholdPence: intEnv('STAMP_THRESHOLD_PENCE', 200),
    stampsPerReward: intEnv('STAMPS_PER_REWARD', 9),
    rewardMaxPence: intEnv('REWARD_MAX_PENCE', 700),
    stripeMinAmountPence: intEnv('STRIPE_MIN_AMOUNT_PENCE', 30),
    timezone: String(process.env.LOYALTY_TIMEZONE || 'Europe/London').trim() || 'Europe/London',
    doubleStampWeekday: intEnv('DOUBLE_STAMP_WEEKDAY', 2),
    stampResetOnReward: boolEnv('STAMP_RESET_ON_REWARD', true),
  };
}

/** 0 = Sunday … 6 = Saturday, in configured timezone */
function weekdayInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).formatToParts(date);
  const w = parts.find((p) => p.type === 'weekday')?.value;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const idx = names.indexOf(w);
  return idx >= 0 ? idx : 0;
}

function stampsDeltaForDate(at, cfg) {
  const wd = weekdayInTimezone(at, cfg.timezone);
  return wd === cfg.doubleStampWeekday ? 2 : 1;
}

function orderIsStripePaid(row) {
  if (!row) return false;
  if (row.stripe_session_id) return true;
  const ps = row.payment_sessions;
  if (Array.isArray(ps) && ps.length > 0) return true;
  return false;
}

/**
 * Cheapest qualifying drink line total in pence; discount = min(that, cap).
 * @param {object[]} enriched from enrichLineItemsForCheckout
 * @param {Map<string, object>} variationIdToCatalogItem
 */
function computeFreeDrinkRewardDiscountPence(enriched, variationIdToCatalogItem, rewardMaxPence) {
  let best = null;
  for (const li of enriched) {
    const cat = variationIdToCatalogItem.get(li.catalog_object_id);
    if (!catalogItemIsDrink(cat)) continue;
    const lineTotal = li.unit_price * li.quantity;
    if (best == null || lineTotal < best) best = lineTotal;
  }
  if (best == null) return { discountPence: 0, eligible: false };
  const discountPence = Math.min(best, rewardMaxPence);
  return { discountPence, eligible: true };
}

/**
 * After KDS marks order completed: award stamps if eligible (idempotent per order).
 * @param {import('pg').Pool} [db] defaults to shared pool
 */
async function stampCardForCompletedSquareOrder(squareOrderId, at = new Date(), db = pool) {
  const cfg = loyaltyConfig();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      `SELECT id, user_id, total_amount, stripe_session_id, payment_sessions, cafe_id, order_source, status
       FROM orders WHERE square_order_id = $1
       LIMIT 1
       FOR SHARE`,
      [squareOrderId]
    );
    const order = orderRows[0];
    if (!order || !order.user_id) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'no_user' };
    }
    if (order.status !== 'completed') {
      await client.query('COMMIT');
      return { skipped: true, reason: 'not_completed' };
    }
    if (!orderIsStripePaid(order)) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'not_paid' };
    }
    if (order.order_source !== 'web_app') {
      await client.query('COMMIT');
      return { skipped: true, reason: 'not_web_app' };
    }

    const total = Number(order.total_amount) || 0;
    if (total < cfg.stampThresholdPence) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'below_threshold' };
    }

    const { rows: dup } = await client.query(
      `SELECT 1 FROM loyalty_transactions
       WHERE order_id = $1 AND transaction_type = 'stamp_earned' LIMIT 1`,
      [order.id]
    );
    if (dup.length > 0) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'already_stamped' };
    }

    const cafeId = Number(order.cafe_id) || 1;
    const userId = order.user_id;
    const delta = stampsDeltaForDate(at, cfg);

    await client.query(
      `INSERT INTO loyalty_cards (user_id, cafe_id, stamps_count, rewards_available)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (user_id, cafe_id) DO NOTHING`,
      [userId, cafeId]
    );

    const { rows: cardRows } = await client.query(
      `SELECT stamps_count, rewards_available FROM loyalty_cards
       WHERE user_id = $1 AND cafe_id = $2 FOR UPDATE`,
      [userId, cafeId]
    );
    const card = cardRows[0];
    let stamps = Number(card.stamps_count) || 0;
    let rewards = Number(card.rewards_available) || 0;

    stamps += delta;

    await client.query(
      `INSERT INTO loyalty_transactions (user_id, cafe_id, transaction_type, stamps_delta, order_id, metadata)
       VALUES ($1, $2, 'stamp_earned', $3, $4, '{}'::jsonb)`,
      [userId, cafeId, delta, order.id]
    );

    const per = cfg.stampsPerReward;
    while (stamps >= per) {
      stamps -= per;
      rewards += 1;
      await client.query(
        `INSERT INTO loyalty_transactions (user_id, cafe_id, transaction_type, stamps_delta, order_id, metadata)
         VALUES ($1, $2, 'reward_earned', $3, $4, '{}'::jsonb)`,
        [userId, cafeId, -per, order.id]
      );
    }

    if (!cfg.stampResetOnReward) {
      /* keep stamps as accumulated beyond rewards (same remainder as subtract loop) */
    }

    await client.query(
      `UPDATE loyalty_cards SET stamps_count = $2, rewards_available = $3, updated_at = NOW()
       WHERE user_id = $1 AND cafe_id = $4`,
      [userId, stamps, rewards, cafeId]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      stamps_count: stamps,
      rewards_available: rewards,
      stamps_earned: delta,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getLoyaltyCardForUser(userId, cafeId = 1) {
  const { rows } = await pool.query(
    `SELECT stamps_count, rewards_available, updated_at FROM loyalty_cards
     WHERE user_id = $1 AND cafe_id = $2`,
    [userId, cafeId]
  );
  if (rows.length === 0) {
    return { stamps_count: 0, rewards_available: 0, updated_at: null };
  }
  return {
    stamps_count: Number(rows[0].stamps_count) || 0,
    rewards_available: Number(rows[0].rewards_available) || 0,
    updated_at: rows[0].updated_at,
  };
}

async function getLastStampDate(userId, cafeId = 1) {
  const { rows } = await pool.query(
    `SELECT created_at FROM loyalty_transactions
     WHERE user_id = $1 AND cafe_id = $2 AND transaction_type = 'stamp_earned'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, cafeId]
  );
  return rows[0]?.created_at ?? null;
}

/**
 * @param {import('pg').PoolClient} client
 */
async function redeemRewardInClient(client, userId, cafeId, orderId) {
  await client.query(
    `INSERT INTO loyalty_cards (user_id, cafe_id, stamps_count, rewards_available)
     VALUES ($1, $2, 0, 0)
     ON CONFLICT (user_id, cafe_id) DO NOTHING`,
    [userId, cafeId]
  );
  const { rows } = await client.query(
    `SELECT rewards_available FROM loyalty_cards WHERE user_id = $1 AND cafe_id = $2 FOR UPDATE`,
    [userId, cafeId]
  );
  const avail = Number(rows[0]?.rewards_available) || 0;
  if (avail < 1) {
    const err = new Error('No rewards available');
    err.code = 'NO_REWARD';
    throw err;
  }
  await client.query(
    `UPDATE loyalty_cards SET rewards_available = rewards_available - 1, updated_at = NOW()
     WHERE user_id = $1 AND cafe_id = $2`,
    [userId, cafeId]
  );
  await client.query(
    `INSERT INTO loyalty_transactions (user_id, cafe_id, transaction_type, stamps_delta, order_id, metadata)
     VALUES ($1, $2, 'reward_redeemed', 0, $3, '{}'::jsonb)`,
    [userId, cafeId, orderId]
  );
}

async function assertRewardAvailable(userId, cafeId = 1) {
  const card = await getLoyaltyCardForUser(userId, cafeId);
  if (card.rewards_available < 1) {
    const err = new Error('No rewards available');
    err.code = 'NO_REWARD';
    throw err;
  }
}

module.exports = {
  loyaltyConfig,
  stampCardForCompletedSquareOrder,
  getLoyaltyCardForUser,
  getLastStampDate,
  computeFreeDrinkRewardDiscountPence,
  redeemRewardInClient,
  assertRewardAvailable,
  orderIsStripePaid,
  catalogItemIsDrink,
};


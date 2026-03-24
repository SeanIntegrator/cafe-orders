const { Pool } = require('pg');

let pool = null;

function createPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return null;
  }

  // *.railway.internal only resolves inside Railway’s private network, not on your laptop.
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
  if (connectionString.includes('railway.internal') && !onRailway) {
    const err = new Error(
      'DATABASE_URL uses a *.railway.internal host. That only works for apps running on Railway, not from localhost. ' +
        'In Railway: open your Postgres service → Connect → use the public URL (TCP proxy, hostname like …proxy.rlwy.net with a port). ' +
        'Paste that full string as DATABASE_URL in .env for local dev.'
    );
    err.code = 'DATABASE_RAILWAY_INTERNAL_ON_LOCAL';
    throw err;
  }

  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1');
  return new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

function getPool() {
  if (pool) return pool;
  pool = createPool();
  if (!pool) {
    const err = new Error(
      'DATABASE_URL is not set. Add it to cafe-orders/.env — use the Postgres URL from Railway (Database service → Variables → DATABASE_URL), or a local URL like postgresql://user:password@127.0.0.1:5432/mydb'
    );
    err.code = 'NO_DATABASE_URL';
    throw err;
  }
  return pool;
}

/** Same interface as pg.Pool for existing routes (query, connect). */
module.exports = {
  query(...args) {
    return getPool().query(...args);
  },
  connect(...args) {
    return getPool().connect(...args);
  },
};

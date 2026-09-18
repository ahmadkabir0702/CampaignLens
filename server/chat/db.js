/**
 * Postgres pool for the chat module.
 *
 * If Campaign Lens already exports a pool, delete the body below and
 * re-export yours instead:
 *
 *   module.exports = { getPool: () => require('../../db').pool };
 */

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 8),
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

module.exports = { getPool };

/**
 * Ask Lens - database access.
 *
 * Reuses the app's existing Postgres pool from the root db.js rather than
 * opening a second one. Supabase's transaction pooler multiplexes for us,
 * so a second client-side pool would just waste slots.
 */

const root = require('../../db');

function getPool() {
  return root.pool;
}

module.exports = { getPool, query: root.query };

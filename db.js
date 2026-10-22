// =====================================================================
//  db.js — Postgres connection for Campaign Lens
//
//  Replaces the Google Sheets backend. Uses the Supabase transaction
//  pooler, so keep the pool small: the pooler multiplexes for us and a
//  large client-side pool just wastes slots.
// =====================================================================
const { Pool } = require('pg');

// TLS to Supabase. With DATABASE_CA_CERT set (the PEM text of the Supabase
// project's CA certificate, from Settings > Database > SSL), the server's
// certificate is verified. Without it the connection is still encrypted but
// not verified, which is how it ran before; set the variable to close that.
function dbSsl() {
  const ca = process.env.DATABASE_CA_CERT;
  if (ca && ca.includes('BEGIN CERTIFICATE')) return { ca, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase terminates TLS at the pooler with a cert that Node does not
  // trust by default. Traffic is still encrypted.
  ssl: dbSsl(),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - start;
    if (ms > 2000) console.warn(`[db] slow query ${ms}ms:`, text.slice(0, 80));
    return res;
  } catch (err) {
    console.error('[db] query failed:', err.message, '|', text.slice(0, 120));
    throw err;
  }
}

// ---------------------------------------------------------------------
//  Brand access. Every data query MUST be scoped by this. The service
//  role bypasses RLS, so this is the only thing preventing one client
//  from seeing another's data.
// ---------------------------------------------------------------------
async function brandsForUser(username) {
  const { rows } = await query(
    `select brands, is_internal from v_user_access
      where username = $1 and is_active = true`,
    [username]
  );
  // The media head approves campaign sign-offs for every brand, so he sees
  // every active brand, including ones added after his account was made.
  const u = await query(
    `select role from app_users where username = $1 and is_active = true`, [username]);
  if (u.rows[0] && u.rows[0].role === 'media_head') {
    const b = await query(`select brand_id from brands where is_active = true order by name`);
    return { brands: b.rows.map(r => r.brand_id), isInternal: rows[0] ? rows[0].is_internal : false };
  }
  if (!rows.length) return null;
  return { brands: rows[0].brands || [], isInternal: rows[0].is_internal };
}

// Throws rather than returning empty, so a missing check is a loud
// failure instead of a silent empty dashboard.
function assertBrandAllowed(session, brandId) {
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  if (!session || !session.brands) throw fail(403, 'No brand access on session');
  if (!brandId) throw fail(400, 'brand_id is required');
  if (!session.brands.includes(brandId)) {
    throw fail(403, 'Access denied for this brand.');
  }
  return brandId;
}

module.exports = { pool, query, brandsForUser, assertBrandAllowed, dbSsl };

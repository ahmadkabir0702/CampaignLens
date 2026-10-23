/**
 * Admin: logins, access, usage and health. The admin role only.
 *
 * Everything that used to be SQL run by hand in Supabase: adding a login,
 * giving it brands, choosing its sections, resetting its password,
 * switching it off. Every change is written to app_admin_log.
 *
 *   GET  /api/admin/overview            logins, brands, agencies, flags
 *   POST /api/admin/logins              add a login → { temp_password }
 *   PUT  /api/admin/logins/:username    brands, sections, name, org, role, active
 *   POST /api/admin/logins/:username/reset-password → { temp_password }
 *   GET  /api/admin/usage?days=30       sections and logins, last N days
 *   GET  /api/admin/health              data freshness, nightly job,
 *                                       errors, migrations not recorded
 *   GET  /api/admin/log                 the last 100 admin changes
 *
 * A change to a login takes effect within a minute: the session check in
 * server/security.js re-reads brands, sections and active status.
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../../db');
const { FLAGS } = require('../features');
const ops = require('../ops');
const { sendError } = require('../security');

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

const ORGS = ['unilever', 'mindshare', 'agency', 'other'];
const ROLES = { standard: null, admin: 'admin', media_head: 'media_head', influencer_coordinator: 'influencer_coordinator' };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,59}$/;

// Sections an agency may never have, whatever the form sends (the agreed
// access: Creative Hub and Pre-tests only).
const AGENCY_OFF = ['askLens', 'media', 'creators', 'sov', 'signoff'];

function tempPassword() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let p = '';
  for (const x of crypto.randomBytes(16)) p += c[x % c.length];
  return `${p.slice(0, 4)}-${p.slice(4, 8)}-${p.slice(8, 12)}-${p.slice(12, 16)}`;
}

let logReady = null;
function ensureLog() {
  if (!logReady) {
    logReady = query(`
      create table if not exists app_admin_log (
        id       bigserial primary key,
        at       timestamptz not null default now(),
        actor    text not null,
        action   text not null,
        target   text,
        details  jsonb
      );
      alter table app_admin_log enable row level security;`).catch((e) => { logReady = null; throw e; });
  }
  return logReady;
}

async function audit(req, action, target, details) {
  await ensureLog();
  await query(`insert into app_admin_log (actor, action, target, details) values ($1, $2, $3, $4)`,
    [req.session.user, action, target || null, details ? JSON.stringify(details) : null]);
}

async function columns() {
  const { rows } = await query(
    `select column_name, column_default, is_identity, is_generated
       from information_schema.columns
      where table_schema = current_schema() and table_name = 'app_users'`);
  return rows;
}

async function agencyKeyFor(agencyId) {
  if (!agencyId) return null;
  const { rows } = await query(`select agency_id::text as id from agencies where agency_id::text = $1`, [String(agencyId)]);
  if (!rows.length) throw new HttpError(400, 'That agency was not found.');
  return rows[0].id;
}

async function validBrands(list) {
  const want = [...new Set((Array.isArray(list) ? list : []).map(String))];
  if (!want.length) return [];
  const { rows } = await query(`select brand_id from brands where brand_id = any($1) and is_active`, [want]);
  const ok = new Set(rows.map((r) => r.brand_id));
  const bad = want.filter((b) => !ok.has(b));
  if (bad.length) throw new HttpError(400, `Unknown brand: ${bad.join(', ')}`);
  return want.sort();
}

function flagsFor(org, sections) {
  const out = {};
  for (const k of Object.keys(FLAGS)) out[k] = !!(sections && sections[k]);
  if (org === 'agency') for (const k of AGENCY_OFF) out[k] = false;
  return out;
}

module.exports = function mountAdmin(app) {
  const router = express.Router();
  router.use(express.json());
  router.use((req, res, next) => {
    if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    next();
  });

  router.get('/overview', async (req, res) => {
    try {
      const cols = new Set((await columns()).map((c) => c.column_name));
      const flagCols = Object.entries(FLAGS).filter(([, c]) => cols.has(c));
      const [users, brands, agencies] = await Promise.all([
        query(`select u.username, u.display_name, u.role, u.is_active, u.last_login_at,
                      ${cols.has('org') ? 'u.org' : 'null::text as org'},
                      ${cols.has('agency_key') ? 'u.agency_key' : 'null::text as agency_key'},
                      ${cols.has('must_change_password') ? 'u.must_change_password' : 'false as must_change_password'},
                      ${flagCols.map(([, c]) => `u.${c}`).join(', ') || 'null as none'},
                      coalesce(v.brands, '{}') as brands
                 from app_users u left join v_user_access v using (username)
                order by u.is_active desc, u.org nulls last, u.username`),
        query(`select brand_id, name, is_active from brands order by name`),
        query(`select agency_id::text as id, name from agencies where is_active order by name`),
      ]);
      res.json({
        me: req.session.user,
        orgs: ORGS,
        roles: Object.keys(ROLES),
        sections: Object.keys(FLAGS),
        brands: brands.rows,
        agencies: agencies.rows,
        logins: users.rows.map((u) => ({
          username: u.username, display_name: u.display_name, role: u.role, org: u.org,
          agency_key: u.agency_key, is_active: u.is_active, last_login_at: u.last_login_at,
          must_change_password: u.must_change_password,
          // The media head sees every brand whatever is stored.
          brands: u.role === 'media_head' ? brands.rows.filter((b) => b.is_active).map((b) => b.brand_id) : u.brands,
          sections: Object.fromEntries(Object.entries(FLAGS).map(([k, c]) => [k, u[c] !== false])),
        })),
      });
    } catch (err) { sendError(res, 'admin', err); }
  });

  router.post('/logins', async (req, res) => {
    try {
      const b = req.body || {};
      const username = String(b.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 3 to 60 characters, lower case letters, digits, dots, dashes.');
      const org = ORGS.includes(b.org) ? b.org : null;
      if (!org) throw new HttpError(400, 'Choose Unilever, Mindshare, agency or other.');
      if (!(b.role in ROLES)) throw new HttpError(400, 'Choose a role.');
      const display = String(b.display_name || '').trim().slice(0, 100) || username;
      const agencyKey = org === 'agency' ? await agencyKeyFor(b.agency_id) : null;
      if (org === 'agency' && !agencyKey) throw new HttpError(400, 'Choose the agency.');
      const brands = await validBrands(b.brands);
      if (!brands.length && ROLES[b.role] !== 'media_head') throw new HttpError(400, 'Give the login at least one brand.');

      const exists = await query(`select 1 from app_users where lower(username) = $1`, [username]);
      if (exists.rows.length) throw new HttpError(409, 'That username is taken.');

      // Copy an existing login of the same side for any column this page
      // does not know about, so new columns get a sensible value.
      const prefix = org === 'agency' ? 'agency.%' : org === 'mindshare' ? 'ms.%' : '%';
      const { rows: tmpl } = await query(
        `select username from app_users
          where is_active and username like $1 and coalesce(role, '') not in ('admin', 'media_head', 'influencer_coordinator')
          order by username limit 1`, [prefix]);
      const fallback = tmpl.length ? tmpl : (await query(
        `select username from app_users where is_active and coalesce(role, '') not in ('admin','media_head','influencer_coordinator') order by username limit 1`)).rows;
      if (!fallback.length) throw new HttpError(500, 'No login to copy settings from.');

      const skip = new Set(['username', 'display_name', 'password_hash', 'must_change_password', 'email', 'role', 'org',
        'agency_key', 'agency_id', 'brands', 'last_login_at', 'password_changed_at', 'created_at', 'updated_at', 'is_active',
        ...Object.values(FLAGS)]);
      const copy = (await columns())
        .filter((c) => !skip.has(c.column_name) && !String(c.column_default || '').includes('(')
          && c.is_identity === 'NO' && c.is_generated === 'NEVER')
        .map((c) => `"${c.column_name.replace(/"/g, '')}"`);

      const pw = tempPassword();
      const hash = await bcrypt.hash(pw, 12);
      await query(
        `insert into app_users (username, display_name, password_hash, must_change_password, is_active${copy.length ? ', ' + copy.join(', ') : ''})
         select $1, $2, $3, true, true${copy.length ? ', ' + copy.join(', ') : ''} from app_users where username = $4`,
        [username, display, hash, fallback[0].username]);
      await applyAccess(username, { org, role: ROLES[b.role], agencyKey, brands, sections: flagsFor(org, b.sections) });
      await audit(req, 'add login', username, { org, role: b.role, brands, agency: agencyKey });
      console.log(`[admin] ${req.session.user} added login ${username}`);
      res.json({ username, temp_password: pw });
    } catch (err) { sendError(res, 'admin', err); }
  });

  async function applyAccess(username, { org, role, agencyKey, brands, sections, active, display }) {
    const cols = new Set((await columns()).map((c) => c.column_name));
    const sets = [], params = [username];
    const add = (col, val) => { if (cols.has(col)) { params.push(val); sets.push(`${col} = $${params.length}`); } };
    if (org !== undefined) add('org', org);
    if (role !== undefined) add('role', role);
    if (agencyKey !== undefined) add('agency_key', agencyKey);
    if (active !== undefined) add('is_active', active);
    if (display !== undefined) add('display_name', display);
    if (sections) for (const [k, c] of Object.entries(FLAGS)) add(c, !!sections[k]);
    if (sets.length) await query(`update app_users set ${sets.join(', ')} where username = $1`, params);
    if (brands) await query(`select set_user_brands($1, $2::text[])`, [username, brands]);
  }

  router.put('/logins/:username', async (req, res) => {
    try {
      const username = String(req.params.username);
      const { rows } = await query(`select username, role, org from app_users where username = $1`, [username]);
      if (!rows.length) throw new HttpError(404, 'Login not found.');
      const cur = rows[0];
      const b = req.body || {};
      const self = username === req.session.user;
      const change = {};
      if (b.display_name !== undefined) change.display = String(b.display_name).trim().slice(0, 100) || username;
      if (b.org !== undefined) {
        if (!ORGS.includes(b.org)) throw new HttpError(400, 'Choose Unilever, Mindshare, agency or other.');
        change.org = b.org;
      }
      const org = change.org || cur.org;
      if (b.role !== undefined) {
        if (!(b.role in ROLES)) throw new HttpError(400, 'Choose a role.');
        if (self && ROLES[b.role] !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role.');
        change.role = ROLES[b.role];
      }
      if (b.agency_id !== undefined) change.agencyKey = org === 'agency' ? await agencyKeyFor(b.agency_id) : null;
      if (b.brands !== undefined) change.brands = await validBrands(b.brands);
      if (b.sections !== undefined) change.sections = flagsFor(org, b.sections);
      if (b.is_active !== undefined) {
        if (self && b.is_active === false) throw new HttpError(400, 'You cannot switch off your own login.');
        change.active = b.is_active === true;
      }
      await applyAccess(username, change);
      await audit(req, 'change login', username, b);
      console.log(`[admin] ${req.session.user} changed login ${username}`);
      res.json({ ok: true });
    } catch (err) { sendError(res, 'admin', err); }
  });

  router.post('/logins/:username/reset-password', async (req, res) => {
    try {
      const username = String(req.params.username);
      if (username === req.session.user) throw new HttpError(400, 'Use Change password for your own login.');
      const pw = tempPassword();
      const hash = await bcrypt.hash(pw, 12);
      // A new change time signs out every session on this login within a
      // minute (server/security.js).
      const { rowCount } = await query(
        `update app_users set password_hash = $2, must_change_password = true, password_changed_at = now()
          where username = $1`, [username, hash]);
      if (!rowCount) throw new HttpError(404, 'Login not found.');
      await audit(req, 'reset password', username, null);
      console.log(`[admin] ${req.session.user} reset the password for ${username}`);
      res.json({ username, temp_password: pw });
    } catch (err) { sendError(res, 'admin', err); }
  });

  router.get('/usage', async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
      res.json(await ops.usageSummary(days));
    } catch (err) { sendError(res, 'admin', err); }
  });

  router.get('/health', async (req, res) => {
    try {
      const soft = (p, empty) => p.then((r) => r.rows).catch((e) => {
        if (e.code === '42P01' || e.code === '42703') return empty;
        throw e;
      });
      const [paid, organic, jobs, errors, migrations, bars, runs, sync] = await Promise.all([
        soft(query(`select brand_id, max(date)::text as last_day from creative_metrics_unified group by brand_id`), []),
        soft(query(`select c.brand_id, max(h.captured_at) as last_at
                      from organic_perf_history h join creatives c on c.creative_id = h.creative_id
                     group by c.brand_id`), []),
        soft(query(`select name, last_day, last_ok_at, last_try_at, last_error, last_ms from app_jobs`), []),
        ops.recentErrors(50),
        ops.migrations(),
        soft(query(`select year, set_at, set_by, note from cqr_bar_years order by year desc limit 1`), []),
        // The n8n sync: when each brand last ran, and what it could not read.
        soft(query(`select distinct on (brand_id) brand_id, ran_at, status
                      from sync_runs order by brand_id, ran_at desc`), []),
        // Brand-level refusals only (a token, a permission, a whole API call).
        // Problems with one post are shown to coordinators on that post.
        soft(query(`select brand_id, platform, source, creative_id, error, occurrences, last_seen
                      from sync_errors
                     where resolved_at is null and source in ('step', 'run')
                     order by last_seen desc limit 50`), []),
      ]);
      const { rows: brands } = await query(`select brand_id, name from brands where is_active order by name`);
      const P = new Map(paid.map((r) => [r.brand_id, r.last_day]));
      const O = new Map(organic.map((r) => [r.brand_id, r.last_at]));
      const R = new Map(runs.map((r) => [r.brand_id, r]));
      const names = new Map(brands.map((b) => [b.brand_id, b.name]));
      res.json({
        data: brands.map((b) => ({
          brand_id: b.brand_id, name: b.name, paid_through: P.get(b.brand_id) || null, organic_at: O.get(b.brand_id) || null,
          synced_at: (R.get(b.brand_id) || {}).ran_at || null, sync_status: (R.get(b.brand_id) || {}).status || null,
        })),
        sync_problems: sync.map((e) => ({
          brand: names.get(e.brand_id) || e.brand_id, platform: e.platform,
          // STEP:<brand>:<step> for a step, RUN:<brand> for the whole run.
          step: e.source === 'run' ? 'run' : String(e.creative_id || '').split(':').pop(),
          error: e.error, occurrences: e.occurrences, last_seen: e.last_seen,
        })),
        jobs,
        errors,
        migrations_missing: migrations.filter((m) => !m.applied_at).map((m) => m.name),
        migrations_recorded: migrations.filter((m) => m.applied_at).length,
        bars: bars[0] || null,
      });
    } catch (err) { sendError(res, 'admin', err); }
  });

  router.get('/log', async (req, res) => {
    try {
      await ensureLog();
      const { rows } = await query(`select at, actor, action, target, details from app_admin_log order by at desc limit 100`);
      res.json({ log: rows });
    } catch (err) { sendError(res, 'admin', err); }
  });

  app.use('/api/admin', router);
};

// =====================================================================
//  ops.js — what the admin page needs to see how the app is doing
//
//    logError()        server faults, kept in app_errors so they can be
//                      seen without opening the Render log. Repeats of the
//                      same fault within ten minutes add to a count rather
//                      than a new row.
//    countUse()        which sections people open and how many Ask Lens
//                      questions they ask, per day and login (app_usage).
//                      Counted in memory and written once a minute.
//    migrations()      which numbered SQL files in the repo are recorded
//                      as run in schema_migrations.
//
//  The tables are created on first use, so nothing has to be run by hand;
//  server/037_ops_tables.sql creates the same tables and records the
//  migrations already run.
// =====================================================================
const fs = require('fs');
const path = require('path');

const db = () => require('../db');

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = db().query(`
      create table if not exists app_errors (
        id         bigserial primary key,
        first_at   timestamptz not null default now(),
        last_at    timestamptz not null default now(),
        count      integer not null default 1,
        tag        text not null,
        message    text not null,
        path       text,
        username   text
      );
      create index if not exists app_errors_last on app_errors (last_at desc);
      create table if not exists app_usage (
        day        date not null,
        username   text not null,
        section    text not null,
        count      integer not null default 0,
        primary key (day, username, section)
      );
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      );
      -- Supabase exposes tables in public to its web API unless row level
      -- security is on. These are for the server only.
      alter table app_errors enable row level security;
      alter table app_usage enable row level security;
      alter table schema_migrations enable row level security;`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ---------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------
const REPEAT_MS = 10 * 60 * 1000;
const recent = new Map();   // tag|message -> { id, at }

function logError(tag, err, req) {
  const message = String((err && err.message) || err || 'unknown').slice(0, 1000);
  const key = `${tag}|${message}`;
  const user = req && req.session && req.session.user ? req.session.user : null;
  const p = req && req.path ? String(req.path).slice(0, 200) : null;
  const hit = recent.get(key);
  const now = Date.now();
  const write = async () => {
    await ensureTables();
    if (hit && now - hit.at < REPEAT_MS && hit.id) {
      await db().query(`update app_errors set count = count + 1, last_at = now() where id = $1`, [hit.id]);
      hit.at = now;
      return;
    }
    const { rows } = await db().query(
      `insert into app_errors (tag, message, path, username) values ($1, $2, $3, $4) returning id`,
      [String(tag).slice(0, 100), message, p, user]);
    recent.set(key, { id: rows[0].id, at: now });
    if (recent.size > 500) recent.delete(recent.keys().next().value);
  };
  // Never let recording an error become a second error.
  write().catch((e) => console.warn('[ops] could not record error:', e.message));
}

async function recentErrors(limit = 50) {
  await ensureTables();
  const { rows } = await db().query(
    `select id, first_at, last_at, count, tag, message, path, username
       from app_errors order by last_at desc limit $1`, [limit]);
  return rows;
}

// ---------------------------------------------------------------------
//  Usage
// ---------------------------------------------------------------------
const SECTIONS = new Set(['creatives', 'kpi', 'creators', 'pretests', 'sov', 'signoff', 'repurpose',
  'coordinator', 'admin', 'ask-lens-question']);
const pending = new Map();  // day|user|section -> count

function colomboDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
}

function countUse(username, section) {
  if (!username || !SECTIONS.has(section)) return false;
  const key = `${colomboDay()}|${username}|${section}`;
  pending.set(key, (pending.get(key) || 0) + 1);
  return true;
}

async function flushUsage() {
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    await ensureTables();
    for (const [key, n] of batch) {
      const [day, user, section] = key.split('|');
      await db().query(
        `insert into app_usage (day, username, section, count) values ($1, $2, $3, $4)
         on conflict (day, username, section) do update set count = app_usage.count + excluded.count`,
        [day, user, section, n]);
    }
  } catch (e) {
    // Put the counts back for the next try rather than lose them.
    for (const [key, n] of batch) pending.set(key, (pending.get(key) || 0) + n);
    console.warn('[ops] could not write usage:', e.message);
  }
}
const flusher = setInterval(() => { flushUsage(); }, 60 * 1000);
if (flusher.unref) flusher.unref();

async function usageSummary(days = 30) {
  await flushUsage();
  await ensureTables();
  const [bySection, byUser] = await Promise.all([
    db().query(
      `select section, sum(count)::int as count, count(distinct username)::int as logins
         from app_usage where day > current_date - $1::int group by section order by count desc`, [days]),
    db().query(
      `select u.username, u.display_name, u.org, u.role, u.last_login_at,
              coalesce(sum(a.count) filter (where a.section <> 'ask-lens-question'), 0)::int as views,
              coalesce(sum(a.count) filter (where a.section = 'ask-lens-question'), 0)::int as questions,
              max(a.day) as last_used
         from app_users u
         left join app_usage a on a.username = u.username and a.day > current_date - $1::int
        where u.is_active
        group by u.username, u.display_name, u.org, u.role, u.last_login_at
        order by views desc, u.username`, [days]),
  ]);
  return { days, sections: bySection.rows, logins: byUser.rows };
}

// ---------------------------------------------------------------------
//  Migrations
// ---------------------------------------------------------------------
const MIGRATION_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

function migrationFiles() {
  const dirs = [path.join(__dirname), path.join(__dirname, 'chat')];
  const out = new Set();
  for (const d of dirs) {
    try { for (const f of fs.readdirSync(d)) if (MIGRATION_RE.test(f)) out.add(f); } catch (e) { /* no folder */ }
  }
  return [...out].sort();
}

async function migrations() {
  await ensureTables();
  const { rows } = await db().query(`select name, applied_at from schema_migrations`);
  const done = new Map(rows.map((r) => [r.name, r.applied_at]));
  return migrationFiles().map((name) => ({ name, applied_at: done.get(name) || null }));
}

module.exports = { ensureTables, logError, recentErrors, countUse, flushUsage, usageSummary, migrations, migrationFiles, SECTIONS };

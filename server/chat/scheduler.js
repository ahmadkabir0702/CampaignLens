/**
 * Ask Lens - nightly refresh, built into the server
 *
 * Once a day it rebuilds every brand's data and refreshes the insight cards,
 * so everything stays current for all brands without anyone running a
 * command. Findings only rewrite for brands whose creatives changed, so a
 * quiet night costs almost nothing.
 *
 * If n8n also calls /api/chat/warm after its pipeline, that is fine: both
 * paths are safe to run twice.
 *
 *   ASK_LENS_NIGHTLY_HOUR  hour in Sri Lanka time to run (default 6, after the
 *                          overnight data pull; set it to an hour after n8n finishes)
 *   ASK_LENS_NIGHTLY=0     turn it off
 *
 * It runs once per day at or after that hour, not only during it: if the
 * server was asleep or restarting at 6, it catches up at the next check.
 * A failed run is retried an hour later. The last run is kept in the
 * app_jobs table, so a restart neither repeats a finished day nor forgets
 * a failed one, and the admin page can show it.
 */

const HOUR = Number(process.env.ASK_LENS_NIGHTLY_HOUR || 6);
const CHECK_EVERY_MS = 10 * 60 * 1000;

let timer = null;
let running = false;
let lastRunDay = null;
let retryAt = 0;
let loaded = false;
const RETRY_MS = 60 * 60 * 1000;

function pool() { return require('../../db'); }

async function ensureTable() {
  await pool().query(`create table if not exists app_jobs (
      name        text primary key,
      last_day    text,
      last_ok_at  timestamptz,
      last_try_at timestamptz,
      last_error  text,
      last_ms     integer);
    alter table app_jobs enable row level security;`);
}

async function loadLast() {
  if (loaded) return;
  try {
    await ensureTable();
    const { rows } = await pool().query(`select last_day from app_jobs where name = 'nightly'`);
    lastRunDay = rows[0] ? rows[0].last_day : null;
  } catch (e) { console.warn('[nightly] could not read last run:', e.message); }
  loaded = true;
}

async function record(day, ok, ms, error) {
  try {
    await ensureTable();
    await pool().query(
      `insert into app_jobs (name, last_day, last_ok_at, last_try_at, last_error, last_ms)
       values ('nightly', $1, case when $2 then now() end, now(), $3, $4)
       on conflict (name) do update set
         last_day    = coalesce(excluded.last_day, app_jobs.last_day),
         last_ok_at  = coalesce(excluded.last_ok_at, app_jobs.last_ok_at),
         last_try_at = now(),
         last_error  = excluded.last_error,
         last_ms     = excluded.last_ms`,
      [ok ? day : null, ok, error || null, ms]);
  } catch (e) { console.warn('[nightly] could not record run:', e.message); }
}

function colomboNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function runNow(reason = 'scheduled') {
  if (running) return { skipped: 'already running' };
  running = true;
  const started = Date.now();
  try {
    const { warmAll } = require('./snapshot');
    const { generateAll } = require('./insights');
    const { prewarmAll } = require('./prewarm');
    const { recordChanges } = require('../fatigue');
    const snaps = await warmAll({ quiet: true });
    const cards = await generateAll({ quiet: true });
    await prewarmAll({ quiet: true }); // off unless ASK_LENS_PREWARM=1
    // Before the summary line, so a rating that moved overnight is on
    // record even if nothing else about the creative changed.
    const moved = await recordChanges({ quiet: true });
    const changed = cards.filter((c) => !c.unchanged && !c.error).map((c) => c.brand);
    console.log(`[nightly] ${reason}: ${snaps.length} brands rebuilt, insight cards refreshed for ${changed.length ? changed.join(', ') : 'none (no creative changes)'}`
      + `, ${moved.length} rating change${moved.length === 1 ? '' : 's'} recorded`
      + ` in ${Math.round((Date.now() - started) / 1000)}s`);
    lastRunDay = colomboNow().day;
    await record(colomboNow().day, true, Date.now() - started, null);
    return { snaps, cards };
  } catch (err) {
    console.error('[nightly] failed:', err.message);
    await record(null, false, Date.now() - started, String(err.message).slice(0, 500));
    return { error: err.message };
  } finally {
    running = false;
  }
}

async function tick() {
  await loadLast();
  const now = colomboNow();
  if (running || now.hour < HOUR || lastRunDay === now.day || Date.now() < retryAt) return;
  const reason = now.hour === HOUR ? 'scheduled' : 'catch-up';
  const out = await runNow(reason).catch((e) => ({ error: e.message }));
  if (out && out.error) retryAt = Date.now() + RETRY_MS;
  else if (out && !out.skipped) lastRunDay = now.day;
}

function start() {
  if (process.env.ASK_LENS_NIGHTLY === '0' || timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, CHECK_EVERY_MS);
  if (timer.unref) timer.unref();
  // A check shortly after start, so a missed day is caught up without
  // waiting for the first interval.
  const first = setTimeout(() => { tick().catch(() => {}); }, 60 * 1000);
  if (first.unref) first.unref();
  console.log(`[nightly] scheduled daily at ${String(HOUR).padStart(2, '0')}:00 Sri Lanka time`);
}

module.exports = { start, runNow, colomboNow, _tick: tick };

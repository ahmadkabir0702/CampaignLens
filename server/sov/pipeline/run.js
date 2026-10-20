/**
 * One share of voice run for one category, monthly or weekly:
 *
 *   brand posts → searches → creator countries → label posts →
 *   conversation → label conversation → work out shares and publish → tidy up
 *
 * Runs inside the web service, in the background. n8n starts it through
 * POST /api/sov/runs and polls GET /api/sov/runs/:id until it finishes.
 * Only one run at a time, across all categories, so two runs never share
 * the ScrapeCreators budget.
 *
 * If collection is stopped by the credit cap or the balance floor, nothing
 * is published: the page keeps the previous figures and the next run starts
 * from the last successful one, so nothing is lost.
 *
 * A category with auto_publish off saves its period without showing it, for
 * review. publishPeriod() puts it live.
 *
 * n8n asks every day which categories are due (automatedCategories) and
 * starts those, one at a time.
 */
const { pool: db, query: q } = require('../../../db');
const { notifyAdmin, esc } = require('../../../notify');
const { createClient, BudgetStop } = require('./sc');
const T = require('./text');
const C = require('./collect');
const L = require('./label');
const A = require('./aggregate');

const DAY = 86400000;
const HISTORY_DAYS = 84;     // 12 weeks for the weekly chart
const OVERLAP_DAYS = 10;     // later runs look back past the last run, for late arrivals
let active = null;

async function loadCategory(categoryId) {
  const { rows: [cat] } = await q(`select category_id, name from sov_categories where category_id = $1`, [categoryId]);
  if (!cat) throw new Error(`No share of voice category "${categoryId}"`);
  const { rows: [cfg] } = await q(`select * from sov_category_config where category_id = $1`, [categoryId]);
  if (!cfg) throw new Error(`"${categoryId}" has no row in sov_category_config`);
  const { rows: brands } = await q(
    `select brand_name, brand_id, owner, is_unilever, facebook_url, instagram_handle, tiktok_handle,
            terms, hashtags, searches, is_ambiguous, page_scope
       from sov_category_brands where category_id = $1 order by sort_order, brand_name`, [categoryId]);
  if (!brands.length) throw new Error(`"${categoryId}" has no brands in sov_category_brands`);
  cfg.name = cat.name;
  return { cat, cfg, brands };
}

/**
 * Every automated category and whether it is due today (Sri Lanka time).
 *   monthly  due from run_day onwards, until a run succeeds this month
 *   weekly   due when nothing has succeeded in the last six days
 * A category tried once today, successfully or not, waits for tomorrow, so
 * a run that fails for lack of credits is not retried all day.
 */
async function automatedCategories() {
  const { rows } = await q(
    `select c.category_id, c.name, cfg.window_days, cfg.credit_cap,
            coalesce(cfg.cadence, 'weekly') as cadence, coalesce(cfg.run_day, 1) as run_day,
            coalesce(cfg.auto_publish, true) as auto_publish,
            (select to_char(max(r.finished_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from sov_runs r
              where r.category_id = c.category_id and r.status = 'succeeded') as last_success,
            exists (select 1 from sov_runs r where r.category_id = c.category_id and r.status = 'succeeded'
                       and date_trunc('month', r.started_at at time zone 'Asia/Colombo')
                         = date_trunc('month', now() at time zone 'Asia/Colombo')) as done_this_month,
            exists (select 1 from sov_runs r where r.category_id = c.category_id and r.status = 'succeeded'
                       and r.started_at > now() - interval '6 days') as done_this_week,
            exists (select 1 from sov_runs r where r.category_id = c.category_id
                       and (r.started_at at time zone 'Asia/Colombo')::date = (now() at time zone 'Asia/Colombo')::date) as tried_today,
            extract(day from now() at time zone 'Asia/Colombo')::int as today
       from sov_categories c join sov_category_config cfg using (category_id)
      where cfg.is_automated
      order by cfg.run_day nulls first, c.sort_order, c.category_id`);
  return rows.map(r => {
    const due = !r.tried_today && (r.cadence === 'monthly'
      ? r.today >= Number(r.run_day) && !r.done_this_month
      : !r.done_this_week);
    return { category_id: r.category_id, name: r.name, cadence: r.cadence, run_day: Number(r.run_day),
      auto_publish: r.auto_publish, window_days: r.window_days, credit_cap: r.credit_cap, last_success: r.last_success, due };
  });
}

/** Put a period that was saved for review on the page. */
async function publishPeriod(periodId) {
  const { rows: [p] } = await q(
    `update sov_periods set is_published = true where period_id = $1
     returning period_id, category_id, label`, [periodId]);
  if (!p) { const e = new Error('No such period'); e.status = 404; throw e; }
  return p;
}

/** Runs left 'running' by a restart can never finish: close them. */
async function closeOrphans() {
  await q(`update sov_runs set status = 'failed', finished_at = now(),
                  error = coalesce(error, 'The server restarted during the run')
            where status = 'running'`);
}

async function getRun(runId) {
  const { rows: [r] } = await q(
    `select run_id, category_id, status, phase, started_at, finished_at, credits_start, credits_end, error, stats
       from sov_runs where run_id = $1`, [runId]);
  return r || null;
}

/** Start a run in the background. Returns its id, or throws with .status = 409 if one is going. */
async function startRun(categoryId, opts = {}) {
  if (active) { const e = new Error(`A run is already going (run ${active.runId}, ${active.categoryId})`); e.status = 409; e.runId = active.runId; throw e; }
  const loaded = await loadCategory(categoryId);
  const { rows: [r] } = await q(`insert into sov_runs (category_id, phase) values ($1, 'starting') returning run_id`, [categoryId]);
  const runId = Number(r.run_id);
  loaded.cfg.cadence = loaded.cfg.cadence || 'weekly';
  if (loaded.cfg.auto_publish == null) loaded.cfg.auto_publish = true;
  active = { runId, categoryId };
  execute(runId, loaded, opts)
    .catch(e => console.error('[sov] run crashed:', e))
    .finally(() => { active = null; });
  return runId;
}

async function execute(runId, { cat, cfg, brands }, opts) {
  const stats = { log: [] };
  const log = msg => {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    stats.log.push(line); if (stats.log.length > 120) stats.log.shift();
    console.log(`[sov ${cat.category_id}] ${msg}`);
  };
  let current = 'starting', noted = 0;
  const phase = async p => { current = p; log(`phase: ${p}`); await q(`update sov_runs set phase = $2, stats = $3 where run_id = $1`, [runId, p, JSON.stringify(stats)]); };
  // A note on the current phase, for long waits (batch labelling). At most once a minute.
  const phaseNote = async note => {
    if (Date.now() - noted < 60000) return;
    noted = Date.now();
    await q(`update sov_runs set phase = $2 where run_id = $1`, [runId, `${current}: ${note}`]).catch(() => {});
  };

  const { rows: [last] } = await q(
    `select started_at from sov_runs where category_id = $1 and status = 'succeeded' order by started_at desc limit 1`, [cat.category_id]);
  const first = !last || opts.backfill;
  const now = new Date();
  const floor = new Date(now.getTime() - HISTORY_DAYS * DAY);
  const since = first ? floor : new Date(Math.max(floor.getTime(), new Date(last.started_at).getTime() - OVERLAP_DAYS * DAY));
  const firstCap = Number(process.env.SOV_FIRST_RUN_CAP || 3000);
  const cap = first ? Math.max(cfg.credit_cap, firstCap) : cfg.credit_cap;
  Object.assign(stats, { first, since: since.toISOString().slice(0, 10), cap });

  const P = T.prepare(cfg, brands);
  const ctx = { db, q, cat, cfg, P, since, first, now, log, stats, runId, phaseNote, historyDays: HISTORY_DAYS + 7, periodEnd: opts.periodEnd || null };
  let sc, stopped = null, failed = null, result = null;

  try {
    sc = createClient({ apiKey: process.env.SCRAPECREATORS_API_KEY, cap });
    ctx.sc = sc;
    const start = await sc.balance();
    await q(`update sov_runs set credits_start = $2 where run_id = $1`, [runId, start]);
    log(`${first ? 'first run, collecting 12 weeks' : `collecting from ${stats.since}`}; credit cap ${cap}`);

    try {
      await phase('brand posts'); await C.ownedPosts(ctx);
      await phase('searches'); await C.searches(ctx);
      await phase('creator countries'); await C.creatorCountries(ctx);
    } catch (e) { if (e instanceof BudgetStop) stopped = e.message; else throw e; }

    await phase('labelling posts'); await L.labelPosts(ctx);

    if (!stopped) {
      try { await phase('conversation'); await C.conversation(ctx); }
      catch (e) { if (e instanceof BudgetStop) stopped = e.message; else throw e; }
    }
    await phase('labelling conversation'); await L.labelComments(ctx);

    if (stopped && process.env.SOV_PUBLISH_PARTIAL !== 'true') {
      log(`collection stopped: ${stopped}. Not published; the page keeps the previous figures.`);
      stats.published = false;
    } else {
      await phase('publishing'); result = await A.run(ctx);
    }
    await phase('tidying up'); await A.purge(ctx);
  } catch (e) {
    failed = e;
    log(`failed: ${e.message}`);
  }

  let end = null;
  try { if (sc) end = await sc.balance(); } catch (e) { /* the balance is a nicety */ }
  stats.creditsUsed = sc ? sc.used() : 0;
  const status = failed || stopped ? 'failed' : 'succeeded';
  const error = failed ? failed.message : stopped ? `Stopped: ${stopped}` : null;
  await q(`update sov_runs set status = $2, phase = 'done', finished_at = now(), credits_end = $3, error = $4, stats = $5 where run_id = $1`,
    [runId, status, end, error, JSON.stringify(stats)]).catch(e => console.error('[sov] could not close run:', e.message));

  await report({ cat, runId, status, error, stats, end, result }).catch(e => console.error('[sov] notify failed:', e.message));
}

async function report({ cat, runId, status, error, stats, end, result }) {
  const ok = status === 'succeeded';
  const lines = [];
  if (ok && stats.published) lines.push(`Published: ${stats.period.label}.`);
  else if (ok && stats.awaitingReview) lines.push(`Saved for review, not yet on the page: ${stats.period.label} (period ${stats.periodId}). `
    + `Check it, then publish it with POST /api/sov/periods/${stats.periodId}/publish, or in SQL: update sov_periods set is_published = true where period_id = ${stats.periodId};`);
  else if (ok) lines.push(`Not published: ${stats.notPublishedReason || 'see the run log'}. The page keeps the previous figures.`);
  else lines.push(error);
  lines.push(`Credits used: ${stats.creditsUsed}${end != null ? `, ${end} left on the account` : ''}.`);
  if (result && result.R) {
    const top = [...result.R.brands].sort((a, b) => b.sov - a.sov).slice(0, 5)
      .map(b => `${b.name} ${(100 * b.sov).toFixed(1)}%`).join(', ');
    lines.push(`Share of voice: ${top}.`);
  }
  if (!ok && /cap/.test(error || '')) lines.push('Raise credit_cap in sov_category_config if this keeps happening.');
  if (!ok && /balance|run out/.test(error || '')) lines.push('Top up ScrapeCreators credits, then start the run again.');
  const subject = `${!ok ? 'Share of voice run did not finish' : stats.awaitingReview ? 'Share of voice ready for review' : 'Share of voice updated'}: ${cat.name}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
    <p><b>${esc(subject)}</b> (run ${runId})</p>${lines.map(l => `<p>${esc(l)}</p>`).join('')}
    <pre style="font-size:12px;color:#555">${esc(stats.log.slice(-25).join('\n'))}</pre></div>`;
  await notifyAdmin(subject, html, `${ok ? ':white_check_mark:' : ':warning:'} ${subject}\n${lines.join('\n')}`);
}

module.exports = { startRun, getRun, automatedCategories, publishPeriod, closeOrphans, isRunning: () => (active ? { ...active } : null) };

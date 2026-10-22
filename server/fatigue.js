// =====================================================================
//  fatigue.js — does a creative still perform the way it used to
//
//  The rating every screen shows is a lifetime figure: the whole run,
//  weighted by impressions (migration 023; before that it was the best
//  single day). A lifetime figure still hides decay, because seventy days
//  of history drown last week.
//
//  v_paid_windowed grades slices of time with the same functions, so
//  "Good at launch, Average now" is a real comparison. This module reads
//  that for one creative, and writes a line to cqr_history whenever a
//  rating actually moves, so the slide is visible after the fact and not
//  only while someone happens to be looking.
// =====================================================================
const { query } = require('./../db');

// A window with less delivery than this is noise, not a reading. The
// lifetime floor is 10,000 impressions; a seven-day slice gets a tenth
// of it rather than the same bar, which no short window would clear.
const WINDOW_FLOOR = 1000;

// Below this, "first week" and "last week" are the same days, so there
// are no two windows to compare and the panel says so instead of
// comparing a stretch of time against itself.
const MIN_RUN_DAYS = 14;

const PLATFORM_LABEL = { meta: 'Meta', tiktok: 'TikTok' };
const ORDER = ['first_7', 'prev_7', 'last_7', 'lifetime'];
const WINDOW_LABEL = {
  first_7: 'First week',
  prev_7: 'Week before last',
  last_7: 'Last week',
  lifetime: 'Lifetime',
};
const RANK = { Good: 0, Average: 1, Poor: 2 };
const isGrade = (c) => RANK[c] !== undefined;

/**
 * Write a row for every rating that has changed since the last one.
 *
 * Nothing is written on a quiet night, so the table reads as a history
 * of what happened rather than a log of every time it ran.
 */
async function recordChanges({ quiet = false } = {}) {
  const sql = `
    with now_paid as (
      select w.creative_id, w.brand_id, 'paid'::text as channel, w.platform,
             w.cqr, w.hook_rate, w.hold_rate, w.impressions, w.spend,
             coalesce(m.cqr, t.cqr) as cqr_lifetime
        from v_paid_windowed w
        left join v_paid_meta_creative   m on w.platform = 'meta'
                                          and m.creative_id = w.creative_id
        left join v_paid_tiktok_creative t on w.platform = 'tiktok'
                                          and t.creative_id = w.creative_id
       where w.window_name = 'last_7'
         and w.impressions >= $1
    ),
    now_organic as (
      select s.creative_id, c.brand_id, 'organic'::text as channel, s.platform,
             s.cqr, null::numeric as hook_rate, null::numeric as hold_rate,
             o.views as impressions, null::numeric as spend,
             s.cqr as cqr_lifetime
        from v_organic_scored s
        join creatives c on c.creative_id = s.creative_id
        join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
    ),
    current as (
      select * from now_paid
      union all
      select * from now_organic
    )
    insert into cqr_history
      (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
       hook_rate, hold_rate, impressions, spend, is_first)
    select c.creative_id, c.brand_id, c.channel, c.platform, c.cqr, c.cqr_lifetime,
           c.hook_rate, c.hold_rate, c.impressions, c.spend,
           (l.creative_id is null)
      from current c
      left join v_cqr_latest l
        on l.creative_id = c.creative_id
       and l.channel     = c.channel
       and l.platform    = c.platform
     where l.creative_id is null
        or l.cqr          is distinct from c.cqr
        or l.cqr_lifetime is distinct from c.cqr_lifetime
    returning creative_id, channel, platform, cqr, is_first`;

  try {
    const { rows } = await query(sql, [WINDOW_FLOOR]);
    const started = rows.filter((r) => r.is_first).length;
    if (!quiet) {
      console.log(`[fatigue] ${rows.length} rating change${rows.length === 1 ? '' : 's'} recorded`
        + (started ? ` (${started} first readings)` : ''));
    }
    return rows;
  } catch (err) {
    // The windowed view or the history table may not exist yet. A missed
    // migration should cost this feature, not the nightly run.
    if (err.code === '42P01' || err.code === '42703') {
      if (!quiet) console.warn(`[fatigue] skipped: ${err.message}. Run migrations 010 and 011.`);
      return [];
    }
    throw err;
  }
}

/** Did it hold up, fade, or pick up? Only said when both ends are real. */
function trendOf(first, last, lastImpressions) {
  if (!isGrade(first) || !isGrade(last)) return null;
  if (lastImpressions !== null && lastImpressions < WINDOW_FLOOR) return null;
  const move = RANK[last] - RANK[first];
  if (move > 0) return { direction: 'faded', from: first, to: last };
  if (move < 0) return { direction: 'improved', from: first, to: last };
  return { direction: 'held', from: first, to: last };
}

/**
 * The one fatigue rule. The Creative Hub card, the fatigue panel and Ask
 * Lens all call this, so they cannot disagree about a creative.
 *
 * wins: the creative's rows on one platform from v_paid_windowed, keyed by
 * window_name (first_7, last_7, lifetime). A trend is read only when:
 *   - it has run at least MIN_RUN_DAYS, so first and last week differ
 *   - both weeks had at least WINDOW_FLOOR impressions
 *   - both weeks have a grade
 * faded: graded worse in its last week than its first. still_running says
 * whether that last week is the current one and the creative is live.
 */
function assessFade(wins) {
  const first = wins && wins.first_7, last = wins && wins.last_7, life = wins && wins.lifetime;
  if (!first || !last || !life) return { checked: false, reason: 'no windows' };
  const runDays = Math.round((new Date(life.to_date) - new Date(life.from_date)) / 86400000) + 1;
  const stillRunning = !!(last.is_active && last.is_current);
  const base = { run_days: runDays, still_running: stillRunning };
  if (!(runDays >= MIN_RUN_DAYS)) return { ...base, checked: false, reason: 'too short' };
  const imp = (w) => (w.impressions === null || w.impressions === undefined ? null : Number(w.impressions));
  if (imp(last) === null || imp(last) < WINDOW_FLOOR) return { ...base, checked: false, reason: 'thin last week' };
  if (imp(first) === null || imp(first) < WINDOW_FLOOR) return { ...base, checked: false, reason: 'thin first week' };
  const trend = trendOf(first.cqr, last.cqr, imp(last));
  if (!trend) return { ...base, checked: false, reason: 'ungraded' };
  return { ...base, checked: true, trend, faded: trend.direction === 'faded', from: first.cqr, to: last.cqr,
           spend_last: last.spend === null || last.spend === undefined ? 0 : Number(last.spend) };
}

function trendWords(t, platLabel, stillRunning) {
  if (!t) return null;
  if (t.direction === 'faded') {
    return `On ${platLabel} it has slipped from ${t.from} in its first week to ${t.to} last week.`
      + (stillRunning ? ' It is still running, so this is spend going into a creative that is no longer doing what it did.' : '');
  }
  if (t.direction === 'improved') {
    return `On ${platLabel} it has gone from ${t.from} in its first week to ${t.to} last week, so it is doing better now than it started.`;
  }
  return `On ${platLabel} it is rated ${t.to} now, the same as its first week, so it is holding up.`;
}

/**
 * The window series for one creative, plus a plain verdict per platform
 * and whatever rating changes have been recorded.
 */
async function fatigueFor(brandId, creativeId) {
  let rows;
  try {
    const r = await query(
      `select platform, window_name, from_date, to_date, days, impressions, spend,
              is_active, is_current, hook_rate, hold_rate, hook_q, hold_q, cqr
         from v_paid_windowed
        where brand_id = $1 and creative_id = $2`,
      [brandId, creativeId]);
    rows = r.rows;
  } catch (err) {
    if (err.code === '42P01') return null;   // migration 011 not run
    throw err;
  }
  if (!rows.length) return null;

  const byPlatform = {};
  for (const r of rows) (byPlatform[r.platform] ||= {})[r.window_name] = r;

  const platforms = Object.entries(byPlatform).map(([platform, wins]) => {
    const first = wins.first_7, last = wins.last_7, life = wins.lifetime;
    const label = PLATFORM_LABEL[platform] || platform;

    // How long it actually ran, which decides whether there is a trend
    // to read at all.
    const runDays = life
      ? Math.round((new Date(life.to_date) - new Date(life.from_date)) / 86400000) + 1
      : 0;
    const tooShort = runDays < MIN_RUN_DAYS;

    const a = assessFade(wins);
    const thin = a.reason === 'thin last week' || a.reason === 'thin first week';
    const trend = a.checked ? a.trend : null;
    const stillRunning = !!(last && last.is_active && last.is_current);

    return {
      platform,
      label: PLATFORM_LABEL[platform] || platform,
      still_running: stillRunning,
      // The last week of data it has, which is not the same as the last
      // week of the calendar once a creative has stopped.
      ended: last && !last.is_current ? last.to_date : null,
      thin_recent: thin,
      run_days: runDays,
      too_short: tooShort,
      // While the run is shorter than two weeks every window covers the
      // same days, so three identical rows would just look like a fault.
      windows: (tooShort ? ['lifetime'] : ORDER).filter((w) => wins[w]).map((w) => ({
        key: w,
        label: tooShort ? 'So far' : WINDOW_LABEL[w],
        from: wins[w].from_date,
        to: wins[w].to_date,
        days: Number(wins[w].days),
        impressions: wins[w].impressions === null ? null : Number(wins[w].impressions),
        spend: wins[w].spend === null ? null : Number(wins[w].spend),
        hook_rate: wins[w].hook_rate === null ? null : Math.round(Number(wins[w].hook_rate) * 10) / 10,
        hold_rate: wins[w].hold_rate === null ? null : Math.round(Number(wins[w].hold_rate) * 10) / 10,
        hook_q: wins[w].hook_q,
        hold_q: wins[w].hold_q,
        cqr: wins[w].cqr,
        thin: wins[w].impressions !== null && Number(wins[w].impressions) < WINDOW_FLOOR,
      })),
      trend,
      verdict: tooShort
        ? `Only ${runDays} day${runDays === 1 ? '' : 's'} of delivery on ${label} so far. There is no earlier stretch to compare against yet, so nothing here says whether it is holding up. Come back once it has run a fortnight.`
        : thin
          ? `Too little delivery on ${label} in its ${a.reason === 'thin first week' ? 'first' : 'last'} week to read a trend from.`
          : trendWords(trend, label, stillRunning),
    };
  });

  let history = [];
  try {
    const h = await query(
      // Rows written when the rules or benchmarks changed (migration 023
      // onward) are left out: the rating moved because the rule did, not
      // because the creative did. Read through to_jsonb so this works
      // whether or not the reason column exists yet.
      `select channel, platform, cqr, cqr_lifetime, changed_at, is_first
         from cqr_history h
        where creative_id = $1
          and coalesce(to_jsonb(h) ->> 'reason', '') <> 'rule change'
        order by changed_at`, [creativeId]);
    history = h.rows;
  } catch (err) {
    if (err.code !== '42P01') throw err;     // migration 010 not run
  }

  return {
    creative_id: creativeId,
    platforms,
    history,
    // Said once, because it explains why this panel can disagree with
    // the rating shown everywhere else on the same screen.
    note: 'The CQR elsewhere in Campaign Lens covers the whole run, weighted by impressions, so a recent decline is diluted by earlier weeks. These windows grade each stretch of time on its own, which is why a creative can read Good overall and Average now.',
  };
}

module.exports = { recordChanges, fatigueFor, assessFade, WINDOW_FLOOR, MIN_RUN_DAYS };

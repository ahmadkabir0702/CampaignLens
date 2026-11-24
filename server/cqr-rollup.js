/**
 * CQR Good rate, Hook Good rate and Hold Good rate, rolled up by
 * impressions: per brand, per campaign, and for any date range.
 *
 *   CQR Good rate   impressions on videos rated Good
 *                   / impressions on videos with a CQR grade
 *   Hook Good rate  impressions on videos whose hook is graded Good
 *                   / the same denominator
 *   Hold Good rate  the same, on the hold grade
 *   Rated share     impressions on videos with a CQR grade
 *                   / all paid video impressions
 *
 * Rules, kept from the rest of Campaign Lens:
 *   - Each video keeps the rating it already has, worked out on its whole
 *     paid run (v_paid_meta_creative / v_paid_tiktok_creative). Nothing is
 *     re-rated here and no benchmark is read.
 *   - For a date range only the impressions inside the range are counted,
 *     each still carrying the video's whole-run rating.
 *   - Under 10,000 impressions a video reads Low Delivery and is not rated,
 *     so it sits outside the denominator (it still counts in Rated share's
 *     total).
 *   - Paid video only: photos and carousels are not rated on paid.
 *   - Meta and TikTok are worked out separately. Combined adds the
 *     impressions together; it never averages the two rates.
 *   - Campaign is the Campaign Lens campaign each creative was added under.
 *   - A video on both platforms counts once on each in the video counts.
 *
 * Engagement rate and cost per engagement (046, 047), over the same levels:
 *
 *   Engagement rate      engagements / reach
 *   Cost per engagement  spend in LKR / engagements
 *
 *   Reach is true reach: different people, as Meta and TikTok report it for
 *   that exact period (paid_reach, written nightly by the n8n Reach sync).
 *   It cannot be added up from days or ads, so engagement rate exists only
 *   for the periods the sync fetches: All time, This year, Last 30 days,
 *   This month, Last month, and each past month for the whole brand. A
 *   custom range has no engagement rate. Combined divides all engagements
 *   by Meta reach plus TikTok reach, so someone reached on both counts twice.
 *
 *   Meta engagements are post reactions, comments, shares, saves, link
 *   clicks, Instagram follows and page likes; TikTok's are paid likes,
 *   comments, shares, follows and destination clicks. The sync writes the
 *   total per ad and day (paid_meta.engagements, paid_tiktok.engagements).
 *   Every paid creative counts, not only video. A day the sync has not
 *   read for engagement is left out of both sides of both figures, never
 *   counted as zero; Impressions covered says how much that leaves in.
 *   Combined adds engagements, impressions and spend; it never averages.
 */

const GRADED = new Set(['Good', 'Average', 'Poor']);
// The hook and hold grades are written Good or Strong depending on where
// they were set; both mean the top band.
const TOP = new Set(['Good', 'Strong']);

const PLATFORMS = ['meta', 'tiktok'];

function empty() {
  return { impr: 0, rated_impr: 0, good_impr: 0, hook_good_impr: 0, hold_good_impr: 0,
           video_n: 0, rated_n: 0, good_n: 0, hook_good_n: 0, hold_good_n: 0 };
}

function add(t, r) {
  const impr = Number(r.impr) || 0;
  t.impr += impr;
  t.video_n += 1;
  if (!GRADED.has(r.cqr)) return;
  t.rated_impr += impr;
  t.rated_n += 1;
  if (r.cqr === 'Good') { t.good_impr += impr; t.good_n += 1; }
  if (TOP.has(r.hook_q)) { t.hook_good_impr += impr; t.hook_good_n += 1; }
  if (TOP.has(r.hold_q)) { t.hold_good_impr += impr; t.hold_good_n += 1; }
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Totals to the figures shown. Percentages to one decimal place. */
function figures(t) {
  return {
    cqr_good_rate: pct(t.good_impr, t.rated_impr),
    hook_good_rate: pct(t.hook_good_impr, t.rated_impr),
    hold_good_rate: pct(t.hold_good_impr, t.rated_impr),
    rated_share: pct(t.rated_impr, t.impr),
    impressions: t.impr,
    rated_impressions: t.rated_impr,
    video_n: t.video_n, rated_n: t.rated_n,
    cqr_good_n: t.good_n, hook_good_n: t.hook_good_n, hold_good_n: t.hold_good_n,
  };
}

function threeWay(rows, engRows, reach) {
  const by = { meta: empty(), tiktok: empty(), combined: empty() };
  for (const r of rows) {
    add(by[r.platform], r);
    add(by.combined, r);
  }
  const out = { meta: figures(by.meta), tiktok: figures(by.tiktok), combined: figures(by.combined) };
  if (engRows) {
    const e = { meta: emptyEng(), tiktok: emptyEng(), combined: emptyEng() };
    for (const r of engRows) { addEng(e[r.platform], r); addEng(e.combined, r); }
    for (const p of ['meta', 'tiktok', 'combined']) Object.assign(out[p], engFigures(e[p]));
    applyReach(out, reach);
  }
  return out;
}

/**
 * Engagement rate from true reach. reach is { meta, tiktok }, each
 * { reach, basis } or missing. A platform with delivery and no reach has no
 * rate, and then Combined has none either: half a denominator would
 * overstate it.
 */
function applyReach(out, reach) {
  let total = 0, complete = true, any = false;
  for (const p of PLATFORMS) {
    const f = out[p];
    const r = reach && reach[p];
    const has = r && r.reach !== null && r.reach !== undefined && Number(r.reach) > 0;
    f.reach = has ? Number(r.reach) : null;
    f.reach_basis = has ? r.basis || 'ads' : null;
    f.paid_engagement_rate = has && f.eng_impressions > 0 ? round((f.engagements / f.reach) * 100, 2) : null;
    if (f.paid_impressions > 0) {
      any = true;
      if (has && f.eng_impressions > 0) total += f.reach; else complete = false;
    }
  }
  const c = out.combined;
  c.reach = any && complete ? total : null;
  c.reach_basis = null;
  c.paid_engagement_rate = c.reach ? round((c.engagements / c.reach) * 100, 2) : null;
}

// ---- Engagement --------------------------------------------------------
function emptyEng() {
  return { impr: 0, spend: 0, eng_impr: 0, eng_spend: 0, eng: 0, creative_n: 0, eng_creative_n: 0 };
}

function addEng(t, r) {
  t.impr += Number(r.impr) || 0;
  t.spend += Number(r.spend) || 0;
  t.creative_n += 1;
  const ei = Number(r.eng_impr) || 0;
  if (ei <= 0) return;
  t.eng_impr += ei;
  t.eng_spend += Number(r.eng_spend) || 0;
  t.eng += Number(r.eng) || 0;
  t.eng_creative_n += 1;
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

function engFigures(t) {
  return {
    paid_engagement_rate: null,     // set from reach in applyReach
    cost_per_engagement: t.eng > 0 ? round(t.eng_spend / t.eng, 2) : null,
    engagements: t.eng,
    eng_impressions: t.eng_impr,
    eng_coverage: pct(t.eng_impr, t.impr),
    eng_spend: round(t.eng_spend, 2),
    paid_impressions: t.impr,
    paid_creative_n: t.creative_n,
    eng_creative_n: t.eng_creative_n,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // A real calendar day: 2026-02-30 parses in JavaScript but not in Postgres.
  const d = ISO.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw Object.assign(new Error('Dates must be written as YYYY-MM-DD.'), { status: 400 });
  return s;
}

/**
 * One row per video and platform with impressions inside the range, for
 * every brand asked for. q is a pg-style query function.
 */
async function loadRows(q, brandIds, from, to) {
  const { rows } = await q(
    `with daily as (
       select 'meta'::text as platform, brand_id, creative_id, sum(impressions)::numeric as impr
         from v_paid_meta_scored
        where brand_id = any($1::text[]) and creative_id is not null
          and ($2::date is null or date >= $2::date) and ($3::date is null or date <= $3::date)
        group by brand_id, creative_id
       union all
       select 'tiktok'::text, brand_id, creative_id, sum(impressions)::numeric
         from v_paid_tiktok_scored
        where brand_id = any($1::text[]) and creative_id is not null
          and ($2::date is null or date >= $2::date) and ($3::date is null or date <= $3::date)
        group by brand_id, creative_id
     ),
     graded as (
       select 'meta'::text as platform, brand_id, creative_id, cqr, hook_q, hold_q
         from v_paid_meta_creative where brand_id = any($1::text[])
       union all
       select 'tiktok'::text, brand_id, creative_id, cqr, hook_q, hold_q
         from v_paid_tiktok_creative where brand_id = any($1::text[])
     )
     select d.platform, d.brand_id, d.creative_id, coalesce(nullif(trim(c.campaign), ''), 'No campaign') as campaign,
            d.impr, g.cqr, g.hook_q, g.hold_q
       from daily d
       join creatives c on c.creative_id = d.creative_id
       left join graded g on g.platform = d.platform and g.brand_id = d.brand_id and g.creative_id = d.creative_id
      where d.impr > 0
        and coalesce(c.content_type, 'Video') not in ('Photo', 'Carousel')`,
    [brandIds, from, to]);
  return rows;
}

/**
 * One row per creative and platform with delivery inside the range: all
 * impressions and spend, and the part of both on days the sync has read
 * for engagement, with those engagements. Null before 046 is run.
 */
async function loadEngagement(q, brandIds, from, to) {
  const range = `($2::date is null or date >= $2::date) and ($3::date is null or date <= $3::date)`;
  try {
    const { rows } = await q(
      `with s as (
         select 'meta'::text as platform, brand_id, creative_id, date::date as d,
                sum(impressions)::numeric as impr, sum(to_lkr(spend, currency, date)) as spend
           from v_paid_meta_scored
          where brand_id = any($1::text[]) and creative_id is not null and ${range}
          group by brand_id, creative_id, date::date
         union all
         select 'tiktok'::text, brand_id, creative_id, date::date,
                sum(impressions)::numeric, sum(to_lkr(spend, currency, date))
           from v_paid_tiktok_scored
          where brand_id = any($1::text[]) and creative_id is not null and ${range}
          group by brand_id, creative_id, date::date
       ),
       e as (
         select 'meta'::text as platform, brand_id, creative_id, date::date as d,
                sum(engagements)::numeric as eng, bool_and(engagements is not null) as captured
           from paid_meta
          where brand_id = any($1::text[]) and creative_id is not null and ${range}
          group by brand_id, creative_id, date::date
         union all
         select 'tiktok'::text, brand_id, creative_id, date::date,
                sum(engagements)::numeric, bool_and(engagements is not null)
           from paid_tiktok
          where brand_id = any($1::text[]) and creative_id is not null and ${range}
          group by brand_id, creative_id, date::date
       )
       select s.platform, s.brand_id, s.creative_id,
              coalesce(nullif(trim(c.campaign), ''), 'No campaign') as campaign,
              sum(s.impr) as impr, coalesce(sum(s.spend), 0) as spend,
              coalesce(sum(s.impr) filter (where e.captured), 0) as eng_impr,
              coalesce(sum(s.spend) filter (where e.captured), 0) as eng_spend,
              coalesce(sum(e.eng) filter (where e.captured), 0) as eng
         from s
         join creatives c on c.creative_id = s.creative_id
         left join e on e.platform = s.platform and e.brand_id = s.brand_id
                    and e.creative_id = s.creative_id and e.d = s.d
        where s.impr > 0
        group by s.platform, s.brand_id, s.creative_id, c.campaign`,
      [brandIds, from, to]);
    return rows;
  } catch (e) {
    // 42703: the engagement columns are not there yet (046 not run).
    if (e && e.code === '42703') return null;
    throw e;
  }
}

// ---- Reach ---------------------------------------------------------------
const PERIODS = ['all_time', 'this_year', 'last_30', 'this_month', 'last_month'];
const MONTH_PERIOD = /^month:\d{4}-(0[1-9]|1[0-2])$/;

function cleanPeriod(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (PERIODS.includes(s) || MONTH_PERIOD.test(s)) return s;
  throw Object.assign(new Error('Unknown period.'), { status: 400 });
}

/** A from/to that is exactly one calendar month reads as that month's period. */
function monthPeriod(from, to) {
  if (!from || !to || from.slice(8) !== '01' || from.slice(0, 7) !== to.slice(0, 7)) return null;
  const last = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return to === last ? `month:${from.slice(0, 7)}` : null;
}

/**
 * True reach for these brands and one period: by brand, platform and
 * campaign ('' is the whole brand). Null before 047 is run.
 */
async function loadReach(q, brandIds, period) {
  if (!period) return [];
  try {
    const { rows } = await q(
      `select brand_id, platform, campaign, reach, basis, error,
              period_start::text as period_start, period_end::text as period_end, fetched_at
         from paid_reach
        where brand_id = any($1::text[]) and period = $2 and creative_id = ''`, [brandIds, period]);
    return rows;
  } catch (e) {
    if (e && e.code === '42P01') return null;   // paid_reach not there yet
    throw e;
  }
}

async function periodForDates(q, brandIds, from, to) {
  try {
    const { rows } = await q(
      `select period from paid_reach
        where brand_id = any($1::text[]) and campaign = '' and creative_id = ''
          and period <> 'lifetime' and period_start = $2::date and period_end = $3::date
        order by fetched_at desc limit 1`, [brandIds, from, to]);
    return rows[0] ? rows[0].period : null;
  } catch (e) {
    if (e && e.code === '42P01') return null;
    throw e;
  }
}

/** { brand_id: { campaign: { meta, tiktok } } } */
function reachIndex(rows) {
  const ix = {};
  for (const r of rows || []) {
    ix[r.brand_id] = ix[r.brand_id] || {};
    ix[r.brand_id][r.campaign] = ix[r.brand_id][r.campaign] || {};
    if (!r.error) ix[r.brand_id][r.campaign][r.platform] = { reach: r.reach, basis: r.basis };
  }
  return ix;
}

/**
 * Which period to read reach for, and the dates the whole answer uses. A
 * preset uses the dates the sync fetched reach for, so engagements, spend
 * and reach all cover the same days. All time keeps every day for CQR.
 */
async function resolvePeriod(q, brandIds, { from, to, period }) {
  // No dates at all is All time; a range that is not a preset or one
  // calendar month has no true reach.
  period = cleanPeriod(period) || monthPeriod(from, to) || (!from && !to ? 'all_time' : null);
  // Dates that are exactly a period the sync fetched (a preset as it was on
  // some day, or an Ask Lens answer read back later) use that period.
  if (!period && from && to) period = await periodForDates(q, brandIds, from, to);
  if (!period) return { from, to, period: null, reach: [], status: 'custom' };
  const reach = await loadReach(q, brandIds, period);
  if (reach === null) return { from, to, period, reach: [], status: 'not_ready' };
  const brandRow = reach.find((r) => r.campaign === '' && !r.error) || reach.find((r) => r.campaign === '');
  if (!brandRow) return { from, to, period, reach, status: 'not_fetched' };
  const dates = period === 'all_time' ? { from: null, to: null }
    : { from: brandRow.period_start, to: brandRow.period_end };
  return { ...dates, period, reach, status: 'ok',
           reach_start: brandRow.period_start, reach_end: brandRow.period_end, fetched_at: brandRow.fetched_at };
}

/** Whether Meta has reported any Instagram follows for these brands. */
async function igFollowsSeen(q, brandIds) {
  try {
    const { rows } = await q(
      `select exists (select 1 from paid_meta where brand_id = any($1::text[]) and eng_ig_follows > 0) as seen`, [brandIds]);
    return !!(rows[0] && rows[0].seen);
  } catch (e) {
    if (e && e.code === '42703') return false;
    throw e;
  }
}

/** The first and last day of paid delivery on file, for the date control. */
async function dataSpan(q, brandIds) {
  const { rows } = await q(
    `select min(d)::text as first_day, max(d)::text as last_day from (
       select min(date) as d from v_paid_meta_scored where brand_id = any($1::text[]) and creative_id is not null
       union all select max(date) from v_paid_meta_scored where brand_id = any($1::text[]) and creative_id is not null
       union all select min(date) from v_paid_tiktok_scored where brand_id = any($1::text[]) and creative_id is not null
       union all select max(date) from v_paid_tiktok_scored where brand_id = any($1::text[]) and creative_id is not null
     ) x`, [brandIds]);
  return rows[0] || { first_day: null, last_day: null };
}

// Paid data lands once a day, so a result is good for a few minutes. This
// keeps a page that redraws, or several people on the same brand, from
// running the same scan again.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
function clearCache() { cache.clear(); }

function checkRange(from, to) {
  if (from && to && from > to) throw Object.assign(new Error('The start date is after the end date.'), { status: 400 });
}

/** One brand: overall and per campaign. */
async function forBrand(q, brandId, { from, to, period } = {}) {
  from = cleanDate(from); to = cleanDate(to); checkRange(from, to); cleanPeriod(period);
  return cached(`b|${brandId}|${from}|${to}|${period || ''}`, async () => {
    const rp = await resolvePeriod(q, [brandId], { from, to, period });
    return forBrandUncached(q, brandId, rp.from, rp.to, rp);
  });
}

function reachInfo(rp) {
  return { period: rp.period, status: rp.status, start: rp.reach_start || null, end: rp.reach_end || null,
           fetched_at: rp.fetched_at || null };
}

async function forBrandUncached(q, brandId, from, to, rp = { reach: [], status: 'custom' }) {
  const ix = reachIndex(rp.reach)[brandId] || {};
  const [rows, span, engRows, igSeen] = await Promise.all([
    loadRows(q, [brandId], from, to), dataSpan(q, [brandId]),
    loadEngagement(q, [brandId], from, to), igFollowsSeen(q, [brandId]),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const r of list || []) {
      if (!m.has(r.campaign)) m.set(r.campaign, []);
      m.get(r.campaign).push(r);
    }
    return m;
  };
  const byCampaign = group(rows);
  const engByCampaign = group(engRows);
  const names = new Set([...byCampaign.keys(), ...engByCampaign.keys()]);
  const campaigns = [...names]
    .map((name) => ({ name, ...threeWay(byCampaign.get(name) || [], engRows ? engByCampaign.get(name) || [] : null, ix[name]) }))
    .sort((a, b) => (b.combined.paid_impressions || b.combined.impressions) - (a.combined.paid_impressions || a.combined.impressions));
  return {
    brand_id: brandId, from, to, span,
    engagement_ready: !!engRows,
    reach: reachInfo(rp),
    inputs: { ig_follows: igSeen, tiktok_favorites: false },
    overall: threeWay(rows, engRows, ix['']), campaigns,
  };
}

/** Several brands side by side, overall only. */
async function forBrands(q, brandIds, { from, to, period } = {}) {
  from = cleanDate(from); to = cleanDate(to); checkRange(from, to); cleanPeriod(period);
  return cached(`m|${[...brandIds].sort().join(',')}|${from}|${to}|${period || ''}`, async () => {
    const rp = await resolvePeriod(q, brandIds, { from, to, period });
    return forBrandsUncached(q, brandIds, rp.from, rp.to, rp);
  });
}

async function forBrandsUncached(q, brandIds, from, to, rp = { reach: [], status: 'custom' }) {
  const ix = reachIndex(rp.reach);
  const [rows, engRows] = await Promise.all([loadRows(q, brandIds, from, to), loadEngagement(q, brandIds, from, to)]);
  const by = new Map(brandIds.map((b) => [b, []]));
  const engBy = new Map(brandIds.map((b) => [b, []]));
  for (const r of rows) if (by.has(r.brand_id)) by.get(r.brand_id).push(r);
  for (const r of engRows || []) if (engBy.has(r.brand_id)) engBy.get(r.brand_id).push(r);
  return {
    from, to, engagement_ready: !!engRows, reach: reachInfo(rp),
    brands: brandIds.map((b) => ({ brand_id: b, ...threeWay(by.get(b), engRows ? engBy.get(b) : null, (ix[b] || {})['']) })),
  };
}

module.exports = { forBrand, forBrands, threeWay, figures, engFigures, cleanDate, cleanPeriod, monthPeriod, clearCache, PLATFORMS, PERIODS };

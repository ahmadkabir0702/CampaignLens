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

function threeWay(rows) {
  const by = { meta: empty(), tiktok: empty(), combined: empty() };
  for (const r of rows) {
    add(by[r.platform], r);
    add(by.combined, r);
  }
  return { meta: figures(by.meta), tiktok: figures(by.tiktok), combined: figures(by.combined) };
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
async function forBrand(q, brandId, { from, to } = {}) {
  from = cleanDate(from); to = cleanDate(to); checkRange(from, to);
  return cached(`b|${brandId}|${from}|${to}`, () => forBrandUncached(q, brandId, from, to));
}

async function forBrandUncached(q, brandId, from, to) {
  const [rows, span] = await Promise.all([loadRows(q, [brandId], from, to), dataSpan(q, [brandId])]);
  const byCampaign = new Map();
  for (const r of rows) {
    if (!byCampaign.has(r.campaign)) byCampaign.set(r.campaign, []);
    byCampaign.get(r.campaign).push(r);
  }
  const campaigns = [...byCampaign.entries()]
    .map(([name, rs]) => ({ name, ...threeWay(rs) }))
    .sort((a, b) => b.combined.impressions - a.combined.impressions);
  return { brand_id: brandId, from, to, span, overall: threeWay(rows), campaigns };
}

/** Several brands side by side, overall only. */
async function forBrands(q, brandIds, { from, to } = {}) {
  from = cleanDate(from); to = cleanDate(to); checkRange(from, to);
  return cached(`m|${[...brandIds].sort().join(',')}|${from}|${to}`, () => forBrandsUncached(q, brandIds, from, to));
}

async function forBrandsUncached(q, brandIds, from, to) {
  const rows = await loadRows(q, brandIds, from, to);
  const by = new Map(brandIds.map((b) => [b, []]));
  for (const r of rows) if (by.has(r.brand_id)) by.get(r.brand_id).push(r);
  return { from, to, brands: brandIds.map((b) => ({ brand_id: b, ...threeWay(by.get(b)) })) };
}

module.exports = { forBrand, forBrands, threeWay, figures, cleanDate, clearCache, PLATFORMS };

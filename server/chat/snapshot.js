/**
 * Ask Lens - snapshot generator
 *
 * Builds a compact digest of one brand over one date range. The digest
 * goes into the cached prompt prefix, which is why ~70% of questions
 * never need a tool call.
 *
 * Run from cron after each n8n pipeline run:
 *   node -e "require('./server/chat/snapshot').warmAll()"
 */

const crypto = require('crypto');
const S = require('./schema.config');
const { getPool } = require('./db');

const T = S.tables;
const C = S.creative;
const M = S.metric;

const TOP_N = 5;
const ENGAGEMENT_N = 3;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function assertBrand(brand) {
  if (!S.brands.includes(brand)) {
    throw new Error(`Unknown brand: ${brand}`);
  }
  return brand;
}

function pct(v, decimals = 2) {
  if (v === null || v === undefined) return 'n/a';
  return `${(Number(v) * 100).toFixed(decimals)}%`;
}

function num(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function money(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  // CPC and CPM are often small. Rounding them to a whole number throws
  // away the only digits that matter, so keep two decimals under 100.
  if (Math.abs(n) < 100) return `${n.toFixed(2)} ${S.currency}`;
  return `${num(n)} ${S.currency}`;
}

/** Percentage-point delta for rate metrics, percent delta for volume metrics. */
function delta(current, prior, isRate) {
  if (current === null || prior === null || prior === undefined || Number(prior) === 0) {
    return 'n/a';
  }
  if (isRate) {
    const pp = (Number(current) - Number(prior)) * 100;
    if (Math.abs(pp) < 0.005) return 'flat';
    return `${pp > 0 ? '+' : ''}${pp.toFixed(2)}pp`;
  }
  const p = ((Number(current) - Number(prior)) / Number(prior)) * 100;
  if (Math.abs(p) < 0.5) return 'flat';
  return `${p > 0 ? '+' : ''}${p.toFixed(0)}%`;
}

function dateRange(rangeDays, endDate = new Date()) {
  const end = new Date(endDate);
  const start = new Date(end);
  start.setDate(start.getDate() - (rangeDays - 1));
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (rangeDays - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    start: iso(start),
    end: iso(end),
    prevStart: iso(prevStart),
    prevEnd: iso(prevEnd),
  };
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

/** Brand totals for a period. */
async function queryTotals(pool, brand, start, end) {
  const sql = `
    select
      coalesce(sum(m.${M.impressions}), 0)  as impressions,
      coalesce(sum(m.${M.reach}), 0)        as reach,
      coalesce(sum(m.${M.clicks}), 0)       as clicks,
      coalesce(sum(m.${M.spend}), 0)        as spend,
      coalesce(sum(m.${M.engagements}), 0)  as engagements,
      ${S.derived.ctr}             as ctr,
      ${S.derived.cpm}             as cpm,
      ${S.derived.cpc}             as cpc,
      ${S.derived.engagement_rate} as engagement_rate,
      count(distinct c.${C.id})    as creative_count
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
      and m.${M.date} between $2 and $3
  `;
  const { rows } = await pool.query(sql, [brand, start, end]);
  return rows[0];
}

/** Spend share and rates by platform. Platform lives on the metrics row. */
async function queryPlatforms(pool, brand, start, end) {
  const sql = `
    select
      m.${M.platform}                       as platform,
      coalesce(sum(m.${M.spend}), 0)        as spend,
      coalesce(sum(m.${M.impressions}), 0)  as impressions,
      ${S.derived.ctr}                      as ctr,
      ${S.derived.engagement_rate}          as engagement_rate,
      count(distinct c.${C.id})             as creative_count
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
      and m.${M.date} between $2 and $3
    group by m.${M.platform}
    order by spend desc
  `;
  const { rows } = await pool.query(sql, [brand, start, end]);
  return rows;
}

/** Creative counts and average performance by format. */
async function queryFormats(pool, brand, start, end) {
  const sql = `
    select
      coalesce(c.${C.format}, 'unclassified') as format,
      count(distinct c.${C.id})               as creative_count,
      coalesce(sum(m.${M.impressions}), 0)    as impressions,
      ${S.derived.ctr}                        as ctr,
      ${S.derived.engagement_rate}            as engagement_rate
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
      and m.${M.date} between $2 and $3
    group by coalesce(c.${C.format}, 'unclassified')
    order by creative_count desc
  `;
  const { rows } = await pool.query(sql, [brand, start, end]);
  return rows;
}

/** Originals vs repurposed, derived from the is_repurposed boolean. */
async function queryOrigin(pool, brand, start, end) {
  const sql = `
    select
      ${S.creativeExpr.origin}             as origin,
      count(distinct c.${C.id})            as creative_count,
      coalesce(sum(m.${M.impressions}), 0) as impressions,
      ${S.derived.ctr}                     as ctr,
      ${S.derived.engagement_rate}         as engagement_rate
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
      and m.${M.date} between $2 and $3
    group by ${S.creativeExpr.origin}
  `;
  const { rows } = await pool.query(sql, [brand, start, end]);
  return rows;
}

/**
 * Per-creative aggregates with the volume floor applied.
 * Returns every creative above the floor plus the count excluded,
 * so the digest can be honest about what it left out.
 */
async function queryCreatives(pool, brand, start, end, floor) {
  const sql = `
    select
      c.${C.id}            as id,
      c.${C.name}          as name,
      c.${C.format}        as format,
      c.${C.productRole}   as product_role,
      c.${C.parentId}      as parent_id,
      ${S.creativeExpr.origin}     as origin,
      ${S.creativeExpr.platforms}  as platforms,
      ${S.creativeExpr.permalink}  as permalink,
      coalesce(sum(m.${M.impressions}), 0) as impressions,
      coalesce(sum(m.${M.reach}), 0)       as reach,
      coalesce(sum(m.${M.clicks}), 0)      as clicks,
      coalesce(sum(m.${M.spend}), 0)       as spend,
      coalesce(sum(m.${M.engagements}), 0) as engagements,
      ${S.derived.ctr}             as ctr,
      ${S.derived.cpm}             as cpm,
      ${S.derived.cpc}             as cpc,
      ${S.derived.engagement_rate} as engagement_rate
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
      and m.${M.date} between $2 and $3
    group by c.${C.id}, c.${C.name}, c.${C.format}, c.${C.productRole},
             c.${C.parentId}, c.${C.isRepurposed}, c.${C.ttLink}, c.${C.igLink}, c.${C.fbLink}
  `;
  const { rows } = await pool.query(sql, [brand, start, end]);
  const eligible = rows.filter((r) => Number(r.impressions) >= floor);
  return { all: rows, eligible, excluded: rows.length - eligible.length };
}

/**
 * Earliest date each platform has data for. Used to decide whether a
 * period-over-period delta is honest. If TikTok only started being
 * tracked partway through the prior period, "spend +42%" is partly just
 * a platform appearing, not the team spending more.
 */
async function queryCoverage(pool, brand) {
  const sql = `
    select
      m.${M.platform}                                          as platform,
      min(m.${M.date})                                         as first_date,
      count(*)                                                 as rows,
      count(*) filter (where m.${M.engagements} is not null)    as rows_with_engagement
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
    group by m.${M.platform}
  `;
  const { rows } = await pool.query(sql, [brand]);
  return rows;
}

/** Freshest data timestamp, used for cache versioning. */
async function queryFreshness(pool, brand) {
  const sql = `
    select max(m.${M.date})::text as max_date, count(*) as row_count
    from ${T.creatives} c
    join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
    where c.${C.brand} = $1
  `;
  const { rows } = await pool.query(sql, [brand]);
  return rows[0];
}

// ---------------------------------------------------------------
// Digest rendering
// ---------------------------------------------------------------

function renderDigest(ctx) {
  const {
    brand, range, totals, prior, platforms, formats, origin,
    topCtr, bottomCtr, topEngagement, excluded, floor, freshness, coverage,
  } = ctx;

  const L = [];
  const label = S.brandLabels[brand] || brand;

  L.push(`SNAPSHOT: ${label} | ${range.start} to ${range.end} | data through ${freshness.max_date}`);
  L.push('');

  L.push('TOTALS');
  const d = coverage.deltasReliable
    ? (cur, pri, isRate) => ` (${delta(cur, pri, isRate)})`
    : () => '';

  L.push(`spend ${money(totals.spend)}${d(totals.spend, prior.spend, false)} | ` +
         `impressions ${num(totals.impressions)}${d(totals.impressions, prior.impressions, false)} | ` +
         `reach ${num(totals.reach)}${d(totals.reach, prior.reach, false)}`);
  L.push(`CTR ${pct(totals.ctr)}${d(totals.ctr, prior.ctr, true)} | ` +
         `engagement rate ${pct(totals.engagement_rate)}${d(totals.engagement_rate, prior.engagement_rate, true)} | ` +
         `CPM ${money(totals.cpm)}${d(totals.cpm, prior.cpm, false)} | ` +
         `CPC ${money(totals.cpc)}${d(totals.cpc, prior.cpc, false)}`);

  if (coverage.deltasReliable) {
    L.push(`${totals.creative_count} creatives live in period. Deltas compare to the previous ${range.days} days.`);
  } else {
    L.push(`${totals.creative_count} creatives live in period.`);
    L.push(`NO PERIOD COMPARISON AVAILABLE. ${coverage.reason}`);
    L.push('Do not compare this period to any earlier one, and do not say performance went up or down versus last month. Say the comparison is not available yet and why.');
  }
  L.push('');

  L.push('BY PLATFORM');
  const totalSpend = Number(totals.spend) || 1;
  for (const p of platforms) {
    const share = ((Number(p.spend) / totalSpend) * 100).toFixed(0);
    L.push(`${S.platformLabels[p.platform] || p.platform}: ${share}% of spend, ` +
           `CTR ${pct(p.ctr)}, ER ${pct(p.engagement_rate)}, ${p.creative_count} creatives`);
  }
  L.push('');

  L.push('BY FORMAT');
  for (const f of formats) {
    L.push(`${f.format}: ${f.creative_count} creatives, CTR ${pct(f.ctr)}, ER ${pct(f.engagement_rate)}`);
  }
  L.push('');

  L.push('ORIGINALS VS REPURPOSED');
  for (const o of origin) {
    L.push(`${o.origin}: ${o.creative_count} creatives, CTR ${pct(o.ctr)}, ER ${pct(o.engagement_rate)}`);
  }
  L.push('');

  const line = (c) => {
    const plats = (c.platforms || []).map((p) => S.platformLabels[p] || p).join('+') || 'unknown';
    const er = c.engagement_rate === null ? 'n/a' : pct(c.engagement_rate);
    return `${c.id} | ${plats} | ${c.format || 'unclassified'} | ${c.origin || 'unknown'} | ` +
           `CTR ${pct(c.ctr)} | ER ${er} | impr ${num(c.impressions)}`;
  };

  L.push(`TOP ${topCtr.length} BY CTR`);
  topCtr.forEach((c) => L.push(line(c)));
  L.push('');

  L.push(`BOTTOM ${bottomCtr.length} BY CTR`);
  bottomCtr.forEach((c) => L.push(line(c)));
  L.push('');

  L.push(`TOP ${topEngagement.length} BY ENGAGEMENT RATE`);
  topEngagement.forEach((c) => L.push(line(c)));
  L.push('');

  L.push('RANKING RULES APPLIED');
  L.push(`Creatives below ${num(floor)} impressions in this period are excluded from all rankings above.`);
  L.push(excluded > 0
    ? `${excluded} creative${excluded === 1 ? ' was' : 's were'} excluded on that basis. Mention this if you report a ranking.`
    : 'No creatives were excluded on that basis.');
  L.push('');

  const gaps = [];
  const noEngagement = (coverage.rows || []).filter((r) => Number(r.rows_with_engagement) === 0);
  const partial = (coverage.rows || []).filter(
    (r) => Number(r.rows_with_engagement) > 0 && Number(r.rows_with_engagement) < Number(r.rows),
  );

  if (noEngagement.length) {
    const names = noEngagement.map((r) => S.platformLabels[r.platform] || r.platform).join(' and ');
    gaps.push(`${names} paid reports no engagement data, so engagement rate and engagements exclude it entirely.`);
    gaps.push('Never present that figure as a whole-brand or cross-platform number.');
  }
  for (const r of partial) {
    const name = S.platformLabels[r.platform] || r.platform;
    const share = Math.round((Number(r.rows_with_engagement) / Number(r.rows)) * 100);
    gaps.push(`${name} engagement data covers about ${share}% of its rows; earlier rows predate engagement tracking and are excluded from the rate.`);
  }
  if (!noEngagement.length) {
    gaps.push('Meta counts post engagements while TikTok counts likes, comments, shares and follows. The definitions differ, so treat a cross-platform engagement rate as indicative rather than exact.');
  }
  gaps.push('Organic performance is lifetime to date and is not filtered by this date range.');

  L.push('DATA GAPS');
  gaps.forEach((g) => L.push(g));
  L.push('');

  L.push('NOT IN THIS SNAPSHOT');
  L.push('Daily or weekly time series. Creatives outside the top and bottom lists above.');
  L.push('Individual creative comments or captions. Lineage detail beyond the origin counts.');
  L.push('Anything outside this date range. Any brand other than ' + label + '.');
  L.push('For any of these, call a tool. Never estimate a number that is not written above.');

  return L.join('\n');
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Build a snapshot for one brand and range. Returns the row shape
 * written to brand_snapshots.
 */
async function buildSnapshot(brand, rangeDays, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const range = { ...dateRange(rangeDays, opts.endDate), days: rangeDays };

  const freshness = await queryFreshness(pool, brand);
  const coverageRows = await queryCoverage(pool, brand);

  // A delta is only honest if every platform has data across the whole
  // prior period. Otherwise growth is partly a platform switching on.
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const late = coverageRows.filter((r) => iso(r.first_date) > range.prevStart);
  const coverage = late.length
    ? {
        rows: coverageRows,
        deltasReliable: false,
        reason:
          late.map((r) => `${S.platformLabels[r.platform] || r.platform} data only starts ${iso(r.first_date)}`).join('; ') +
          `, which is inside the comparison window (${range.prevStart} to ${range.prevEnd}), so any period-over-period change would partly reflect tracking coverage rather than performance.`,
      }
    : { rows: coverageRows, deltasReliable: true, reason: null };

  const totals = await queryTotals(pool, brand, range.start, range.end);
  const prior = await queryTotals(pool, brand, range.prevStart, range.prevEnd);

  const floor = Math.max(
    S.volumeFloor.absoluteMin,
    Math.round(Number(totals.impressions || 0) * S.volumeFloor.relativeShare),
  );

  const [platforms, formats, origin, creatives] = await Promise.all([
    queryPlatforms(pool, brand, range.start, range.end),
    queryFormats(pool, brand, range.start, range.end),
    queryOrigin(pool, brand, range.start, range.end),
    queryCreatives(pool, brand, range.start, range.end, floor),
  ]);

  const byCtrDesc = [...creatives.eligible].sort((a, b) => Number(b.ctr || 0) - Number(a.ctr || 0));
  const byErDesc = [...creatives.eligible].sort(
    (a, b) => Number(b.engagement_rate || 0) - Number(a.engagement_rate || 0),
  );

  const topCtr = byCtrDesc.slice(0, TOP_N);
  const bottomCtr = byCtrDesc.slice(-TOP_N).reverse();
  const topEngagement = byErDesc.slice(0, ENGAGEMENT_N);

  const version = crypto
    .createHash('sha256')
    .update([brand, rangeDays, range.end, freshness.max_date, freshness.row_count].join('|'))
    .digest('hex')
    .slice(0, 12);

  const body = renderDigest({
    brand, range, totals, prior, platforms, formats, origin,
    topCtr, bottomCtr, topEngagement,
    excluded: creatives.excluded, floor, freshness, coverage,
  });

  // Records for the marker side payload. Every creative referenced in
  // the digest must be resolvable by the frontend without a round trip.
  const referenced = new Map();
  for (const c of [...topCtr, ...bottomCtr, ...topEngagement]) {
    referenced.set(c.id, c);
  }

  return {
    brand,
    range_days: rangeDays,
    period_start: range.start,
    period_end: range.end,
    version,
    body,
    records: Object.fromEntries(referenced),
    token_estimate: Math.ceil(body.length / 3.6),
    floor,
  };
}

/** Build and persist. Returns the stored row. */
async function generateAndStore(brand, rangeDays, opts = {}) {
  const pool = opts.pool || getPool();
  const snap = await buildSnapshot(brand, rangeDays, opts);

  const sql = `
    insert into brand_snapshots
      (brand, range_days, period_start, period_end, version, body, records, token_estimate)
    values ($1, $2, $3, $4, $5, $6, $7, $8)
    on conflict (brand, range_days, version) do update
      set body = excluded.body,
          records = excluded.records,
          period_start = excluded.period_start,
          period_end = excluded.period_end,
          generated_at = now()
    returning *
  `;
  const { rows } = await pool.query(sql, [
    snap.brand, snap.range_days, snap.period_start, snap.period_end,
    snap.version, snap.body, JSON.stringify(snap.records), snap.token_estimate,
  ]);
  return rows[0];
}

/** Read the freshest stored snapshot. Builds one on demand if missing. */
async function getSnapshot(brand, rangeDays, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const { rows } = await pool.query(
    `select * from brand_snapshots
     where brand = $1 and range_days = $2
     order by generated_at desc limit 1`,
    [brand, rangeDays],
  );
  if (rows.length) return rows[0];
  return generateAndStore(brand, rangeDays, opts);
}

/** Cron entry point. Regenerates every brand and range, then prunes. */
async function warmAll(opts = {}) {
  const pool = opts.pool || getPool();
  const results = [];
  for (const brand of S.brands) {
    for (const rangeDays of S.snapshotRanges) {
      try {
        const row = await generateAndStore(brand, rangeDays, { pool });
        results.push({ brand, rangeDays, version: row.version, tokens: row.token_estimate });
      } catch (err) {
        console.error(`[snapshot] ${brand}/${rangeDays}d failed:`, err.message);
        results.push({ brand, rangeDays, error: err.message });
      }
    }
  }
  await pool.query('select prune_answer_cache()');
  console.table(results);
  return results;
}

module.exports = {
  buildSnapshot,
  generateAndStore,
  getSnapshot,
  warmAll,
  dateRange,
  assertBrand,
};

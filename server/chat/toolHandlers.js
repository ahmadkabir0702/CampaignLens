/**
 * Ask Lens - tool handlers
 *
 * Every handler:
 *   1. validates its arguments against the whitelist in schema.config
 *   2. runs one parameterised query scoped to the session's brand
 *   3. returns a compact object plus a `records` map for the marker
 *      side payload
 *
 * The brand is taken from the session, never from the model. A tool
 * call cannot reach another brand's data even if the model asks.
 */

const S = require('./schema.config');
const { getPool } = require('./db');
const { dateRange } = require('./snapshot');

const T = S.tables;
const C = S.creative;
const M = S.metric;

const MAX_RESULT_CHARS = 1500; // ~400 tokens

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

function validMetric(metric) {
  if (!S.rankableMetrics.includes(metric)) {
    throw new Error(`Unsupported metric: ${metric}`);
  }
  return metric;
}

function validPlatform(p) {
  if (p && !S.platforms.includes(p)) throw new Error(`Unsupported platform: ${p}`);
  return p || null;
}

function validOrigin(o) {
  if (o && !['original', 'repurposed'].includes(o)) throw new Error(`Unsupported origin: ${o}`);
  return o || null;
}

function round(v, places = 6) {
  if (v === null || v === undefined) return null;
  return Number(Number(v).toFixed(places));
}

/** Trim a result object if it would blow the token budget. */
function cap(result) {
  const json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_CHARS) return result;
  if (Array.isArray(result.rows)) {
    const trimmed = { ...result, rows: result.rows.slice(0, 5), truncated: true };
    return trimmed;
  }
  return { ...result, truncated: true };
}

/** Shared select list for per-creative aggregates. */
function creativeSelect() {
  return `
    c.${C.id}          as id,
    c.${C.name}        as name,
    c.${C.format}      as format,
    c.${C.productRole} as product_role,
    c.${C.parentId}    as parent_id,
    ${S.creativeExpr.origin}    as origin,
    ${S.creativeExpr.platforms} as platforms,
    ${S.creativeExpr.permalink} as permalink,
    coalesce(sum(m.${M.impressions}), 0) as impressions,
    coalesce(sum(m.${M.reach}), 0)       as reach,
    coalesce(sum(m.${M.clicks}), 0)      as clicks,
    coalesce(sum(m.${M.spend}), 0)       as spend,
    coalesce(sum(m.${M.engagements}), 0) as engagements,
    ${S.derived.ctr}             as ctr,
    ${S.derived.cpm}             as cpm,
    ${S.derived.cpc}             as cpc,
    ${S.derived.engagement_rate} as engagement_rate
  `;
}

function creativeGroupBy() {
  return `
    group by c.${C.id}, c.${C.name}, c.${C.format}, c.${C.productRole},
             c.${C.parentId}, c.${C.isRepurposed},
             c.${C.ttLink}, c.${C.igLink}, c.${C.fbLink}
  `;
}

/** Brand period impressions, for the relative volume floor. */
async function brandFloor(pool, brand, start, end) {
  const { rows } = await pool.query(
    `select coalesce(sum(m.${M.impressions}), 0) as impressions
     from ${T.creatives} c
     join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
     where c.${C.brand} = $1 and m.${M.date} between $2 and $3`,
    [brand, start, end],
  );
  const total = Number(rows[0]?.impressions || 0);
  return Math.max(S.volumeFloor.absoluteMin, Math.round(total * S.volumeFloor.relativeShare));
}

// ---------------------------------------------------------------
// rank_creatives
// ---------------------------------------------------------------

async function rank_creatives(args, ctx) {
  const pool = ctx.pool || getPool();
  const metric = validMetric(args.metric);
  const platform = validPlatform(args.platform);
  const origin = validOrigin(args.origin);
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const range = dateRange(args.range_days || ctx.rangeDays);

  const floor = await brandFloor(pool, ctx.brand, range.start, range.end);

  const lowerBetter = S.lowerIsBetter.includes(metric);
  const wantBest = (args.direction || 'best') === 'best';
  const desc = wantBest ? !lowerBetter : lowerBetter;

  const params = [ctx.brand, range.start, range.end, floor];
  let filters = '';
  if (platform) { params.push(platform); filters += ` and m.${M.platform} = $${params.length}`; }
  if (origin)   { filters += ` and c.${C.isRepurposed} is ${origin === 'repurposed' ? 'true' : 'not true'}`; }
  if (args.format) { params.push(args.format); filters += ` and c.${C.format} = $${params.length}`; }
  params.push(limit);

  const sql = `
    select * from (
      select ${creativeSelect()}
      from ${T.creatives} c
      join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
      where c.${C.brand} = $1 and m.${M.date} between $2 and $3${filters}
      ${creativeGroupBy()}
      having coalesce(sum(m.${M.impressions}), 0) >= $4
    ) ranked
    where ranked.${metric} is not null
    order by ranked.${metric} ${desc ? 'desc' : 'asc'}
    limit $${params.length}
  `;

  const { rows } = await pool.query(sql, params);

  // Count what the floor removed, so the model can say so.
  const { rows: exc } = await pool.query(
    `select count(*)::int as n from (
       select c.${C.id}
       from ${T.creatives} c
       join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
       where c.${C.brand} = $1 and m.${M.date} between $2 and $3
       group by c.${C.id}
       having coalesce(sum(m.${M.impressions}), 0) < $4
     ) t`,
    [ctx.brand, range.start, range.end, floor],
  );

  return {
    result: cap({
      metric,
      direction: wantBest ? 'best' : 'worst',
      period: `${range.start} to ${range.end}`,
      volume_floor_impressions: floor,
      excluded_below_floor: exc[0].n,
      rows: rows.map((r) => ({
        id: r.id,
        platforms: r.platforms,
        format: r.format,
        origin: r.origin,
        [metric]: round(r[metric]),
      })),
    }),
    records: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

// ---------------------------------------------------------------
// get_creative
// ---------------------------------------------------------------

async function get_creative(args, ctx) {
  const pool = ctx.pool || getPool();
  const range = dateRange(args.range_days || ctx.rangeDays);

  const { rows } = await pool.query(
    `select ${creativeSelect()}
     from ${T.creatives} c
     join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
     where c.${C.brand} = $1 and c.${C.id} = $2 and m.${M.date} between $3 and $4
     ${creativeGroupBy()}`,
    [ctx.brand, args.creative_id, range.start, range.end],
  );

  if (!rows.length) {
    return { result: { error: 'No creative with that id has delivery in this period for this brand.' }, records: {} };
  }

  const r = rows[0];
  return {
    result: cap({
      id: r.id,
      platforms: r.platforms,
      format: r.format,
      product_role: r.product_role,
      origin: r.origin,
      is_repurposed_from: r.parent_id || null,
      period: `${range.start} to ${range.end}`,
      impressions: Number(r.impressions),
      reach: Number(r.reach),
      clicks: Number(r.clicks),
      spend: round(r.spend, 2),
      engagements: Number(r.engagements),
      ctr: round(r.ctr),
      cpm: round(r.cpm, 2),
      cpc: round(r.cpc, 2),
      engagement_rate: round(r.engagement_rate),
    }),
    records: { [r.id]: r },
  };
}

// ---------------------------------------------------------------
// get_series
// ---------------------------------------------------------------

async function get_series(args, ctx) {
  const pool = ctx.pool || getPool();
  const metric = validMetric(args.metric);
  const platform = validPlatform(args.platform);
  const granularity = args.granularity === 'week' ? 'week' : 'day';
  const range = dateRange(args.range_days || ctx.rangeDays);

  const bucket = granularity === 'week'
    ? `date_trunc('week', m.${M.date})::date`
    : `m.${M.date}`;

  const params = [ctx.brand, range.start, range.end];
  let filters = '';
  if (platform)         { params.push(platform);         filters += ` and m.${M.platform} = $${params.length}`; }
  if (args.creative_id) { params.push(args.creative_id); filters += ` and c.${C.id} = $${params.length}`; }

  const { rows } = await pool.query(
    `select ${bucket} as bucket, ${S.derived[metric]} as value
     from ${T.creatives} c
     join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
     where c.${C.brand} = $1 and m.${M.date} between $2 and $3${filters}
     group by bucket
     order by bucket`,
    params,
  );

  const labels = rows.map((r) => (r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : String(r.bucket)));
  const values = rows.map((r) => round(r.value));

  // Describe the shape so the model can comment without reading every point.
  const nums = values.filter((v) => v !== null);
  const first = nums[0] ?? null;
  const last = nums[nums.length - 1] ?? null;
  const peakIdx = values.indexOf(Math.max(...nums));
  const troughIdx = values.indexOf(Math.min(...nums));

  return {
    result: cap({
      metric,
      granularity,
      period: `${range.start} to ${range.end}`,
      points: values.length,
      first, last,
      direction: first !== null && last !== null ? (last > first ? 'up' : last < first ? 'down' : 'flat') : 'unknown',
      peak: peakIdx >= 0 ? { date: labels[peakIdx], value: values[peakIdx] } : null,
      trough: troughIdx >= 0 ? { date: labels[troughIdx], value: values[troughIdx] } : null,
      note: 'Full series is attached to the interface. Reference it with [[chart:line|' + metric + '|series]].',
    }),
    records: {},
    series: { metric, granularity, labels, values, scope: args.creative_id || platform || 'brand' },
  };
}

// ---------------------------------------------------------------
// compare_creatives
// ---------------------------------------------------------------

async function compare_creatives(args, ctx) {
  const pool = ctx.pool || getPool();
  const ids = (args.creative_ids || []).slice(0, 4);
  if (ids.length < 2) throw new Error('compare_creatives needs at least two creative ids.');

  const metrics = (args.metrics && args.metrics.length ? args.metrics : ['ctr', 'engagement_rate', 'impressions', 'spend'])
    .map(validMetric);
  const range = dateRange(args.range_days || ctx.rangeDays);

  const { rows } = await pool.query(
    `select ${creativeSelect()}
     from ${T.creatives} c
     join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
     where c.${C.brand} = $1 and c.${C.id} = any($2) and m.${M.date} between $3 and $4
     ${creativeGroupBy()}`,
    [ctx.brand, ids, range.start, range.end],
  );

  return {
    result: cap({
      period: `${range.start} to ${range.end}`,
      metrics,
      rows: rows.map((r) => {
        const out = { id: r.id, platforms: r.platforms, format: r.format, origin: r.origin };
        for (const k of metrics) out[k] = round(r[k]);
        return out;
      }),
      missing: ids.filter((id) => !rows.some((r) => String(r.id) === String(id))),
    }),
    records: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

// ---------------------------------------------------------------
// get_lineage
// ---------------------------------------------------------------

async function get_lineage(args, ctx) {
  const pool = ctx.pool || getPool();
  const range = dateRange(args.range_days || ctx.rangeDays);

  const { rows } = await pool.query(
    `with target as (
       select ${C.id} as id, ${C.parentId} as parent_id
       from ${T.creatives} where ${C.brand} = $1 and ${C.id} = $2
     ),
     root as (
       select coalesce((select parent_id from target), (select id from target)) as root_id
     )
     select ${creativeSelect()},
            case when c.${C.id} = (select root_id from root) then 'original' else 'repurposed' end as lineage_role
     from ${T.creatives} c
     join ${T.metrics} m on m.${M.creativeId} = c.${C.id}
     where c.${C.brand} = $1
       and (c.${C.id} = (select root_id from root) or c.${C.parentId} = (select root_id from root))
       and m.${M.date} between $3 and $4
     ${creativeGroupBy()}`,
    [ctx.brand, args.creative_id, range.start, range.end],
  );

  if (!rows.length) {
    return { result: { error: 'No lineage found for that creative in this period.' }, records: {} };
  }

  return {
    result: cap({
      period: `${range.start} to ${range.end}`,
      rows: rows.map((r) => ({
        id: r.id,
        role: r.lineage_role,
        platforms: r.platforms,
        format: r.format,
        ctr: round(r.ctr),
        engagement_rate: round(r.engagement_rate),
        impressions: Number(r.impressions),
      })),
    }),
    records: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

// ---------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------

const handlers = {
  rank_creatives,
  get_creative,
  get_series,
  compare_creatives,
  get_lineage,
};

/**
 * Runs one tool. Never throws to the caller: a tool failure comes back
 * as a result the model can read and recover from, because a thrown
 * error would kill the stream mid-answer.
 */
async function runTool(name, args, ctx) {
  const fn = handlers[name];
  if (!fn) return { result: { error: `Unknown tool: ${name}` }, records: {} };
  try {
    return await fn(args || {}, ctx);
  } catch (err) {
    console.error(`[tool:${name}]`, err.message);
    return {
      result: { error: 'That query could not be run. Tell the user you could not fetch it and suggest rephrasing.' },
      records: {},
    };
  }
}

module.exports = { runTool, handlers, MAX_RESULT_CHARS };

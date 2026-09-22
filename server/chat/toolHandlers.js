/**
 * Ask Lens - tool handlers (v2, reads the dashboard views)
 *
 * Every handler reads the same views the Creative Hub reads and applies
 * the same Meta+TikTok merge. Brand comes from the session, never from
 * the model. Results stay under ~400 tokens.
 */

const S = require('./schema.config');
const V = require('./vocab');
const { getPool } = require('./db');
const { shortName, displayLabel, mergePaid, rankCmp } = require('./snapshot');
const CR = S.creator;

const T = S.tables;
const C = S.creative;
const P = S.paidView;
const MAX_RESULT_CHARS = 1500;

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

function cap(result) {
  const json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_CHARS) return result;
  if (Array.isArray(result.rows)) return { ...result, rows: result.rows.slice(0, 5), truncated: true };
  return { ...result, truncated: true };
}

function validMetric(m) {
  if (!S.rankableMetrics.includes(m)) throw new Error(`Unsupported metric: ${m}`);
  return m;
}

/** Load and merge every boosted creative for a brand, with creative metadata. */
async function loadMerged(pool, brand) {
  const paidSel = `${P.creativeId} as id, ${P.spend} as spend, ${P.reach} as reach,
    ${P.impressions} as impressions, ${P.hookRate} as hook_rate, ${P.holdRate} as hold_rate,
    ${P.hookQ} as hook_q, ${P.holdQ} as hold_q, ${P.vtr} as vtr,
    ${P.avgWatchTime} as avg_watch_time, ${P.cqr} as cqr, ${P.isActive} as is_active,
    ${P.durationS} as duration_s,
    ${P.w25} as w25, ${P.w50} as w50, ${P.w75} as w75, ${P.w100} as w100,
    ${P.verdict} as verdict, ${P.working} as working, ${P.notWorking} as not_working,
    ${P.action} as action, ${P.actionType} as action_type, ${P.priority} as priority,
    ${P.confidence} as confidence, ${P.actionStatus} as action_status`;

  const [cr, meta, tt] = await Promise.all([
    pool.query(
      `select c.${C.id} as id, c.${C.hook} as hook, c.${C.format} as format, c.${C.type} as type,
              c.${C.campaign} as campaign, c.${C.isRepurposed} as is_repurposed, c.${C.parentId} as parent_id,
              c.${C.productRole} as product_role, c.${C.durationS} as duration_s, cr.${CR.name} as creator,
              c.${C.publishedAt} as published_at,
              c.content_intent, c.narrative_structure, c.hook_device, c.hook_subject, c.hook_pace,
              c.opens_with_product, c.opens_with_face, c.has_text_overlay, c.segments,
              c.logo_first_3s, c.captions, c.voiceover, c.music, c.cta, c.language, c.talent, c.production_style, c.aspect_ratio,
              c.time_to_product_s, c.product_screen_pct, c.cuts_per_10s,
              coalesce(c.${C.ttLink}, c.${C.igLink}, c.${C.fbLink}) as permalink
       from ${T.creatives} c
       left join ${T.creators} cr on cr.${CR.id} = c.${C.creatorId}
       where c.${C.brand} = $1`, [brand]),
    pool.query(`select ${paidSel} from ${T.paidMeta} where ${P.brand} = $1 and ${P.creativeId} is not null`, [brand]),
    pool.query(`select ${paidSel} from ${T.paidTiktok} where ${P.brand} = $1 and ${P.creativeId} is not null`, [brand]),
  ]);

  const metaBy = new Map(meta.rows.map((r) => [r.id, { ...r, platform: 'meta' }]));
  const ttBy = new Map(tt.rows.map((r) => [r.id, { ...r, platform: 'tiktok' }]));

  const out = [];
  for (const c of cr.rows) {
    const m = mergePaid(metaBy.get(c.id), ttBy.get(c.id));
    if (!m) continue;
    out.push({
      id: c.id, name: displayLabel(c.id, c.hook), short: shortName(c.id), hook: c.hook,
      format: c.format, type: c.type, campaign: c.campaign, creator: c.creator,
      origin: c.is_repurposed ? 'repurposed' : 'original', parent_id: c.parent_id,
      product_role: c.product_role, duration_s: c.duration_s, permalink: c.permalink,
      published_at: c.published_at, content_intent: c.content_intent,
      narrative_structure: c.narrative_structure, hook_device: c.hook_device,
      hook_subject: c.hook_subject, hook_pace: c.hook_pace,
      opens_with_product: c.opens_with_product, opens_with_face: c.opens_with_face,
      has_text_overlay: c.has_text_overlay, time_to_product_s: c.time_to_product_s, segments: c.segments,
      logo_first_3s: c.logo_first_3s, captions: c.captions, voiceover: c.voiceover, music: c.music, cta: c.cta,
      language: c.language, talent: c.talent, production_style: c.production_style, aspect_ratio: c.aspect_ratio,
      product_screen_pct: c.product_screen_pct, cuts_per_10s: c.cuts_per_10s,
      boosted: true, ...m,
    });
  }
  return out;
}

function floorFor(rows) {
  const total = rows.reduce((s, r) => s + num(r.impressions), 0);
  return Math.max(S.volumeFloor.absoluteMin, Math.round(total * S.volumeFloor.relativeShare));
}

function slim(r, metric) {
  return {
    id: r.id, cqr: r.cqr, hook_rate: r.hook_rate, hook_q: r.hook_q, hold_rate: r.hold_rate, hold_q: r.hold_q,
    platforms: r.platforms, type: r.type, format: r.format, is_active: r.is_active,
    opening_hook: V.label('hook_device', r.hook_device) || null,
    purpose: V.label('content_intent', r.content_intent) || null,
    ...(metric && !['cqr', 'hook_rate', 'hold_rate'].includes(metric) ? { [metric]: r[metric] } : {}),
  };
}

// ---------------------------------------------------------------

async function rank_creatives(args, ctx) {
  const pool = ctx.pool || getPool();
  const metric = validMetric(args.metric || 'cqr');
  const wantBest = (args.direction || 'best') !== 'worst';
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);

  let rows = await loadMerged(pool, ctx.brand);
  const floor = floorFor(rows);
  const excluded = rows.filter((r) => num(r.impressions) < floor).length;
  rows = rows.filter((r) => num(r.impressions) >= floor);

  if (args.platform) rows = rows.filter((r) => (r.platforms || []).includes(args.platform));
  if (args.type) rows = rows.filter((r) => r.type === args.type);
  if (args.format) rows = rows.filter((r) => r.format === args.format);
  if (args.origin) rows = rows.filter((r) => r.origin === args.origin);
  if (args.cqr) rows = rows.filter((r) => r.cqr === args.cqr);
  if (args.campaign) rows = rows.filter((r) => (r.campaign || '').toLowerCase().includes(String(args.campaign).toLowerCase()));
  if (args.creator) rows = rows.filter((r) => (r.creator || '').toLowerCase().includes(String(args.creator).toLowerCase()));
  if (args.active !== undefined) rows = rows.filter((r) => !!r.is_active === !!args.active);
  for (const dim of ['content_intent', 'narrative_structure', 'hook_device', 'hook_subject', 'hook_pace']) {
    if (args[dim]) rows = rows.filter((r) => r[dim] === args[dim]);
  }
  if (args.published_after) rows = rows.filter((r) => r.published_at && String(r.published_at) >= args.published_after);

  // A filtered set below the minimum group size is not reportable as a pattern.
  const { MIN_GROUP } = require('./analytics');
  const belowMinGroup = rows.length > 0 && rows.length < MIN_GROUP;

  if (metric === 'cqr') {
    rows.sort(rankCmp);
  } else {
    rows = rows.filter((r) => r[metric] !== null && r[metric] !== undefined);
    rows.sort((a, b) => num(b[metric]) - num(a[metric]));
  }
  if (!wantBest) rows.reverse();
  rows = rows.slice(0, limit);

  return {
    result: cap({
      ranked_by: metric === 'cqr' ? 'cqr, then hook_rate, then hold_rate' : metric,
      direction: wantBest ? 'best' : 'worst',
      volume_floor_impressions: floor, excluded_below_floor: excluded,
      ...(belowMinGroup ? { sample: `Only ${rows.length} creatives match. Compare them if asked, but say it rests on ${rows.length} creatives and call it an early signal, not a pattern.` } : {}),
      rows: rows.map((r) => slim(r, metric)),
    }),
    records: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

async function get_creative(args, ctx) {
  const pool = ctx.pool || getPool();
  const rows = await loadMerged(pool, ctx.brand);
  const r = rows.find((x) => String(x.id) === String(args.creative_id));
  if (!r) return { result: { error: 'No boosted creative with that id for this brand.' }, records: {} };

  return {
    result: cap({
      id: r.id, name: r.name, cqr: r.cqr, hook_rate: r.hook_rate, hook_q: r.hook_q,
      hold_rate: r.hold_rate, hold_q: r.hold_q, retention_curve: r.retention,
      duration_s: r.duration_s, platforms: r.platforms, type: r.type, format: r.format,
      campaign: r.campaign, creator: r.creator, origin: r.origin, is_active: r.is_active,
      spend: Math.round(r.spend), reach: r.reach, impressions: r.impressions, avg_watch_time: r.avg_watch_time,
      per_platform: r.per_platform,
      tags: V.creativeLabels(r),
      // The full second-by-second timeline, only ever fetched for one creative
      // when someone asks about that video specifically.
      timeline: (Array.isArray(r.segments) ? r.segments : []).map((x) => `${Math.round(Number(x.t))}s ${String(x.d || '').replace(/\s+/g, ' ')}`).join(' / ').slice(0, 1400) || null,
      insights: r.verdict ? { verdict: r.verdict, working: r.working, not_working: r.not_working,
        action: r.action, action_type: r.action_type, priority: r.priority, confidence: r.confidence,
        action_status: r.action_status } : null,
    }),
    records: { [r.id]: r },
  };
}

async function get_series(args, ctx) {
  const pool = ctx.pool || getPool();
  // Only metrics that exist on daily rows. Hook/hold/CQR are view-level.
  const allowed = { spend: 'spend_lkr', reach: 'reach', impressions: 'impressions', video_views: 'video_plays', clicks: 'clicks' };
  const col = allowed[args.metric];
  if (!col) {
    return { result: { error: `Time series is only available for ${Object.keys(allowed).join(', ')}. Hook rate, hold rate and CQR are lifetime scores without a daily series.` }, records: {} };
  }
  const days = Math.min(Math.max(Number(args.range_days) || 30, 2), 180);
  const bucket = args.granularity === 'week' ? "date_trunc('week', date)::date" : 'date';
  const params = [ctx.brand, days];
  let filters = '';
  if (args.platform)    { params.push(args.platform);    filters += ` and platform = $${params.length}`; }
  if (args.creative_id) { params.push(args.creative_id); filters += ` and creative_id = $${params.length}`; }

  const { rows } = await pool.query(
    `select ${bucket} as bucket, sum(${col}) as value
     from ${T.paidDaily}
     where brand_id = $1 and date > current_date - $2::int${filters}
     group by bucket order by bucket`, params);

  const labels = rows.map((r) => (r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : String(r.bucket)));
  const values = rows.map((r) => Math.round(num(r.value)));
  const peakIdx = values.indexOf(Math.max(...values));
  const troughIdx = values.indexOf(Math.min(...values));

  return {
    result: cap({
      metric: args.metric, granularity: args.granularity === 'week' ? 'week' : 'day', days,
      points: values.length, first: values[0] ?? null, last: values[values.length - 1] ?? null,
      direction: values.length > 1 ? (values[values.length - 1] > values[0] ? 'up' : values[values.length - 1] < values[0] ? 'down' : 'flat') : 'unknown',
      peak: peakIdx >= 0 ? { date: labels[peakIdx], value: values[peakIdx] } : null,
      trough: troughIdx >= 0 ? { date: labels[troughIdx], value: values[troughIdx] } : null,
      note: `Reference with [[chart:line|${args.metric}|series]].`,
    }),
    records: {},
    series: { metric: args.metric, labels, values, scope: args.creative_id || args.platform || 'brand' },
  };
}

async function compare_creatives(args, ctx) {
  const pool = ctx.pool || getPool();
  const ids = (args.creative_ids || []).slice(0, 4);
  if (ids.length < 2) throw new Error('compare_creatives needs at least two ids.');
  const rows = (await loadMerged(pool, ctx.brand)).filter((r) => ids.includes(String(r.id)));
  const metrics = (args.metrics && args.metrics.length ? args.metrics : ['cqr', 'hook_rate', 'hold_rate', 'reach']).map(validMetric);
  return {
    result: cap({
      metrics,
      rows: rows.map((r) => { const o = { id: r.id, platforms: r.platforms, type: r.type, format: r.format }; metrics.forEach((k) => { o[k] = r[k]; }); return o; }),
      missing: ids.filter((id) => !rows.some((r) => String(r.id) === id)),
    }),
    records: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

async function get_lineage(args, ctx) {
  const pool = ctx.pool || getPool();
  const all = await loadMerged(pool, ctx.brand);
  const target = all.find((r) => String(r.id) === String(args.creative_id));
  const rootId = target ? (target.parent_id || target.id) : args.creative_id;
  const family = all.filter((r) => String(r.id) === String(rootId) || String(r.parent_id) === String(rootId));
  if (!family.length) return { result: { error: 'No lineage found for that creative.' }, records: {} };
  return {
    result: cap({
      rows: family.map((r) => ({ id: r.id, role: String(r.id) === String(rootId) ? 'original' : 'repurposed', cqr: r.cqr, hook_rate: r.hook_rate, hold_rate: r.hold_rate, platforms: r.platforms, reach: r.reach })),
    }),
    records: Object.fromEntries(family.map((r) => [r.id, r])),
  };
}

const handlers = { rank_creatives, get_creative, get_series, compare_creatives, get_lineage };

async function runTool(name, args, ctx) {
  const fn = handlers[name];
  if (!fn) return { result: { error: `Unknown tool: ${name}` }, records: {} };
  try { return await fn(args || {}, ctx); }
  catch (err) {
    console.error(`[tool:${name}]`, err.message);
    return { result: { error: 'That query could not be run. Tell the user you could not fetch it and suggest rephrasing.' }, records: {} };
  }
}

module.exports = { runTool, handlers, loadMerged, MAX_RESULT_CHARS };

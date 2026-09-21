/**
 * Ask Lens - snapshot generator (v3, full table)
 *
 * One compact line per boosted creative carrying everything the Hub knows:
 * CQR, hook/hold with Strong/Weak qualifiers, retention curve, duration,
 * platforms, type, format, campaign, creator, active flag, spend, reach,
 * and the structured Insights diagnosis. Plus rollups, organic, boost
 * workflow, and the brand's own benchmarks.
 *
 * Reads the same views creatives.js reads and applies its merge rules.
 */

const crypto = require('crypto');
const S = require('./schema.config');
const { getPool } = require('./db');

// Bump this whenever the digest format or the records shape changes.
// Stored snapshots with a different schema version rebuild on next use.
const SNAPSHOT_SCHEMA_VERSION = 3;

const T = S.tables, C = S.creative, P = S.paidView, O = S.organicView, OR = S.organicRawCols;
const OB = S.organicBest, B = S.boost, TH = S.thresholds, CR = S.creator;

function assertBrand(b) { if (!S.brands.includes(b)) throw new Error(`Unknown brand: ${b}`); return b; }
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const r0 = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
// Retention points are percentages. Anything outside 0-100 is a bad row, not a signal.
const pctPt = (v) => { if (v === null || v === undefined) return null; const n = Number(v); return isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null; };
const fmtCount = (v) => { if (v === null || v === undefined) return 'n/a'; const n = Number(v); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)); };
const fmtPct = (v, d = 1) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(d)}%`);
const money = (v) => (v === null || v === undefined ? 'n/a' : `${fmtCount(v)} ${S.currency}`);
const avg = (xs) => { const a = xs.filter((v) => v !== null && v !== undefined); return a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null; };
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');

function shortName(id) {
  const m = String(id).match(/Video(\d+)_(BrandSay|OthersSay)/);
  if (m) return `Video${m[1]} ${m[2] === 'BrandSay' ? 'Brand Say' : 'Others Say'}`;
  const parts = String(id).split('_');
  return parts.length >= 4 ? `${parts[1]} · ${parts[2]} · ${parts[3]}` : String(id);
}
/** Human label: first words of the content hook, falling back to the id. */
function displayLabel(id, hook) {
  const words = clip(hook, 200).split(' ').filter(Boolean);
  if (words.length >= 3) return words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : '');
  return shortName(id);
}
function bestCqr(list) { return list.filter(Boolean).sort((a, b) => (S.cqrRank[a] ?? 9) - (S.cqrRank[b] ?? 9))[0] || 'Invalid'; }
function rankCmp(a, b) {
  const c = (S.cqrRank[a.cqr] ?? 9) - (S.cqrRank[b.cqr] ?? 9); if (c) return c;
  const h = num(b.hook_rate) - num(a.hook_rate); if (h) return h;
  return num(b.hold_rate) - num(a.hold_rate);
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

async function qCreatives(pool, brand) {
  const { rows } = await pool.query(
    `select c.${C.id} as id, c.${C.hook} as hook, c.${C.format} as format, c.${C.productRole} as product_role,
            c.${C.type} as type, c.${C.campaign} as campaign, c.${C.isRepurposed} as is_repurposed,
            c.${C.parentId} as parent_id, c.${C.publishedAt} as published_at, c.${C.durationS} as duration_s,
            c.content_intent, c.narrative_structure, c.hook_device, c.hook_subject, c.hook_pace,
            c.opens_with_product, c.opens_with_face, c.has_text_overlay,
            c.timeline_attrs, c.time_to_product_s, c.product_screen_pct, c.cuts_per_10s,
            cr.${CR.name} as creator,
            coalesce(c.${C.ttLink}, c.${C.igLink}, c.${C.fbLink}) as permalink
     from ${T.creatives} c
     left join ${T.creators} cr on cr.${CR.id} = c.${C.creatorId}
     where c.${C.brand} = $1`, [brand]);
  return new Map(rows.map((r) => [r.id, r]));
}

async function qPaid(pool, view, brand, platform) {
  const { rows } = await pool.query(
    `select ${P.creativeId} as id, ${P.spend} as spend, ${P.reach} as reach, ${P.impressions} as impressions,
            ${P.hookRate} as hook_rate, ${P.holdRate} as hold_rate, ${P.hookQ} as hook_q, ${P.holdQ} as hold_q,
            ${P.vtr} as vtr, ${P.avgWatchTime} as avg_watch_time, ${P.cqr} as cqr, ${P.isActive} as is_active,
            ${P.durationS} as duration_s, ${P.w25} as w25, ${P.w50} as w50, ${P.w75} as w75, ${P.w100} as w100,
            ${P.verdict} as verdict, ${P.working} as working, ${P.notWorking} as not_working,
            ${P.action} as action, ${P.actionType} as action_type, ${P.priority} as priority,
            ${P.confidence} as confidence, ${P.actionStatus} as action_status
     from ${view} where ${P.brand} = $1 and ${P.creativeId} is not null`, [brand]);
  return rows.map((r) => ({ ...r, platform }));
}

async function qOrganic(pool, brand) {
  const { rows } = await pool.query(
    `select o.${OR.creativeId} as id, o.${OR.platform} as platform, o.${OR.views} as views, o.${OR.reach} as reach,
            o.${OR.totalInteractions} as total_interactions, s.${O.cqr} as cqr,
            s.${O.engagementRate} as engagement_rate, s.${O.retentionRate} as retention_rate
     from ${T.organicRaw} o
     join ${T.creatives} c on c.${C.id} = o.${OR.creativeId}
     left join ${T.organicScored} s on s.${O.creativeId} = o.${OR.creativeId} and s.${O.platform} = o.${OR.platform}
     where c.${C.brand} = $1`, [brand]);
  return rows;
}

async function qBoost(pool, brand) {
  const { rows } = await pool.query(
    `select ob.${OB.creativeId} as id, ob.${OB.bestCqr} as best_cqr, ob.${OB.isValidated} as is_validated,
            bs.${B.isBoosted} as is_boosted, bs.${B.onMeta} as on_meta, bs.${B.onTiktok} as on_tiktok
     from ${T.organicBest} ob
     left join ${T.boostStatus} bs on bs.${B.creativeId} = ob.${OB.creativeId}
     where ob.${OB.brand} = $1`, [brand]);
  return rows;
}

async function qThresholds(pool, brand) {
  const { rows } = await pool.query(
    `select ${TH.platform} as platform, ${TH.metric} as metric, ${TH.minDur} as min_dur, ${TH.maxDur} as max_dur,
            ${TH.poorLt} as poor_lt, ${TH.goodGte} as good_gte
     from ${T.thresholds} where ${TH.brand} = $1
     order by platform, metric, min_dur`, [brand]);
  return rows;
}

async function qMonthly(pool, brand) {
  const { rows } = await pool.query(
    `select month::text as month, act_spend, act_reach, act_impressions, act_frequency, act_engagement_rate,
            kpi_spend, kpi_reach, kpi_impressions, kpi_frequency, kpi_engagement_rate
     from ${T.accountMonthly} where brand_id = $1 order by month desc limit 3`, [brand]);
  return rows.reverse();
}

async function qFreshness(pool, brand) {
  const { rows } = await pool.query(
    `select max(date)::text as max_date, count(*) as row_count from ${T.paidDaily} where brand_id = $1`, [brand]);
  return rows[0] || { max_date: null, row_count: 0 };
}

// ---------------------------------------------------------------
// Merge, mirroring creatives.js
// ---------------------------------------------------------------

function mergePaid(meta, tt) {
  const both = [meta, tt].filter(Boolean);
  if (!both.length) return null;
  const pick = (f) => both.map((x) => x[f]);
  const primary = meta || tt;
  return {
    platforms: both.map((x) => x.platform),
    cqr: bestCqr(pick('cqr')),
    hook_rate: r1(avg(pick('hook_rate'))), hold_rate: r1(Math.max(...pick('hold_rate').map(num))),
    hook_q: primary.hook_q || '', hold_q: primary.hold_q || '',
    vtr: r1(avg(pick('vtr'))), avg_watch_time: r1(avg(pick('avg_watch_time'))),
    spend: pick('spend').reduce((s, v) => s + num(v), 0),
    reach: Math.max(...pick('reach').map(num)),
    impressions: pick('impressions').reduce((s, v) => s + num(v), 0),
    is_active: both.some((x) => x.is_active),
    retention: [100, pctPt(primary.hook_rate), pctPt(primary.w25), pctPt(primary.w50), pctPt(primary.w75), pctPt(primary.w100)],
    verdict: primary.verdict || '', working: primary.working || '', not_working: primary.not_working || '',
    action: primary.action || '', action_type: primary.action_type || '', priority: primary.priority || '',
    confidence: primary.confidence || '', action_status: primary.action_status || '',
    per_platform: Object.fromEntries(both.map((x) => [x.platform, {
      cqr: x.cqr, hook_rate: r1(x.hook_rate), hold_rate: r1(x.hold_rate), hook_q: x.hook_q, hold_q: x.hold_q,
      spend: num(x.spend), reach: num(x.reach), impressions: num(x.impressions), is_active: !!x.is_active,
      retention: [100, pctPt(x.hook_rate), pctPt(x.w25), pctPt(x.w50), pctPt(x.w75), pctPt(x.w100)],
    }])),
  };
}

// ---------------------------------------------------------------
// Digest
// ---------------------------------------------------------------

const A = require('./analytics');
const V = require('./vocab');

const gname = (g) => (g.name && g.name !== g.key ? `${g.name} [${g.key}]` : g.key);
const singleRating = (g) => (g.good ? 'Good' : g.average ? 'Average' : g.poor ? 'Poor' : 'unrated');
const vsText = (vs) => (vs ? `CQR ${vs.cqr}, hook ${vs.hook}, hold ${vs.hold}` : 'no comparison');
const hedge = (g) => (g.early ? ' (early sign)' : '');

// Groups are described by how they compare with the brand overall on CQR,
// hook and hold. No counts or percentages: the team wants the comparison.
const fmtGroup = (g) => g.tooFew
  ? `${gname(g)}: one example only, rated ${singleRating(g)}. Not enough to compare.`
  : `${gname(g)}: ${vsText(g.vs)}${hedge(g)}.`;

function renderDim(L, d) {
  if (!d || !d.groups.length) return;
  L.push(`${d.dimension.toUpperCase()} (each compared with the brand overall)`);
  d.groups.forEach((g) => L.push('  ' + fmtGroup(g)));
  const ld = d.leaders;
  if (ld) {
    const n = (x) => `${x.name}${x.early ? ' (early sign)' : ''}`;
    L.push(`  Leads on CQR: ${n(ld.cqr)}. Best hook: ${n(ld.hook)}. Best hold: ${n(ld.hold)}. Weakest on CQR: ${n(ld.weakestCqr)}.`);
  } else {
    L.push('  Only one group has more than a single creative, so there is nothing to compare it with yet.');
  }
  L.push('');
}

function creativeLine(c) {
  const plats = (c.platforms || []).map((p) => S.platformLabels[p] || p).join('+');
  const ret = (c.retention || []).map((v) => (v === null ? '-' : v)).join('/');
  const attrs = [
    c.hook_device && `hook: ${V.label('hook_device', c.hook_device)}`,
    c.content_intent && `purpose: ${V.label('content_intent', c.content_intent)}`,
    c.narrative_structure && `structure: ${V.label('narrative_structure', c.narrative_structure)}`,
  ].filter(Boolean).join(', ');
  const bits = [
    c.id, c.cqr,
    `hook ${fmtPct(c.hook_rate)}${c.hook_q ? ' ' + c.hook_q : ''}`,
    `hold ${fmtPct(c.hold_rate)}${c.hold_q ? ' ' + c.hold_q : ''}`,
    `ret ${ret}`,
    c.duration_s ? `${Math.round(c.duration_s)}s` : null,
    plats, V.label('type', c.type) || null, V.label('format', c.format) || 'Unclassified',
    attrs || null,
    c.creator ? `creator:${clip(c.creator, 20)}` : null,
    c.is_active ? 'ACTIVE' : 'STOPPED',
    `spend ${fmtCount(c.spend)}`,
  ].filter(Boolean);
  const lines = [bits.join(' | ')];
  if (c.working || c.not_working || c.action) {
    const d = [];
    if (c.working) d.push(`works: ${clip(c.working, 90)}`);
    if (c.not_working) d.push(`not: ${clip(c.not_working, 90)}`);
    if (c.action) d.push(`do: ${clip(c.action, 90)}${c.priority ? ` [${c.priority}]` : ''}`);
    lines.push('    ' + d.join(' | '));
  }
  return lines.join('\n');
}

function compactLine(c) {
  const attrs = [V.label('hook_device', c.hook_device), V.label('content_intent', c.content_intent)].filter(Boolean).join(', ');
  return `${c.id} | ${c.cqr} | h${fmtPct(c.hook_rate)} | ${fmtPct(c.hold_rate)} | ${(c.platforms || []).map((x) => V.label('platform', x)).join('+')} | ${V.label('type', c.type) || ''} | ${attrs} | ${c.is_active ? 'A' : 'S'}`;
}

/** Renders the analytics object. No computation happens here. */
function renderDigest(an, insights) {
  const label = S.brandLabels[an.brand] || an.brand;
  const L = [];

  L.push(`BRAND: ${label} | lifetime per creative | paid data through ${an.freshness.max_date || 'unknown'}`);
  L.push('');

  // Benchmarks first: they define what every number below means.
  if (an.thresholds.length || an.monthly.length) {
    L.push('BENCHMARKS (this brand\'s own, the only benchmarks that exist)');
    for (const t of an.thresholds) {
      const dur = (t.min_dur !== null || t.max_dur !== null) ? ` ${num(t.min_dur)}-${t.max_dur === null ? 'inf' : num(t.max_dur)}s` : '';
      L.push(`  ${S.platformLabels[t.platform] || t.platform} ${t.metric}${dur}: Poor below ${fmtPct(t.poor_lt)}, Good from ${fmtPct(t.good_gte)}`);
    }
    const m = an.monthly[an.monthly.length - 1];
    if (m) L.push(`  Monthly plan ${m.month.slice(0, 7)}: spend ${money(m.kpi_spend)}, reach ${fmtCount(m.kpi_reach)}, ER ${fmtPct(m.kpi_engagement_rate, 2)}`);
    L.push('');
  }

  if (insights && insights.length) {
    L.push('VERIFIED FINDINGS (computed and checked against the data; cite these for why and what-next questions)');
    insights.forEach((i, n) => L.push(`  ${n + 1}. ${i.body}`));
    L.push('');
  }

  L.push('TOTALS');
  L.push(`  ${an.totals.creatives} boosted creatives, ${an.totals.active} active | spend ${money(an.totals.spend)} | reach ${fmtCount(an.totals.reach)} | impressions ${fmtCount(an.totals.impressions)}`);
  L.push(`  CQR mix: ${an.cqrMix.Good} Good, ${an.cqrMix.Average} Average, ${an.cqrMix.Poor} Poor, ${an.cqrMix.Invalid} Invalid`);
  L.push(`  Spend by CQR: Good ${money(an.spendByCqr.Good)} | Average ${money(an.spendByCqr.Average)} | Poor ${money(an.spendByCqr.Poor)}`);
  L.push(`  Brand avg hook ${fmtPct(an.totals.hook_rate)} (${an.totals.strongHookShare}% Strong) | avg hold ${fmtPct(an.totals.hold_rate)} (${an.totals.strongHoldShare}% Strong)`);
  L.push(`  Poor creatives: ${an.poorSplit.activeCount} still running on ${money(an.poorSplit.activeSpend)} (current waste), ${an.poorSplit.stoppedCount} stopped after ${money(an.poorSplit.stoppedSpend)} (past spend, already addressed)`);
  if (an.hookHold.mostlyLose) L.push(`  Where creatives lose people: ${an.hookHold.mostlyLose}.${an.hookHold.manyWeakOnBoth ? ' Many creatives are weak on both hook and hold.' : ''}`);
  L.push('');

  if (an.discriminating.length) {
    L.push('WHAT ACTUALLY SEPARATES PERFORMANCE (ranked by how much)');
    an.discriminating.forEach((d) => L.push(`  ${d.dimension}: ${d.best} leads, ${d.worst} trails${d.early ? ' (early sign, small groups)' : ''}.`));
    L.push('  Ranked by CQR first, then hook, then hold. A better hook alone does not make a group better.');
    L.push('  Dimensions not listed here do not separate performance meaningfully.');
    L.push('');
  }

  if (an.anomalies.length) {
    L.push('NEEDS A DECISION');
    an.anomalies.forEach((a) => L.push(`  ${a.note}: ${a.n}${a.spend ? `, ${money(a.spend)} lifetime spend` : ''} (${a.ids.join(', ')})`));
    L.push('');
  }

  renderDim(L, an.dims.hook_device);
  renderDim(L, an.dims.content_intent);
  renderDim(L, an.dims.narrative_structure);
  renderDim(L, an.dims.format);
  renderDim(L, an.dims.type);
  renderDim(L, an.dims.platform);
  renderDim(L, an.dims.hook_subject);
  renderDim(L, an.dims.hook_pace);
  renderDim(L, an.dims.product_role);
  renderDim(L, an.dims.opens_with_face);
  renderDim(L, an.dims.opens_with_product);
  renderDim(L, an.dims.has_text_overlay);
  renderDim(L, an.dims.origin);
  renderDim(L, an.dims.campaign);
  renderDim(L, an.dims.creator);

  if (an.crosstabs.length) {
    L.push('CROSSTABS (only cells with enough creatives are shown)');
    an.crosstabs.forEach((x) => {
      L.push(`  ${x.dimensions.join(' x ')}:`);
      x.cells.slice(0, 8).forEach((c) => L.push(`    ${c.aName || c.a} + ${c.bName || c.b}: ${vsText(c.vs)}${c.early ? ' (early sign)' : ''}`));
      if (x.suppressed) L.push('    Combinations with a single creative are not shown.');
    });
    L.push('');
  }

  const rt = an.retention;
  if (rt.drops.length) {
    L.push('RETENTION PATTERNS');
    const seg = Object.entries(rt.dropBySegment).sort((a, b) => b[1] - a[1])[0];
    if (seg) L.push(`  Most creatives lose the most viewers between ${seg[0]} (${seg[1]} of ${rt.drops.length}).`);
    const scr = Object.entries(rt.dropByScreen).sort((a, b) => b[1] - a[1])[0];
    if (scr) L.push(`  At the biggest drop, what is on screen most often: ${scr[0]} (${scr[1]} creatives).`);
    if (rt.productTiming.avgTimeToProduct !== null) L.push(`  Product first appears at ${rt.productTiming.avgTimeToProduct}s on average, on screen ${rt.productTiming.avgProductScreenPct}% of runtime, ${rt.productTiming.avgCutsPer10s} cuts per 10s.`);
    L.push('');
  }

  L.push(`TOP ${an.top.length} (CQR, then hook, then hold)`);
  an.top.forEach((c) => L.push(creativeLine(c)));
  L.push('');
  L.push(`BOTTOM ${an.bottom.length}`);
  an.bottom.forEach((c) => L.push(creativeLine(c)));
  L.push('');

  const indexed = an.ranked.slice(10, 10 + 60);
  if (indexed.length) {
    L.push(`INDEX, next ${indexed.length} by rank (compact: id | CQR | hook | hold | platforms | type | hook_device/intent | Active or Stopped)`);
    indexed.forEach((c) => L.push('  ' + compactLine(c)));
    const rest = an.ranked.length - 10 - indexed.length;
    if (rest > 0) L.push(`  ${rest} further creatives are in the rollups above. Use rank_creatives to reach them individually.`);
    L.push('');
  }

  const o = an.organic;
  if (o.posts) {
    L.push('ORGANIC (lifetime per post, not date filtered)');
    L.push(`  ${o.posts} posts | views ${fmtCount(o.views)} | ${o.good} Good / ${o.average} Average / ${o.poor} Poor`);
    o.byPlatform.forEach((p) => L.push(`  ${S.platformLabels[p.platform] || p.platform}: ${p.tooFew ? 'one post only, not comparable' : `CQR ${p.vs.cqr}, engagement ${p.vs.engagement} than organic overall${p.early ? ' (early sign)' : ''}`}`));
    L.push('  Top organic: ' + o.top.map((t) => `${t.id} (${t.cqr || 'unscored'}, ${fmtCount(t.views)} views)`).join(', '));
    L.push('');
  }

  L.push('BOOST WORKFLOW');
  L.push(an.validatedUnboosted.length
    ? `  Validated but not boosted (${an.validatedUnboosted.length}): ${an.validatedUnboosted.map((v) => `${v.id} (${v.best_cqr})`).join(', ')}`
    : '  Every validated organic post is boosted.');
  L.push('');

  if (an.monthly.length) {
    L.push('MONTHLY, actual vs plan');
    an.monthly.forEach((m) => L.push(`  ${m.month.slice(0, 7)}: spend ${money(m.act_spend)} vs ${money(m.kpi_spend)} | reach ${fmtCount(m.act_reach)} vs ${fmtCount(m.kpi_reach)} | ER ${fmtPct(m.act_engagement_rate, 2)} vs ${fmtPct(m.kpi_engagement_rate, 2)}`));
    L.push('');
  }

  L.push('RULES APPLIED TO EVERYTHING ABOVE');
  L.push('  Groups are compared with the brand overall on CQR, hook and hold: stronger, similar or weaker.');
  L.push('  Talk about groups in those words. Do not give counts or percentages for groups.');
  L.push('  CQR matters most, then hook, then hold. A stronger hook alone does not make a group better.');
  L.push('  "Early sign" marks a small group: say it is an early sign, never a pattern or a rule.');
  L.push('  "One example only" is a single creative: describe it, never treat it as proof a type works.');
  L.push(`  Creatives under ${fmtCount(an.floor)} lifetime impressions are excluded from rankings; ${an.excluded} excluded.`);
  L.push('  Every number above is computed in code. Do not recalculate, average or estimate anything.');
  L.push('');
  L.push('NOT HERE: daily series for hook, hold or CQR (they are lifetime scores). Per-creative organic detail. Any brand other than ' + label + '. Call a tool or say it is not available.');

  return L.join('\n');
}

// ---------------------------------------------------------------
// Build
// ---------------------------------------------------------------

async function buildSnapshot(brand, _r, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const [creatives, metaRows, ttRows, organicRows, boostRows, thresholds, monthly, freshness] = await Promise.all([
    qCreatives(pool, brand), qPaid(pool, T.paidMeta, brand, 'meta'), qPaid(pool, T.paidTiktok, brand, 'tiktok'),
    qOrganic(pool, brand), qBoost(pool, brand), qThresholds(pool, brand), qMonthly(pool, brand), qFreshness(pool, brand),
  ]);
  const metaBy = new Map(metaRows.map((r) => [r.id, r])), ttBy = new Map(ttRows.map((r) => [r.id, r]));
  const boostBy = new Map(boostRows.map((r) => [r.id, r]));

  const paid = [], records = {};
  for (const [id, c] of creatives) {
    const m = mergePaid(metaBy.get(id), ttBy.get(id));
    const bs = boostBy.get(id);
    const rec = {
      id, name: displayLabel(id, c.hook), short: shortName(id), hook: c.hook, format: c.format,
      product_role: c.product_role, type: c.type, campaign: c.campaign, creator: c.creator,
      origin: c.is_repurposed ? 'repurposed' : 'original', parent_id: c.parent_id,
      published_at: c.published_at, duration_s: c.duration_s ?? (m && m.duration_s), permalink: c.permalink,
      content_intent: c.content_intent, narrative_structure: c.narrative_structure,
      hook_device: c.hook_device, hook_subject: c.hook_subject, hook_pace: c.hook_pace,
      opens_with_product: c.opens_with_product, opens_with_face: c.opens_with_face,
      has_text_overlay: c.has_text_overlay, timeline_attrs: c.timeline_attrs,
      time_to_product_s: c.time_to_product_s, product_screen_pct: c.product_screen_pct,
      cuts_per_10s: c.cuts_per_10s,
      boosted: !!m, is_validated: !!(bs && bs.is_validated), organic_best_cqr: bs ? bs.best_cqr : null,
      ...(m || {}),
    };
    rec.labels = V.creativeLabels(rec);
    records[id] = rec;
    if (m) paid.push(rec);
  }

  const organic = organicRows.map((o) => ({
    id: o.id, platform: o.platform, views: num(o.views), reach: num(o.reach),
    total_interactions: num(o.total_interactions), cqr: o.cqr,
    engagement_rate: r1(o.engagement_rate), retention_rate: r1(o.retention_rate),
  }));
  for (const o of organic) {
    if (!records[o.id]) continue;
    records[o.id].organic = records[o.id].organic || {};
    records[o.id].organic[o.platform] = o;
  }

  // Everything computable is computed here, in code.
  const an = A.build({ brand, paid, organic, boost: boostRows, thresholds, monthly, freshness });

  const version = crypto.createHash('sha256')
    .update([brand, freshness.max_date, freshness.row_count, paid.length, organic.length, boostRows.length].join('|'))
    .digest('hex').slice(0, 12);

  // Verified findings from the previous run of this same data version.
  let insights = [];
  try {
    const { rows } = await pool.query(
      `select body from brand_insights where brand = $1 and snapshot_ver = $2 and verified = true order by id`,
      [brand, version]);
    insights = rows;
  } catch (e) { /* table may not exist yet */ }

  const body = renderDigest(an, insights);

  // Cohort records so [[cohort:...]] markers resolve to real numbers.
  for (const [field, d] of Object.entries(an.dims)) {
    if (!d || !d.groups) continue;
    const kind = field;
    for (const g of d.groups) records[`cohort:${kind}:${g.key}`] = { id: `cohort:${kind}:${g.key}`, kind, ...g };
  }
  for (const p of S.platforms) {
    const g = an.dims.platform.groups.find((x) => x.key === p);
    if (g) records[`cohort:platform:${p}`] = { id: `cohort:platform:${p}`, kind: 'platform', ...g };
  }

  records.brand = { id: 'brand', name: S.brandLabels[brand], ...an.totals, cqr_mix: an.cqrMix };
  records.__meta = { freshness: freshness.max_date, generated_at: new Date().toISOString(), minGroup: an.minGroup };
  records.__analytics = an;

  return {
    brand, range_days: 0, period_start: '1970-01-01',
    period_end: freshness.max_date || new Date().toISOString().slice(0, 10),
    version, body, records, analytics: an,
    token_estimate: Math.ceil(body.length / 3.6), floor: an.floor,
  };
}

async function generateAndStore(brand, r, opts = {}) {
  const pool = opts.pool || getPool();
  const s = await buildSnapshot(brand, r, opts);
  const { rows } = await pool.query(
    `insert into brand_snapshots (brand, range_days, period_start, period_end, version, body, records, token_estimate)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (brand, range_days, version) do update set body = excluded.body, records = excluded.records, period_end = excluded.period_end, generated_at = now()
     returning *`,
    [s.brand, s.range_days, s.period_start, s.period_end, s.version, s.body, JSON.stringify(s.records), s.token_estimate]);
  return rows[0];
}

/**
 * Returns the current snapshot for a brand, rebuilding it first if the
 * underlying data has moved on or the digest format has changed.
 *
 * The staleness check is one cheap query (max date + row count on the
 * daily view). If it matches what the stored snapshot was built from,
 * the stored one is served. Otherwise it rebuilds in place and, unless
 * told not to, kicks off a background pre-warm for this brand.
 */
async function getSnapshot(brand, _r, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const { rows } = await pool.query(`select * from brand_snapshots where brand = $1 and range_days = 0 order by generated_at desc limit 1`, [brand]);
  const stored = rows[0] || null;

  let fresh;
  try { fresh = await qFreshness(pool, brand); } catch (e) { fresh = null; }

  const meta = (stored && stored.records && stored.records.__meta) || {};
  const upToDate = stored
    && meta.schema === SNAPSHOT_SCHEMA_VERSION
    && fresh
    && meta.freshness === fresh.max_date
    && Number(meta.row_count) === Number(fresh.row_count);

  if (upToDate) return stored;

  const rebuilt = await generateAndStore(brand, 0, { pool });

  // Warm the starter answers for this brand without blocking the caller.
  if (!opts.noPrewarm) {
    setImmediate(() => {
      try {
        const { prewarmBrand } = require('./prewarm');
        prewarmBrand(brand, { pool, quiet: true }).catch((e) => console.error('[prewarm]', brand, e.message));
      } catch (e) { /* prewarm module optional */ }
    });
  }
  return rebuilt;
}

async function warmAll(opts = {}) {
  const pool = opts.pool || getPool();
  const results = [];
  for (const brand of S.brands) {
    try { const row = await generateAndStore(brand, 0, { pool }); results.push({ brand, version: row.version, tokens: row.token_estimate }); }
    catch (err) { console.error(`[snapshot] ${brand} failed:`, err.message); results.push({ brand, error: err.message }); }
  }
  await pool.query('select prune_answer_cache()');
  if (!opts.quiet) console.table(results);
  return results;
}

module.exports = { buildSnapshot, generateAndStore, getSnapshot, warmAll, assertBrand, shortName, displayLabel, mergePaid, rankCmp, SNAPSHOT_SCHEMA_VERSION };

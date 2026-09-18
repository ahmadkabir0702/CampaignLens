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

function rollup(rows, keyFn) {
  const out = {};
  for (const c of rows) {
    const k = keyFn(c) || 'unclassified';
    const g = (out[k] = out[k] || { n: 0, spend: 0, reach: 0, hooks: [], holds: [], good: 0, avg: 0, poor: 0, active: 0 });
    g.n++; g.spend += num(c.spend); g.reach += num(c.reach); g.hooks.push(c.hook_rate); g.holds.push(c.hold_rate);
    if (c.cqr === 'Good') g.good++; else if (c.cqr === 'Average') g.avg++; else if (c.cqr === 'Poor') g.poor++;
    if (c.is_active) g.active++;
  }
  for (const g of Object.values(out)) { g.hook_rate = r1(avg(g.hooks)); g.hold_rate = r1(avg(g.holds)); delete g.hooks; delete g.holds; }
  return out;
}

function creativeLine(c) {
  const plats = (c.platforms || []).map((p) => S.platformLabels[p] || p).join('+');
  const ret = (c.retention || []).map((v) => (v === null ? '-' : v)).join('/');
  const bits = [
    c.id, c.cqr,
    `hook ${fmtPct(c.hook_rate)}${c.hook_q ? ' ' + c.hook_q : ''}`,
    `hold ${fmtPct(c.hold_rate)}${c.hold_q ? ' ' + c.hold_q : ''}`,
    `ret ${ret}`,
    c.duration_s ? `${Math.round(c.duration_s)}s` : null,
    plats, c.type || null, c.format || 'unclassified',
    c.campaign ? `camp:${clip(c.campaign, 30)}` : null,
    c.creator ? `creator:${clip(c.creator, 24)}` : null,
    c.is_active ? 'ACTIVE' : 'STOPPED',
    `spend ${fmtCount(c.spend)}`, `reach ${fmtCount(c.reach)}`,
    c.origin === 'repurposed' ? `repurposed of ${c.parent_id || '?'}` : null,
  ].filter(Boolean);
  const lines = [bits.join(' | ')];
  if (c.working || c.not_working || c.action) {
    const d = [];
    if (c.working) d.push(`works: ${clip(c.working, 90)}`);
    if (c.not_working) d.push(`not: ${clip(c.not_working, 90)}`);
    if (c.action) d.push(`do: ${clip(c.action, 90)}${c.priority ? ` [${c.priority}]` : ''}${c.action_status ? ` (${c.action_status})` : ''}`);
    lines.push('    ' + d.join(' | '));
  }
  return lines.join('\n');
}

function renderDigest(x) {
  const label = S.brandLabels[x.brand] || x.brand;
  const L = [];
  L.push(`SNAPSHOT: ${label} | lifetime per creative | paid data through ${x.freshness.max_date || 'unknown'}`);
  L.push('');
  L.push('HOW TO RANK');
  L.push('Best performing means best CQR first, then hook rate, then hold rate. Then engagement rate, reach, video views.');
  L.push('Strong/Weak next to hook and hold are this brand\'s own duration-aware judgments. Use those words.');
  L.push('CTR, VTR, CPM, CPC are vanity here: never volunteer them.');
  L.push('');

  if (x.thresholds.length || x.monthly.length) {
    L.push(`BENCHMARKS (this brand's own, the only benchmarks you may cite)`);
    for (const t of x.thresholds) {
      const dur = (t.min_dur !== null || t.max_dur !== null) ? ` for ${num(t.min_dur)}-${t.max_dur === null ? '∞' : num(t.max_dur)}s` : '';
      L.push(`${S.platformLabels[t.platform] || t.platform} ${t.metric}${dur}: Poor below ${fmtPct(t.poor_lt)}, Good from ${fmtPct(t.good_gte)}`);
    }
    const m = x.monthly[x.monthly.length - 1];
    if (m) L.push(`Monthly plan ${m.month.slice(0, 7)}: spend ${money(m.kpi_spend)}, reach ${fmtCount(m.kpi_reach)}, impressions ${fmtCount(m.kpi_impressions)}, frequency ${m.kpi_frequency ?? 'n/a'}, ER ${fmtPct(m.kpi_engagement_rate, 2)}`);
    L.push('');
  }

  L.push('PAID TOTALS');
  L.push(`${x.paid.length} boosted creatives (${x.activeCount} active) | spend ${money(x.totals.spend)} | reach ${fmtCount(x.totals.reach)} | impressions ${fmtCount(x.totals.impressions)}`);
  L.push(`CQR mix: ${x.cqrMix.Good} Good, ${x.cqrMix.Average} Average, ${x.cqrMix.Poor} Poor, ${x.cqrMix.Invalid} Invalid`);
  L.push(`Spend by CQR: Good ${money(x.spendByCqr.Good)} | Average ${money(x.spendByCqr.Average)} | Poor ${money(x.spendByCqr.Poor)}`);
  L.push(`Poor and still ACTIVE: ${x.poorActive.length} creatives, ${money(x.poorActiveSpend)} lifetime spend`);
  L.push(`Brand avg hook ${fmtPct(x.totals.hook_rate)} | avg hold ${fmtPct(x.totals.hold_rate)}`);
  L.push('');

  L.push(`ALL BOOSTED CREATIVES, ranked (CQR, hook, hold)${x.tableNote}`);
  L.push('Format: id | CQR | hook | hold | ret 0s/hook/25%/50%/75%/100% | duration | platforms | type | format | campaign | creator | status | spend | reach');
  x.table.forEach((c) => L.push(creativeLine(c)));
  L.push('');

  const roll = (title, obj, labelFn) => {
    const keys = Object.keys(obj); if (!keys.length) return;
    L.push(title);
    for (const k of keys) { const g = obj[k]; L.push(`${labelFn ? labelFn(k) : k}: ${g.n} creatives (${g.active} active), spend ${money(g.spend)}, avg hook ${fmtPct(g.hook_rate)}, avg hold ${fmtPct(g.hold_rate)}, ${g.good} Good / ${g.avg} Avg / ${g.poor} Poor`); }
    L.push('');
  };
  roll('BY PLATFORM (paid)', x.byPlatform, (k) => S.platformLabels[k] || k);
  roll('BY TYPE (paid)', x.byType);
  roll('BY FORMAT (paid)', x.byFormat);
  roll('BY CAMPAIGN (paid)', x.byCampaign);
  if (Object.keys(x.byCreator).length) roll('BY CREATOR (Others Say, paid)', x.byCreator);

  if (x.organic.length) {
    L.push('ORGANIC (lifetime per post, not date filtered)');
    L.push(`${x.organicSummary.n} posts | views ${fmtCount(x.organicSummary.views)} | reach ${fmtCount(x.organicSummary.reach)} | CQR ${x.organicSummary.good} Good / ${x.organicSummary.avg} Average / ${x.organicSummary.poor} Poor`);
    for (const p of S.organicPlatforms) { const s = x.organicByPlatform[p]; if (s && s.n) L.push(`${S.platformLabels[p]}: ${s.n} posts, views ${fmtCount(s.views)}, avg ER ${fmtPct(s.engagement_rate, 2)}, ${s.good} Good`); }
    L.push('Top organic by CQR then views:');
    x.organicTop.forEach((o) => L.push(`${o.id} | ${o.platform} | ${o.cqr || 'unscored'} | views ${fmtCount(o.views)} | ER ${fmtPct(o.engagement_rate, 2)} | retention ${fmtPct(o.retention_rate)}`));
    L.push('');
  }

  L.push('BOOST WORKFLOW');
  if (x.validatedUnboosted.length) {
    L.push(`Validated organic posts NOT yet boosted (${x.validatedUnboosted.length}): ${x.validatedUnboosted.map((v) => `${v.id} (${v.best_cqr})`).join(', ')}`);
    L.push('The dashboard flags these after 48h. These are the boost candidates.');
  } else L.push('Every validated organic post is boosted.');
  L.push('');

  if (x.monthly.length) {
    L.push('BRAND MONTHLY, actual vs plan (KPI tab)');
    x.monthly.forEach((m) => L.push(`${m.month.slice(0, 7)}: spend ${money(m.act_spend)} vs ${money(m.kpi_spend)} | reach ${fmtCount(m.act_reach)} vs ${fmtCount(m.kpi_reach)} | impr ${fmtCount(m.act_impressions)} vs ${fmtCount(m.kpi_impressions)} | freq ${m.act_frequency ?? 'n/a'} vs ${m.kpi_frequency ?? 'n/a'} | ER ${fmtPct(m.act_engagement_rate, 2)} vs ${fmtPct(m.kpi_engagement_rate, 2)}`));
    L.push('');
  }

  L.push('RANKING RULES');
  L.push(`Creatives under ${fmtCount(x.floor)} lifetime impressions are excluded from rankings; ${x.excluded} excluded. Not-boosted creatives have no paid row.`);
  L.push('');
  L.push('DATA GAPS');
  L.push('Paid engagement rate is Meta only until TikTok engagement columns are populated. Organic ER covers all platforms.');
  L.push('Paid figures are lifetime. For anything over time use get_series (spend, reach, impressions, video_views). Hook, hold and CQR have no daily series.');
  L.push('');
  L.push('NOT IN THIS SNAPSHOT');
  L.push(`Daily or weekly series. Full per-platform retention curves (get_creative). Any brand other than ${label}. Never estimate a number not written above.`);
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
      boosted: !!m, is_validated: !!(bs && bs.is_validated), organic_best_cqr: bs ? bs.best_cqr : null,
      ...(m || {}),
    };
    records[id] = rec;
    if (m) paid.push(rec);
  }

  const organic = organicRows.map((o) => ({ id: o.id, platform: o.platform, views: num(o.views), reach: num(o.reach), total_interactions: num(o.total_interactions), cqr: o.cqr, engagement_rate: r1(o.engagement_rate), retention_rate: r1(o.retention_rate) }));
  for (const o of organic) { if (records[o.id]) { records[o.id].organic = records[o.id].organic || {}; records[o.id].organic[o.platform] = o; } }

  const totals = { spend: paid.reduce((s, c) => s + num(c.spend), 0), reach: paid.reduce((s, c) => s + num(c.reach), 0), impressions: paid.reduce((s, c) => s + num(c.impressions), 0), hook_rate: r1(avg(paid.map((c) => c.hook_rate))), hold_rate: r1(avg(paid.map((c) => c.hold_rate))) };
  const floor = Math.max(S.volumeFloor.absoluteMin, Math.round(totals.impressions * S.volumeFloor.relativeShare));
  const eligible = paid.filter((c) => num(c.impressions) >= floor);
  const ranked = [...eligible].sort(rankCmp);

  // Table: everything if small; else top/bottom plus most recent.
  let table = ranked, tableNote = '';
  if (ranked.length > S.tableCap.maxRows) {
    const tb = S.tableCap.topBottom;
    const keep = new Set([...ranked.slice(0, tb), ...ranked.slice(-tb)].map((c) => c.id));
    const recent = [...ranked].sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))).filter((c) => !keep.has(c.id)).slice(0, S.tableCap.maxRows - 2 * tb);
    recent.forEach((c) => keep.add(c.id));
    table = ranked.filter((c) => keep.has(c.id));
    tableNote = ` (showing ${table.length} of ${ranked.length}: top ${tb}, bottom ${tb}, most recent; call rank_creatives for others)`;
  }

  const cqrMix = { Good: 0, Average: 0, Poor: 0, Invalid: 0 }, spendByCqr = { Good: 0, Average: 0, Poor: 0, Invalid: 0 };
  for (const c of paid) { const k = cqrMix[c.cqr] !== undefined ? c.cqr : 'Invalid'; cqrMix[k]++; spendByCqr[k] += num(c.spend); }
  const poorActive = paid.filter((c) => c.cqr === 'Poor' && c.is_active);
  const poorActiveSpend = poorActive.reduce((s, c) => s + num(c.spend), 0);

  const byPlatform = {};
  for (const p of S.platforms) {
    const rows = paid.filter((c) => c.per_platform && c.per_platform[p]).map((c) => ({ ...c.per_platform[p], is_active: c.per_platform[p].is_active }));
    if (rows.length) byPlatform[p] = rollup(rows, () => p)[p];
  }
  const byType = rollup(paid, (c) => c.type), byFormat = rollup(paid, (c) => c.format), byCampaign = rollup(paid, (c) => c.campaign);
  const byCreator = rollup(paid.filter((c) => c.creator), (c) => c.creator);

  const organicSummary = { n: organic.length, views: organic.reduce((s, o) => s + o.views, 0), reach: organic.reduce((s, o) => s + o.reach, 0), good: organic.filter((o) => o.cqr === 'Good').length, avg: organic.filter((o) => o.cqr === 'Average').length, poor: organic.filter((o) => o.cqr === 'Poor').length };
  const organicByPlatform = {};
  for (const p of S.organicPlatforms) { const rows = organic.filter((o) => o.platform === p); organicByPlatform[p] = { n: rows.length, views: rows.reduce((s, o) => s + o.views, 0), engagement_rate: r1(avg(rows.map((o) => o.engagement_rate))), good: rows.filter((o) => o.cqr === 'Good').length }; }
  const organicTop = [...organic].sort((a, b) => ((S.cqrRank[a.cqr] ?? 9) - (S.cqrRank[b.cqr] ?? 9)) || (b.views - a.views)).slice(0, 5);
  const validatedUnboosted = boostRows.filter((r) => r.is_validated && !r.is_boosted);

  // Cohort records so [[cohort:...]] markers render real numbers.
  const cohort = (kind, obj) => { for (const [k, g] of Object.entries(obj)) records[`cohort:${kind}:${k}`] = { id: `cohort:${kind}:${k}`, kind, key: k, ...g }; };
  cohort('platform', byPlatform); cohort('type', byType); cohort('format', byFormat); cohort('campaign', byCampaign); cohort('creator', byCreator);

  records.brand = { id: 'brand', name: S.brandLabels[brand], ...totals, cqr_mix: cqrMix, active: paid.filter((c) => c.is_active).length, boosted: paid.length };
  records.__meta = { freshness: freshness.max_date, generated_at: new Date().toISOString() };

  const version = crypto.createHash('sha256').update([brand, freshness.max_date, freshness.row_count, paid.length, organic.length, boostRows.length].join('|')).digest('hex').slice(0, 12);
  const body = renderDigest({ brand, freshness, paid, activeCount: paid.filter((c) => c.is_active).length, totals, cqrMix, spendByCqr, poorActive, poorActiveSpend, table, tableNote, byPlatform, byType, byFormat, byCampaign, byCreator, organic, organicSummary, organicByPlatform, organicTop, validatedUnboosted, thresholds, monthly, floor, excluded: paid.length - eligible.length });

  return { brand, range_days: 0, period_start: '1970-01-01', period_end: freshness.max_date || new Date().toISOString().slice(0, 10), version, body, records, token_estimate: Math.ceil(body.length / 3.6), floor };
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

async function getSnapshot(brand, _r, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const { rows } = await pool.query(`select * from brand_snapshots where brand = $1 and range_days = 0 order by generated_at desc limit 1`, [brand]);
  return rows.length ? rows[0] : generateAndStore(brand, 0, opts);
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

module.exports = { buildSnapshot, generateAndStore, getSnapshot, warmAll, assertBrand, shortName, displayLabel, mergePaid, rankCmp };

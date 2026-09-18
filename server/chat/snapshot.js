/**
 * Ask Lens - snapshot generator (v2)
 *
 * Reads the dashboard's own per-creative views and applies the same merge
 * rules as creatives.js, so every number the chat can point at is the
 * number on the Creative Hub card. Lifetime per creative, one snapshot
 * per brand, exactly like the Hub.
 *
 * Ranking is CQR first, then hook rate, then hold rate. CTR and VTR are
 * in the record for anyone who asks by name, but never in the digest.
 *
 * Cron, after each n8n run:
 *   node -e "require('./server/chat/snapshot').warmAll()"
 */

const crypto = require('crypto');
const S = require('./schema.config');
const { getPool } = require('./db');

const T = S.tables;
const C = S.creative;
const P = S.paidView;
const O = S.organicView;
const OR = S.organicRawCols;

const TOP_N = 5;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function assertBrand(brand) {
  if (!S.brands.includes(brand)) throw new Error(`Unknown brand: ${brand}`);
  return brand;
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

function fmtCount(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function fmtPct(v, d = 1) {
  if (v === null || v === undefined) return 'n/a';
  return `${Number(v).toFixed(d)}%`;
}

function money(v) {
  if (v === null || v === undefined) return 'n/a';
  return `${fmtCount(v)} ${S.currency}`;
}

/** Same display name the Hub uses. */
function shortName(id) {
  const m = String(id).match(/Video(\d+)_(BrandSay|OthersSay)/);
  if (m) return `Video${m[1]} ${m[2] === 'BrandSay' ? 'Brand Say' : 'Others Say'}`;
  const parts = String(id).split('_');
  return parts.length >= 4 ? `${parts[1]} · ${parts[2]} · ${parts[3]}` : String(id);
}

function bestCqr(list) {
  const ranked = list.filter(Boolean).sort((a, b) => (S.cqrRank[a] ?? 9) - (S.cqrRank[b] ?? 9));
  return ranked[0] || 'Invalid';
}

function avg(list) {
  const xs = list.filter((v) => v !== null && v !== undefined);
  return xs.length ? xs.reduce((s, v) => s + Number(v), 0) / xs.length : null;
}

/** CQR rank then hook then hold. Higher is better for the rates. */
function rankCmp(a, b) {
  const c = (S.cqrRank[a.cqr] ?? 9) - (S.cqrRank[b.cqr] ?? 9);
  if (c !== 0) return c;
  const h = num(b.hook_rate) - num(a.hook_rate);
  if (h !== 0) return h;
  return num(b.hold_rate) - num(a.hold_rate);
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

async function queryCreatives(pool, brand) {
  const { rows } = await pool.query(
    `select ${C.id} as id, ${C.hook} as hook, ${C.format} as format,
            ${C.productRole} as product_role, ${C.type} as type,
            ${C.campaign} as campaign, ${C.isRepurposed} as is_repurposed,
            ${C.parentId} as parent_id, ${C.publishedAt} as published_at,
            ${C.durationS} as duration_s,
            coalesce(${C.ttLink}, ${C.igLink}, ${C.fbLink}) as permalink
     from ${T.creatives} where ${C.brand} = $1`,
    [brand],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function queryPaidView(pool, view, brand) {
  const { rows } = await pool.query(
    `select ${P.creativeId} as id, ${P.spend} as spend, ${P.reach} as reach,
            ${P.impressions} as impressions, ${P.hookRate} as hook_rate,
            ${P.holdRate} as hold_rate, ${P.hookQ} as hook_q, ${P.holdQ} as hold_q,
            ${P.vtr} as vtr, ${P.avgWatchTime} as avg_watch_time, ${P.cqr} as cqr,
            ${P.isActive} as is_active, ${P.w25} as w25, ${P.w50} as w50,
            ${P.w75} as w75, ${P.w100} as w100,
            ${P.verdict} as verdict, ${P.working} as working,
            ${P.notWorking} as not_working, ${P.action} as action, ${P.priority} as priority
     from ${view} where ${P.brand} = $1 and ${P.creativeId} is not null`,
    [brand],
  );
  return rows;
}

async function queryOrganic(pool, brand) {
  const { rows } = await pool.query(
    `select o.${OR.creativeId} as id, o.${OR.platform} as platform,
            o.${OR.views} as views, o.${OR.reach} as reach,
            o.${OR.totalInteractions} as total_interactions,
            s.${O.cqr} as cqr, s.${O.engagementRate} as engagement_rate,
            s.${O.retentionRate} as retention_rate
     from ${T.organicRaw} o
     join ${T.creatives} c on c.${C.id} = o.${OR.creativeId}
     left join ${T.organicScored} s
       on s.${O.creativeId} = o.${OR.creativeId} and s.${O.platform} = o.${OR.platform}
     where c.${C.brand} = $1`,
    [brand],
  );
  return rows;
}

async function queryFreshness(pool, brand) {
  const { rows } = await pool.query(
    `select max(date)::text as max_date, count(*) as row_count
     from ${T.paidDaily} where brand_id = $1`,
    [brand],
  );
  return rows[0] || { max_date: null, row_count: 0 };
}

async function queryMonthly(pool, brand) {
  const { rows } = await pool.query(
    `select month::text as month, act_spend, act_reach, act_impressions,
            act_engagement_rate, act_cpm, kpi_spend, kpi_reach
     from ${T.accountMonthly} where brand_id = $1
     order by month desc limit 3`,
    [brand],
  );
  return rows.reverse();
}

// ---------------------------------------------------------------
// Merge, mirroring creatives.js
// ---------------------------------------------------------------

function mergePaid(meta, tiktok) {
  const both = [meta, tiktok].filter(Boolean);
  if (!both.length) return null;
  const pick = (f) => both.map((x) => x[f]);
  return {
    platforms: both.map((x) => x.platform),
    cqr: bestCqr(pick('cqr')),
    hook_rate: r1(avg(pick('hook_rate'))),
    hold_rate: both.length ? Math.max(...pick('hold_rate').map(num)) : null,
    hook_q: (meta || tiktok).hook_q || '',
    hold_q: (meta || tiktok).hold_q || '',
    vtr: r1(avg(pick('vtr'))),
    avg_watch_time: r1(avg(pick('avg_watch_time'))),
    spend: pick('spend').reduce((s, v) => s + num(v), 0),
    reach: Math.max(...pick('reach').map(num)),
    impressions: pick('impressions').reduce((s, v) => s + num(v), 0),
    is_active: both.some((x) => x.is_active),
    verdict: (meta || tiktok).verdict || '',
    working: (meta || tiktok).working || '',
    not_working: (meta || tiktok).not_working || '',
    action: (meta || tiktok).action || '',
    priority: (meta || tiktok).priority || '',
    per_platform: Object.fromEntries(both.map((x) => [x.platform, {
      cqr: x.cqr, hook_rate: r1(x.hook_rate), hold_rate: r1(x.hold_rate),
      spend: num(x.spend), reach: num(x.reach), impressions: num(x.impressions),
      vtr: r1(x.vtr), retention: [100, r1(x.hook_rate), r1(x.w25), r1(x.w50), r1(x.w75), r1(x.w100)],
    }])),
  };
}

// ---------------------------------------------------------------
// Digest
// ---------------------------------------------------------------

function line(c) {
  const plats = (c.platforms || []).map((p) => S.platformLabels[p] || p).join('+') || 'not boosted';
  return `${c.id} | ${c.cqr} | hook ${fmtPct(c.hook_rate)} | hold ${fmtPct(c.hold_rate)} | ` +
         `${plats} | ${c.type || ''} | ${c.format || 'unclassified'} | reach ${fmtCount(c.reach)}`;
}

function renderDigest(x) {
  const label = S.brandLabels[x.brand] || x.brand;
  const L = [];

  L.push(`SNAPSHOT: ${label} | lifetime per creative | paid data through ${x.freshness.max_date || 'unknown'}`);
  L.push('');

  L.push('HOW TO RANK');
  L.push('Best performing means best CQR first, then hook rate, then hold rate. Use this order for any vague question.');
  L.push('Engagement rate, reach and video views come next. CTR and VTR are vanity metrics here: never volunteer them, only report them if the user names them.');
  L.push('');

  L.push('PAID TOTALS');
  L.push(`${x.paid.length} boosted creatives | spend ${money(x.totals.spend)} | reach ${fmtCount(x.totals.reach)} | impressions ${fmtCount(x.totals.impressions)}`);
  L.push(`CQR mix: ${x.cqrMix.Good} Good, ${x.cqrMix.Average} Average, ${x.cqrMix.Poor} Poor, ${x.cqrMix.Invalid} Invalid`);
  L.push(`Spend by CQR: Good ${money(x.spendByCqr.Good)} | Average ${money(x.spendByCqr.Average)} | Poor ${money(x.spendByCqr.Poor)}`);
  L.push(`Brand avg hook ${fmtPct(x.totals.hook_rate)} | avg hold ${fmtPct(x.totals.hold_rate)}`);
  L.push('');

  L.push(`TOP ${x.top.length} PAID (CQR, then hook, then hold)`);
  x.top.forEach((c) => L.push(line(c)));
  L.push('');

  L.push(`BOTTOM ${x.bottom.length} PAID`);
  x.bottom.forEach((c) => L.push(line(c)));
  L.push('');

  L.push('BY PLATFORM (paid)');
  for (const p of S.platforms) {
    const s = x.byPlatform[p];
    if (!s || !s.n) continue;
    L.push(`${S.platformLabels[p]}: ${s.n} creatives, spend ${money(s.spend)}, avg hook ${fmtPct(s.hook_rate)}, avg hold ${fmtPct(s.hold_rate)}, ${s.good} Good / ${s.poor} Poor`);
  }
  L.push('');

  L.push('BY TYPE (paid)');
  for (const [t, s] of Object.entries(x.byType)) {
    L.push(`${t}: ${s.n} creatives, avg hook ${fmtPct(s.hook_rate)}, avg hold ${fmtPct(s.hold_rate)}, ${s.good} Good / ${s.poor} Poor`);
  }
  L.push('');

  L.push('BY FORMAT (paid)');
  for (const [f, s] of Object.entries(x.byFormat)) {
    L.push(`${f}: ${s.n} creatives, avg hook ${fmtPct(s.hook_rate)}, avg hold ${fmtPct(s.hold_rate)}, ${s.good} Good / ${s.poor} Poor`);
  }
  L.push('');

  if (x.organic.length) {
    L.push('ORGANIC (lifetime, not date filtered)');
    L.push(`${x.organicSummary.n} posts | views ${fmtCount(x.organicSummary.views)} | reach ${fmtCount(x.organicSummary.reach)} | CQR mix ${x.organicSummary.good} Good / ${x.organicSummary.avg} Average / ${x.organicSummary.poor} Poor`);
    for (const p of S.organicPlatforms) {
      const s = x.organicByPlatform[p];
      if (!s || !s.n) continue;
      L.push(`${S.platformLabels[p]}: ${s.n} posts, views ${fmtCount(s.views)}, avg ER ${fmtPct(s.engagement_rate, 2)}, ${s.good} Good`);
    }
    L.push('TOP ORGANIC BY CQR THEN VIEWS');
    x.organicTop.forEach((o) => L.push(`${o.id} | ${o.platform} | ${o.cqr || 'unscored'} | views ${fmtCount(o.views)} | ER ${fmtPct(o.engagement_rate, 2)}`));
    L.push('');
  }

  if (x.monthly.length) {
    L.push('BRAND MONTHLY (account level, from the KPI tab)');
    x.monthly.forEach((m) => L.push(
      `${m.month.slice(0, 7)}: spend ${money(m.act_spend)} vs plan ${money(m.kpi_spend)} | reach ${fmtCount(m.act_reach)} vs plan ${fmtCount(m.kpi_reach)} | ER ${fmtPct(m.act_engagement_rate, 2)}`,
    ));
    L.push('');
  }

  if (x.verdicts.length) {
    L.push('EXISTING INSIGHTS VERDICTS (already on the cards; cite them, do not contradict them)');
    x.verdicts.forEach((v) => L.push(`${v.id}: ${v.verdict}${v.priority ? ` [${v.priority}]` : ''}${v.action ? ` -> ${v.action}` : ''}`));
    L.push('');
  }

  L.push('RANKING RULES');
  L.push(`Creatives under ${fmtCount(x.floor)} impressions are excluded from the ranked lists. ${x.excluded} excluded on that basis.`);
  L.push('Creatives with no paid data are "not boosted" and do not appear in paid rankings.');
  L.push('');

  L.push('DATA GAPS');
  L.push('Paid engagement rate is Meta only; TikTok paid engagement columns are not populated yet. Organic engagement rate covers all platforms.');
  L.push('All paid figures are lifetime per creative, matching the Creative Hub. Use get_series for anything over time.');
  L.push('');

  L.push('NOT IN THIS SNAPSHOT');
  L.push('Creatives outside the top and bottom lists. Daily or weekly series. Retention curves beyond hook and hold. Per-creative organic detail beyond the top list. Any brand other than ' + label + '.');
  L.push('For any of these, call a tool. Never estimate a number not written above.');

  return L.join('\n');
}

// ---------------------------------------------------------------
// Build
// ---------------------------------------------------------------

async function buildSnapshot(brand, _rangeDays, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();

  const [creatives, metaRows, ttRows, organicRows, freshness, monthly] = await Promise.all([
    queryCreatives(pool, brand),
    queryPaidView(pool, T.paidMeta, brand).then((r) => r.map((x) => ({ ...x, platform: 'meta' }))),
    queryPaidView(pool, T.paidTiktok, brand).then((r) => r.map((x) => ({ ...x, platform: 'tiktok' }))),
    queryOrganic(pool, brand),
    queryFreshness(pool, brand),
    queryMonthly(pool, brand),
  ]);

  const metaBy = new Map(metaRows.map((r) => [r.id, r]));
  const ttBy = new Map(ttRows.map((r) => [r.id, r]));

  // Merge paid per creative
  const paid = [];
  const records = {};
  for (const [id, c] of creatives) {
    const merged = mergePaid(metaBy.get(id), ttBy.get(id));
    const rec = {
      id, name: shortName(id), hook: c.hook, format: c.format, product_role: c.product_role,
      type: c.type, campaign: c.campaign, origin: c.is_repurposed ? 'repurposed' : 'original',
      parent_id: c.parent_id, published_at: c.published_at, duration_s: c.duration_s,
      permalink: c.permalink, boosted: !!merged, ...(merged || {}),
    };
    records[id] = rec;
    if (merged) paid.push(rec);
  }

  // Organic per creative per platform
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

  // Totals + floor
  const totals = {
    spend: paid.reduce((s, c) => s + num(c.spend), 0),
    reach: paid.reduce((s, c) => s + num(c.reach), 0),
    impressions: paid.reduce((s, c) => s + num(c.impressions), 0),
    hook_rate: r1(avg(paid.map((c) => c.hook_rate))),
    hold_rate: r1(avg(paid.map((c) => c.hold_rate))),
  };
  const floor = Math.max(S.volumeFloor.absoluteMin, Math.round(totals.impressions * S.volumeFloor.relativeShare));
  const eligible = paid.filter((c) => num(c.impressions) >= floor);
  const ranked = [...eligible].sort(rankCmp);

  const cqrMix = { Good: 0, Average: 0, Poor: 0, Invalid: 0 };
  const spendByCqr = { Good: 0, Average: 0, Poor: 0, Invalid: 0 };
  for (const c of paid) {
    const k = cqrMix[c.cqr] !== undefined ? c.cqr : 'Invalid';
    cqrMix[k] += 1;
    spendByCqr[k] += num(c.spend);
  }

  const group = (keyFn) => {
    const out = {};
    for (const c of paid) {
      const k = keyFn(c) || 'unclassified';
      const g = (out[k] = out[k] || { n: 0, spend: 0, hooks: [], holds: [], good: 0, poor: 0 });
      g.n += 1; g.spend += num(c.spend);
      g.hooks.push(c.hook_rate); g.holds.push(c.hold_rate);
      if (c.cqr === 'Good') g.good += 1;
      if (c.cqr === 'Poor') g.poor += 1;
    }
    for (const g of Object.values(out)) {
      g.hook_rate = r1(avg(g.hooks)); g.hold_rate = r1(avg(g.holds));
      delete g.hooks; delete g.holds;
    }
    return out;
  };

  const byPlatform = {};
  for (const p of S.platforms) {
    const rows = paid.filter((c) => c.per_platform && c.per_platform[p]).map((c) => c.per_platform[p]);
    byPlatform[p] = {
      n: rows.length,
      spend: rows.reduce((s, r) => s + num(r.spend), 0),
      hook_rate: r1(avg(rows.map((r) => r.hook_rate))),
      hold_rate: r1(avg(rows.map((r) => r.hold_rate))),
      good: rows.filter((r) => r.cqr === 'Good').length,
      poor: rows.filter((r) => r.cqr === 'Poor').length,
    };
  }

  const organicSummary = {
    n: organic.length,
    views: organic.reduce((s, o) => s + o.views, 0),
    reach: organic.reduce((s, o) => s + o.reach, 0),
    good: organic.filter((o) => o.cqr === 'Good').length,
    avg: organic.filter((o) => o.cqr === 'Average').length,
    poor: organic.filter((o) => o.cqr === 'Poor').length,
  };
  const organicByPlatform = {};
  for (const p of S.organicPlatforms) {
    const rows = organic.filter((o) => o.platform === p);
    organicByPlatform[p] = {
      n: rows.length, views: rows.reduce((s, o) => s + o.views, 0),
      engagement_rate: r1(avg(rows.map((o) => o.engagement_rate))),
      good: rows.filter((o) => o.cqr === 'Good').length,
    };
  }
  const organicTop = [...organic]
    .sort((a, b) => ((S.cqrRank[a.cqr] ?? 9) - (S.cqrRank[b.cqr] ?? 9)) || (b.views - a.views))
    .slice(0, TOP_N);

  const verdicts = paid.filter((c) => c.verdict).slice(0, 8)
    .map((c) => ({ id: c.id, verdict: c.verdict, priority: c.priority, action: c.action }));

  const version = crypto.createHash('sha256')
    .update([brand, freshness.max_date, freshness.row_count, paid.length, organic.length].join('|'))
    .digest('hex').slice(0, 12);

  const body = renderDigest({
    brand, freshness, paid, totals, cqrMix, spendByCqr,
    top: ranked.slice(0, TOP_N), bottom: ranked.slice(-TOP_N).reverse(),
    byPlatform, byType: group((c) => c.type), byFormat: group((c) => c.format),
    organic, organicSummary, organicByPlatform, organicTop, monthly, verdicts,
    floor, excluded: paid.length - eligible.length,
  });

  // Brand-level record so [[metric:hook_rate|brand]] resolves.
  records.brand = { id: 'brand', name: S.brandLabels[brand], ...totals, cqr_mix: cqrMix };

  return {
    brand, range_days: 0,
    period_start: '1970-01-01', period_end: freshness.max_date || new Date().toISOString().slice(0, 10),
    version, body, records,
    token_estimate: Math.ceil(body.length / 3.6), floor,
  };
}

async function generateAndStore(brand, rangeDays, opts = {}) {
  const pool = opts.pool || getPool();
  const snap = await buildSnapshot(brand, rangeDays, opts);
  const { rows } = await pool.query(
    `insert into brand_snapshots
       (brand, range_days, period_start, period_end, version, body, records, token_estimate)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (brand, range_days, version) do update
       set body = excluded.body, records = excluded.records,
           period_end = excluded.period_end, generated_at = now()
     returning *`,
    [snap.brand, snap.range_days, snap.period_start, snap.period_end,
     snap.version, snap.body, JSON.stringify(snap.records), snap.token_estimate],
  );
  return rows[0];
}

async function getSnapshot(brand, _rangeDays, opts = {}) {
  assertBrand(brand);
  const pool = opts.pool || getPool();
  const { rows } = await pool.query(
    `select * from brand_snapshots where brand = $1 and range_days = 0
     order by generated_at desc limit 1`,
    [brand],
  );
  if (rows.length) return rows[0];
  return generateAndStore(brand, 0, opts);
}

async function warmAll(opts = {}) {
  const pool = opts.pool || getPool();
  const results = [];
  for (const brand of S.brands) {
    try {
      const row = await generateAndStore(brand, 0, { pool });
      results.push({ brand, version: row.version, tokens: row.token_estimate });
    } catch (err) {
      console.error(`[snapshot] ${brand} failed:`, err.message);
      results.push({ brand, error: err.message });
    }
  }
  await pool.query('select prune_answer_cache()');
  console.table(results);
  return results;
}

module.exports = { buildSnapshot, generateAndStore, getSnapshot, warmAll, assertBrand, shortName, mergePaid, rankCmp };

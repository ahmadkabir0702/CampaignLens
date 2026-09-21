/**
 * Ask Lens - analytics engine
 *
 * Every number the model will ever cite is computed here, in code. The model
 * reads conclusions; it never calculates. This is the single biggest source
 * of error in LLM analytics systems, so it is closed off structurally.
 *
 * Two rules enforced here, not left to the prompt:
 *   1. Minimum group size. A group under MIN_GROUP is marked tooFew and the
 *      renderer prints TOO FEW instead of a number. A three-creative fluke
 *      reported as a trend is how the tool loses trust.
 *   2. Volume floor. Creatives under the impression floor never enter a
 *      ranking.
 *
 * Output is a structured object. snapshot.js renders it; tools reuse it.
 */

const S = require('./schema.config');

const MIN_GROUP = 5;

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const avg = (xs) => { const a = xs.filter((v) => v !== null && v !== undefined && isFinite(v)); return a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null; };
const cqrScore = (c) => (S.cqrRank[c] ?? 9);

/** CQR, then hook, then hold. The team's order. */
function rankCmp(a, b) {
  const c = cqrScore(a.cqr) - cqrScore(b.cqr); if (c) return c;
  const h = num(b.hook_rate) - num(a.hook_rate); if (h) return h;
  return num(b.hold_rate) - num(a.hold_rate);
}

/**
 * One group summary. Carries its own n so the renderer and the model can
 * both see whether it is reportable.
 */
function summarise(rows, key) {
  const n = rows.length;
  const good = rows.filter((r) => r.cqr === 'Good').length;
  const average = rows.filter((r) => r.cqr === 'Average').length;
  const poor = rows.filter((r) => r.cqr === 'Poor').length;
  return {
    key, n,
    tooFew: n < MIN_GROUP,
    good, average, poor,
    goodShare: n ? Math.round((good / n) * 100) : null,
    active: rows.filter((r) => r.is_active).length,
    spend: rows.reduce((s, r) => s + num(r.spend), 0),
    reach: rows.reduce((s, r) => s + num(r.reach), 0),
    hook_rate: r1(avg(rows.map((r) => r.hook_rate))),
    hold_rate: r1(avg(rows.map((r) => r.hold_rate))),
    strongHooks: rows.filter((r) => r.hook_q === 'Strong').length,
    strongHolds: rows.filter((r) => r.hold_q === 'Strong').length,
    ids: rows.slice(0, 3).map((r) => r.id),
  };
}

/** Group by one dimension, sorted best first, tooFew groups last. */
function groupBy(rows, keyFn, label) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === '') continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const groups = [...buckets.entries()].map(([k, rs]) => summarise(rs, k));
  groups.sort((a, b) => {
    if (a.tooFew !== b.tooFew) return a.tooFew ? 1 : -1;
    const g = (b.goodShare ?? -1) - (a.goodShare ?? -1); if (g) return g;
    return num(b.hook_rate) - num(a.hook_rate);
  });
  const reportable = groups.filter((g) => !g.tooFew);
  return {
    dimension: label,
    groups,
    reportable: reportable.length,
    // A dimension only "separates" if the best and worst reportable groups
    // differ enough to be worth saying out loud.
    spread: reportable.length >= 2
      ? r1(num(reportable[0].hook_rate) - num(reportable[reportable.length - 1].hook_rate))
      : null,
  };
}

/** Two dimensions crossed. Only emitted if enough cells clear MIN_GROUP. */
function crosstab(rows, aFn, bFn, aLabel, bLabel) {
  const cells = new Map();
  for (const r of rows) {
    const a = aFn(r), b = bFn(r);
    if (!a || !b) continue;
    const k = a + '\u0000' + b;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
  }
  const out = [...cells.entries()].map(([k, rs]) => {
    const [a, b] = k.split('\u0000');
    return { a, b, ...summarise(rs, a + ' x ' + b) };
  });
  const reportable = out.filter((c) => !c.tooFew);
  return {
    dimensions: [aLabel, bLabel],
    cells: reportable.sort((x, y) => (y.goodShare ?? -1) - (x.goodShare ?? -1)),
    suppressed: out.length - reportable.length,
    usable: reportable.length >= 2,
  };
}

/** Where the retention curve drops hardest, and what was on screen there. */
function retentionDrop(c) {
  const r = c.retention || [];
  const labels = ['0s', 'hook', '25%', '50%', '75%', '100%'];
  let worst = null;
  for (let i = 1; i < r.length; i += 1) {
    if (r[i] === null || r[i - 1] === null) continue;
    const d = r[i - 1] - r[i];
    if (!worst || d > worst.drop) worst = { drop: Math.round(d), from: labels[i - 1], to: labels[i] };
  }
  if (!worst) return null;
  // Map the quartile boundary to a rough timestamp, then read the timeline.
  const frac = { 'hook': 0.05, '25%': 0.25, '50%': 0.5, '75%': 0.75, '100%': 1 }[worst.to];
  let onScreen = null;
  if (frac && c.duration_s && Array.isArray(c.timeline_attrs)) {
    const t = c.duration_s * frac;
    const seg = c.timeline_attrs.reduce((best, s) =>
      (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) ? s : best, null);
    if (seg) onScreen = seg.on_screen;
  }
  return { ...worst, onScreen };
}

/**
 * Build the full analytics object for one brand.
 * `paid` is the merged per-creative list; `organic`, `boost`, `thresholds`,
 * `monthly` come straight from the queries.
 */
function build({ brand, paid, organic, boost, thresholds, monthly, freshness }) {
  const floor = S.volumeFloor.absoluteMin;
  const eligible = paid.filter((c) => num(c.impressions) >= floor);
  const excluded = paid.length - eligible.length;
  const ranked = [...eligible].sort(rankCmp);

  // ---- Totals -------------------------------------------------
  const totals = {
    creatives: paid.length,
    active: paid.filter((c) => c.is_active).length,
    spend: paid.reduce((s, c) => s + num(c.spend), 0),
    reach: paid.reduce((s, c) => s + num(c.reach), 0),
    impressions: paid.reduce((s, c) => s + num(c.impressions), 0),
    hook_rate: r1(avg(paid.map((c) => c.hook_rate))),
    hold_rate: r1(avg(paid.map((c) => c.hold_rate))),
    strongHookShare: paid.length ? Math.round(paid.filter((c) => c.hook_q === 'Strong').length / paid.length * 100) : null,
    strongHoldShare: paid.length ? Math.round(paid.filter((c) => c.hold_q === 'Strong').length / paid.length * 100) : null,
  };

  const cqrMix = { Good: 0, Average: 0, Poor: 0, Invalid: 0 };
  const spendByCqr = { Good: 0, Average: 0, Poor: 0, Invalid: 0 };
  for (const c of paid) {
    const k = cqrMix[c.cqr] !== undefined ? c.cqr : 'Invalid';
    cqrMix[k] += 1; spendByCqr[k] += num(c.spend);
  }

  // ---- Media waste --------------------------------------------
  const waste = paid.filter((c) => c.cqr === 'Poor' && c.is_active)
    .sort((a, b) => num(b.spend) - num(a.spend));
  const wasteSpend = waste.reduce((s, c) => s + num(c.spend), 0);

  // ---- Anomalies worth surfacing unprompted --------------------
  const anomalies = [];
  const goodStopped = paid.filter((c) => c.cqr === 'Good' && !c.is_active);
  if (goodStopped.length) anomalies.push({ kind: 'good_stopped', n: goodStopped.length, ids: goodStopped.slice(0, 5).map((c) => c.id), note: 'Good creatives no longer running' });
  if (waste.length) anomalies.push({ kind: 'poor_active', n: waste.length, spend: wasteSpend, ids: waste.slice(0, 5).map((c) => c.id), note: 'Poor creatives still spending' });
  const platformSplit = paid.filter((c) => c.per_platform && Object.keys(c.per_platform).length > 1
    && new Set(Object.values(c.per_platform).map((p) => p.cqr)).size > 1);
  if (platformSplit.length) anomalies.push({ kind: 'platform_disagree', n: platformSplit.length, ids: platformSplit.slice(0, 5).map((c) => c.id), note: 'CQR differs by platform: the cut may not be native to one of them' });

  // ---- Dimensions ---------------------------------------------
  const dims = {
    platform: null, // handled separately, per-platform rows not per-creative
    type: groupBy(eligible, (c) => c.type, 'type'),
    format: groupBy(eligible, (c) => c.format, 'format'),
    content_intent: groupBy(eligible, (c) => c.content_intent, 'content intent'),
    narrative_structure: groupBy(eligible, (c) => c.narrative_structure, 'narrative structure'),
    hook_device: groupBy(eligible, (c) => c.hook_device, 'hook device'),
    hook_subject: groupBy(eligible, (c) => c.hook_subject, 'hook subject'),
    hook_pace: groupBy(eligible, (c) => c.hook_pace, 'hook pace'),
    product_role: groupBy(eligible, (c) => c.product_role, 'product role'),
    opens_with_face: groupBy(eligible, (c) => (c.opens_with_face === null || c.opens_with_face === undefined ? null : (c.opens_with_face ? 'opens with a face' : 'no face at open')), 'opens with face'),
    opens_with_product: groupBy(eligible, (c) => (c.opens_with_product === null || c.opens_with_product === undefined ? null : (c.opens_with_product ? 'opens with product' : 'no product at open')), 'opens with product'),
    has_text_overlay: groupBy(eligible, (c) => (c.has_text_overlay === null || c.has_text_overlay === undefined ? null : (c.has_text_overlay ? 'has text overlay' : 'no text overlay')), 'text overlay'),
    origin: groupBy(eligible, (c) => c.origin, 'original vs repurposed'),
    campaign: groupBy(eligible, (c) => c.campaign, 'campaign'),
    creator: groupBy(eligible.filter((c) => c.creator), (c) => c.creator, 'creator'),
  };

  const byPlatform = {};
  for (const p of S.platforms) {
    const rows = eligible.filter((c) => c.per_platform && c.per_platform[p])
      .map((c) => ({ ...c.per_platform[p], id: c.id, is_active: c.per_platform[p].is_active, hook_q: c.per_platform[p].hook_q, hold_q: c.per_platform[p].hold_q }));
    if (rows.length) byPlatform[p] = summarise(rows, p);
  }
  const platGroups = Object.values(byPlatform);
  const platRep = platGroups.filter((g) => !g.tooFew).sort((a, b) => num(b.hook_rate) - num(a.hook_rate));
  dims.platform = {
    dimension: 'platform',
    groups: platRep.concat(platGroups.filter((g) => g.tooFew)),
    reportable: platRep.length,
    spread: platRep.length >= 2 ? r1(num(platRep[0].hook_rate) - num(platRep[platRep.length - 1].hook_rate)) : null,
  };

  // Which dimensions actually separate performance. The renderer leads with
  // these; a dimension that does not separate is noise.
  const discriminating = Object.values(dims)
    .filter((d) => d && d.spread !== null && Math.abs(d.spread) >= 5 && d.reportable >= 2)
    .sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread))
    .map((d) => {
      // Best and worst are decided by hook rate, not list position, or a
      // dimension sorted on a different key reports them backwards.
      const byHook = d.groups.filter((g) => !g.tooFew).sort((a, b) => num(b.hook_rate) - num(a.hook_rate));
      return {
        dimension: d.dimension,
        spread: Math.abs(r1(num(byHook[0].hook_rate) - num(byHook[byHook.length - 1].hook_rate))),
        best: byHook[0].key, bestHook: byHook[0].hook_rate,
        worst: byHook[byHook.length - 1].key, worstHook: byHook[byHook.length - 1].hook_rate,
      };
    });

  // ---- Crosstabs, only the ones that survive MIN_GROUP ---------
  const crosstabs = [
    crosstab(eligible, (c) => c.hook_device, (c) => c.type, 'hook device', 'type'),
    crosstab(eligible, (c) => c.content_intent, (c) => c.format, 'content intent', 'format'),
    crosstab(eligible, (c) => c.hook_device, (c) => c.hook_pace, 'hook device', 'hook pace'),
  ].filter((x) => x.usable);

  // ---- Retention patterns -------------------------------------
  const drops = eligible.map((c) => ({ id: c.id, ...(retentionDrop(c) || {}) })).filter((d) => d.drop);
  const dropBySegment = {};
  for (const d of drops) { const k = `${d.from} to ${d.to}`; dropBySegment[k] = (dropBySegment[k] || 0) + 1; }
  const dropByScreen = {};
  for (const d of drops) { if (d.onScreen) dropByScreen[d.onScreen] = (dropByScreen[d.onScreen] || 0) + 1; }

  const productTiming = {
    avgTimeToProduct: r1(avg(eligible.map((c) => c.time_to_product_s))),
    avgProductScreenPct: r1(avg(eligible.map((c) => c.product_screen_pct))),
    avgCutsPer10s: r1(avg(eligible.map((c) => c.cuts_per_10s))),
  };

  // ---- Organic -------------------------------------------------
  const organicSummary = {
    posts: organic.length,
    views: organic.reduce((s, o) => s + num(o.views), 0),
    reach: organic.reduce((s, o) => s + num(o.reach), 0),
    good: organic.filter((o) => o.cqr === 'Good').length,
    average: organic.filter((o) => o.cqr === 'Average').length,
    poor: organic.filter((o) => o.cqr === 'Poor').length,
    byPlatform: S.organicPlatforms.map((p) => {
      const rows = organic.filter((o) => o.platform === p);
      return { platform: p, n: rows.length, tooFew: rows.length < MIN_GROUP,
        views: rows.reduce((s, o) => s + num(o.views), 0),
        engagement_rate: r1(avg(rows.map((o) => o.engagement_rate))),
        good: rows.filter((o) => o.cqr === 'Good').length };
    }).filter((x) => x.n),
    top: [...organic].sort((a, b) => (cqrScore(a.cqr) - cqrScore(b.cqr)) || (num(b.views) - num(a.views))).slice(0, 5),
  };

  const validatedUnboosted = (boost || []).filter((b) => b.is_validated && !b.is_boosted);

  return {
    brand, freshness, floor, excluded,
    totals, cqrMix, spendByCqr,
    ranked, top: ranked.slice(0, 10), bottom: ranked.slice(-10).reverse(),
    waste, wasteSpend, anomalies,
    dims, discriminating, crosstabs,
    retention: { drops, dropBySegment, dropByScreen, productTiming },
    organic: organicSummary, validatedUnboosted,
    thresholds, monthly,
    minGroup: MIN_GROUP,
  };
}

module.exports = { build, groupBy, crosstab, summarise, rankCmp, retentionDrop, MIN_GROUP };

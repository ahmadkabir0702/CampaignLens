/**
 * Ask Lens - analytics engine
 *
 * Every number the model will ever cite is computed here, in code. The model
 * reads conclusions; it never calculates. This is the single biggest source
 * of error in LLM analytics systems, so it is closed off structurally.
 *
 * Two rules enforced here, not left to the prompt:
 *   1. Group size is always visible. 5+ is a normal comparison, 2 to 4 is an
 *      early signal (compared, but labelled), 1 is a single example. Ranking
 *      weighs small groups cautiously. Previously: a group under MIN_GROUP was marked tooFew and the
 *      renderer prints TOO FEW instead of a number. A three-creative fluke
 *      reported as a trend is how the tool loses trust.
 *   2. Volume floor. Creatives under the impression floor never enter a
 *      ranking.
 *
 * Output is a structured object. snapshot.js renders it; tools reuse it.
 */

const S = require('./schema.config');
const V = require('./vocab');

// A group of 5 or more is a normal comparison. 2 to 4 is an early signal:
// shown and compared, but labelled, and never called a pattern. A single
// creative is an example, not a group.
const MIN_GROUP = 5;
const EARLY_MIN = 2;

/**
 * Good share adjusted for sample size (Wilson score lower bound, 95%).
 * Used only for ranking, never shown. It stops 2 Good out of 2 (100%)
 * outranking 5 Good out of 6 (83%): small groups are weighed cautiously,
 * but a genuinely strong small group still rises.
 */
function goodScore(good, n) {
  if (!n) return 0;
  const z = 1.96, p = good / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

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
 * Compare a group with the brand overall on CQR, hook and hold, in words.
 * The team wants comparisons, not numbers, so this is what the chat reads.
 * CQR uses the gap in Good share; hook and hold use a gap relative to the
 * brand's own average, so a "stronger" means the same thing on any brand.
 */
function verdict(diff, threshold) {
  if (diff === null || !isFinite(diff)) return 'unknown';
  if (diff >= threshold) return 'stronger';
  if (diff <= -threshold) return 'weaker';
  return 'similar';
}

function compareToBrand(g, base) {
  const rel = (b) => Math.max(2, Math.abs(num(b)) * 0.10);
  return {
    cqr: verdict(num(g.goodShare) - base.good, 15),
    hook: verdict(g.hook_rate === null ? null : num(g.hook_rate) - base.hook, rel(base.hook)),
    hold: verdict(g.hold_rate === null ? null : num(g.hold_rate) - base.hold, rel(base.hold)),
  };
}

/** Which groups lead and trail on each of CQR, hook and hold. */
function leadersOf(groups) {
  const rep = groups.filter((g) => !g.tooFew);
  if (rep.length < 2) return null;
  const top = (arr, f) => [...arr].sort(f)[0];
  const pick = (g) => ({ name: g.name || g.key, key: g.key, early: !!g.early });
  return {
    cqr: pick(top(rep, (a, b) => num(b.goodScore) - num(a.goodScore))),
    hook: pick(top(rep, (a, b) => num(b.hook_rate) - num(a.hook_rate))),
    hold: pick(top(rep, (a, b) => num(b.hold_rate) - num(a.hold_rate))),
    weakestCqr: pick(top(rep, (a, b) => num(a.goodScore) - num(b.goodScore))),
  };
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
    tooFew: n < EARLY_MIN,                     // a single creative: an example, not a group
    early: n >= EARLY_MIN && n < MIN_GROUP,    // 2 to 4: compare, but label it
    confidence: n >= MIN_GROUP ? 'solid' : (n >= EARLY_MIN ? 'early' : 'single'),
    goodScore: goodScore(rows.filter((r) => r.cqr === 'Good').length, n),
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

/** Group by one dimension, sorted best first (sample-size aware), singles last. */
function groupBy(rows, keyFn, label, field) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === '') continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const groups = [...buckets.entries()].map(([k, rs]) => ({ ...summarise(rs, k), name: V.label(field, k), field }));
  groups.sort((a, b) => {
    if (a.tooFew !== b.tooFew) return a.tooFew ? 1 : -1;
    const g = num(b.goodScore) - num(a.goodScore); if (g) return g;
    return num(b.hook_rate) - num(a.hook_rate);
  });
  const reportable = groups.filter((g) => !g.tooFew);
  return {
    dimension: V.title(field, label),
    field,
    groups,
    reportable: reportable.length,
    // A dimension only "separates" if the best and worst reportable groups
    // differ enough to be worth saying out loud.
    spread: reportable.length >= 2
      ? r1(num(reportable[0].hook_rate) - num(reportable[reportable.length - 1].hook_rate))
      : null,
  };
}

/** Two dimensions crossed. Cells of 2 or more are shown; small ones are flagged early. */
function crosstab(rows, aFn, bFn, aLabel, bLabel, aField, bField) {
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
    return { a, b, aName: V.label(aField, a), bName: V.label(bField, b), ...summarise(rs, a + ' x ' + b) };
  });
  const reportable = out.filter((c) => !c.tooFew);
  return {
    dimensions: [V.title(aField, aLabel), V.title(bField, bLabel)],
    cells: reportable.sort((x, y) => num(y.goodScore) - num(x.goodScore)),
    suppressed: out.length - reportable.length,
    usable: reportable.length >= 2,
  };
}

/** Where the retention curve drops hardest, and what was on screen there. */
function retentionDrop(c) {
  const r = c.retention || [];
  const labels = ['0s', 'hook', '25%', '50%', '75%', '100%'];
  let worst = null;
  // Start at i = 2: the 0s to hook drop is what hook rate already measures,
  // and it is the largest drop on almost every video by definition. The
  // useful signal is where people leave once the hook has done its job.
  for (let i = 2; i < r.length; i += 1) {
    if (r[i] === null || r[i - 1] === null) continue;
    const d = r[i - 1] - r[i];
    if (!worst || d > worst.drop) worst = { drop: Math.round(d), from: labels[i - 1], to: labels[i] };
  }
  if (!worst) return null;
  // Map the quartile boundary to a rough timestamp, then read the timeline.
  const frac = { 'hook': 0.05, '25%': 0.25, '50%': 0.5, '75%': 0.75, '100%': 1 }[worst.to];
  let onScreen = null;
  if (frac && c.duration_s && Array.isArray(c.timeline_attrs) && c.timeline_attrs.length) {
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
  // Waste only counts creatives that actually delivered. A Poor creative with
  // 300 impressions and 60 LKR of spend is noise, not media waste.
  const waste = eligible.filter((c) => c.cqr === 'Poor' && c.is_active)
    .sort((a, b) => num(b.spend) - num(a.spend));
  const wasteSpend = waste.reduce((s, c) => s + num(c.spend), 0);

  // Poor spend split: lifetime spend on Poor creatives that are now stopped is
  // a past inefficiency; Poor creatives still running are current waste.
  const poorAll = eligible.filter((c) => c.cqr === 'Poor');
  const poorSplit = {
    activeCount: poorAll.filter((c) => c.is_active).length,
    activeSpend: poorAll.filter((c) => c.is_active).reduce((s, c) => s + num(c.spend), 0),
    stoppedCount: poorAll.filter((c) => !c.is_active).length,
    stoppedSpend: poorAll.filter((c) => !c.is_active).reduce((s, c) => s + num(c.spend), 0),
  };

  // Where creatives fail, from the brand's own Strong/Weak judgments.
  const q = eligible.filter((c) => c.hook_q && c.hold_q);
  const hookHold = {
    rated: q.length,
    bothStrong: q.filter((c) => c.hook_q === 'Strong' && c.hold_q === 'Strong').length,
    strongHookWeakHold: q.filter((c) => c.hook_q === 'Strong' && c.hold_q === 'Weak').length,
    weakHookStrongHold: q.filter((c) => c.hook_q === 'Weak' && c.hold_q === 'Strong').length,
    bothWeak: q.filter((c) => c.hook_q === 'Weak' && c.hold_q === 'Weak').length,
  };

  hookHold.mostlyLose = (() => {
    const body = hookHold.strongHookWeakHold, open = hookHold.weakHookStrongHold;
    if (!body && !open) return null;
    if (body >= open * 1.5) return 'mostly in the body: openings work but viewers drop off before the end';
    if (open >= body * 1.5) return 'mostly at the opening: whoever gets past the hook tends to stay';
    return 'about equally at the opening and in the body';
  })();
  hookHold.manyWeakOnBoth = hookHold.rated > 0 && hookHold.bothWeak >= Math.max(hookHold.strongHookWeakHold, hookHold.weakHookStrongHold);

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
    type: groupBy(eligible, (c) => c.type, 'type', 'type'),
    format: groupBy(eligible, (c) => c.format, 'format', 'format'),
    content_intent: groupBy(eligible, (c) => c.content_intent, 'content intent', 'content_intent'),
    narrative_structure: groupBy(eligible, (c) => c.narrative_structure, 'narrative structure', 'narrative_structure'),
    hook_device: groupBy(eligible, (c) => c.hook_device, 'hook device', 'hook_device'),
    hook_subject: groupBy(eligible, (c) => c.hook_subject, 'hook subject', 'hook_subject'),
    hook_pace: groupBy(eligible, (c) => c.hook_pace, 'hook pace', 'hook_pace'),
    product_role: groupBy(eligible, (c) => c.product_role, 'product role', 'product_role'),
    opens_with_face: groupBy(eligible, (c) => (c.opens_with_face === null || c.opens_with_face === undefined ? null : (c.opens_with_face ? 'Face in the first 3 seconds' : 'No face at the start')), 'Opens with a face', 'opens_with_face'),
    opens_with_product: groupBy(eligible, (c) => (c.opens_with_product === null || c.opens_with_product === undefined ? null : (c.opens_with_product ? 'Product in the first 3 seconds' : 'No product at the start')), 'Opens with the product', 'opens_with_product'),
    has_text_overlay: groupBy(eligible, (c) => (c.has_text_overlay === null || c.has_text_overlay === undefined ? null : (c.has_text_overlay ? 'Uses on-screen text' : 'No on-screen text')), 'Text on screen anywhere', 'has_text_overlay'),
    origin: groupBy(eligible, (c) => c.origin, 'Original or repurposed', 'origin'),
    campaign: groupBy(eligible, (c) => c.campaign, 'Campaign', 'campaign'),
    creator: groupBy(eligible.filter((c) => c.creator), (c) => c.creator, 'Creator', 'creator'),
  };

  const byPlatform = {};
  for (const p of S.platforms) {
    const rows = eligible.filter((c) => c.per_platform && c.per_platform[p])
      .map((c) => ({ ...c.per_platform[p], id: c.id, is_active: c.per_platform[p].is_active, hook_q: c.per_platform[p].hook_q, hold_q: c.per_platform[p].hold_q }));
    if (rows.length) byPlatform[p] = { ...summarise(rows, p), name: V.label('platform', p), field: 'platform' };
  }
  const platGroups = Object.values(byPlatform);
  const platRep = platGroups.filter((g) => !g.tooFew).sort((a, b) => (num(b.goodScore) - num(a.goodScore)) || (num(b.hook_rate) - num(a.hook_rate)));
  dims.platform = {
    dimension: V.title('platform'),
    field: 'platform',
    groups: platRep.concat(platGroups.filter((g) => g.tooFew)),
    reportable: platRep.length,
    spread: platRep.length >= 2 ? r1(num(platRep[0].hook_rate) - num(platRep[platRep.length - 1].hook_rate)) : null,
  };

  // Brand baseline for the word comparisons, on the same eligible set.
  const base = {
    good: eligible.length ? eligible.filter((c) => c.cqr === 'Good').length / eligible.length * 100 : 0,
    hook: avg(eligible.map((c) => c.hook_rate)) || 0,
    hold: avg(eligible.map((c) => c.hold_rate)) || 0,
  };
  // Platforms are per-platform rows, not merged creatives. A merged creative
  // takes the better of its two platforms, so comparing a single platform to
  // the merged average makes every platform look weaker. Platforms get their
  // own baseline: the average across all per-platform rows.
  const platRows = eligible.flatMap((c) => Object.values(c.per_platform || {}));
  const platBase = {
    good: platRows.length ? platRows.filter((r) => r.cqr === 'Good').length / platRows.length * 100 : 0,
    hook: avg(platRows.map((r) => r.hook_rate)) || 0,
    hold: avg(platRows.map((r) => r.hold_rate)) || 0,
  };
  for (const [field, d] of Object.entries(dims)) {
    if (!d || !d.groups) continue;
    const b = field === 'platform' ? platBase : base;
    for (const g of d.groups) g.vs = compareToBrand(g, b);
    d.leaders = leadersOf(d.groups);
  }

  // Which dimensions actually separate performance. The renderer leads with
  // these; a dimension that does not separate is noise.
  // Ranked CQR first, matching the team's hierarchy: the gap in Good share
  // decides, hook rate breaks ties. Ranking on hook rate alone once
  // recommended a platform with a higher hook but half the Good share.
  const discriminating = Object.values(dims)
    .filter((d) => d && d.reportable >= 2)
    .map((d) => {
      const rep = d.groups.filter((g) => !g.tooFew)
        .sort((a, b) => (num(b.goodScore) - num(a.goodScore)) || (num(b.hook_rate) - num(a.hook_rate)));
      const best = rep[0], worst = rep[rep.length - 1];
      return {
        dimension: d.dimension,
        field: d.field,
        goodSpread: Math.round(num(best.goodShare) - num(worst.goodShare)),
        hookSpread: r1(num(best.hook_rate) - num(worst.hook_rate)),
        best: best.name || best.key, bestKey: best.key, bestGood: best.goodShare, bestHook: best.hook_rate, bestHold: best.hold_rate,
        early: !!(best.early || worst.early), bestN: best.n, worstN: worst.n,
        worst: worst.name || worst.key, worstKey: worst.key, worstGood: worst.goodShare, worstHook: worst.hook_rate, worstHold: worst.hold_rate,
      };
    })
    // Worth naming only if the Good share gap is real, or the hook gap is
    // large while quality is at least not worse.
    .filter((d) => d.goodSpread >= 15 || (d.goodSpread >= 0 && Math.abs(d.hookSpread) >= 8))
    // Solid comparisons first, then early signals, each by size of gap.
    .sort((a, b) => (a.early - b.early) || (b.goodSpread - a.goodSpread) || (Math.abs(b.hookSpread) - Math.abs(a.hookSpread)));

  // ---- Crosstabs: cells of 2 or more, small ones flagged ---------
  const crosstabs = [
    crosstab(eligible, (c) => c.hook_device, (c) => c.type, 'hook device', 'type', 'hook_device', 'type'),
    crosstab(eligible, (c) => c.content_intent, (c) => c.format, 'content intent', 'format', 'content_intent', 'format'),
    crosstab(eligible, (c) => c.hook_device, (c) => c.hook_pace, 'hook device', 'hook pace', 'hook_device', 'hook_pace'),
  ].filter((x) => x.usable);
  for (const x of crosstabs) for (const c of x.cells) c.vs = compareToBrand(c, base);

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
      return { platform: p, n: rows.length, tooFew: rows.length < EARLY_MIN, early: rows.length >= EARLY_MIN && rows.length < MIN_GROUP,
        views: rows.reduce((s, o) => s + num(o.views), 0),
        engagement_rate: r1(avg(rows.map((o) => o.engagement_rate))),
        good: rows.filter((o) => o.cqr === 'Good').length };
    }).filter((x) => x.n),
    top: [...organic].sort((a, b) => (cqrScore(a.cqr) - cqrScore(b.cqr)) || (num(b.views) - num(a.views))).slice(0, 5),
  };

  // Organic platforms compared with organic overall, in words.
  const orgGood = organic.length ? organic.filter((o) => o.cqr === 'Good').length / organic.length * 100 : 0;
  const orgEr = avg(organic.map((o) => o.engagement_rate)) || 0;
  for (const p of organicSummary.byPlatform) {
    const rows = organic.filter((o) => o.platform === p.platform);
    const good = rows.length ? p.good / rows.length * 100 : 0;
    p.vs = {
      cqr: verdict(good - orgGood, 15),
      engagement: verdict(p.engagement_rate === null ? null : num(p.engagement_rate) - orgEr, Math.max(0.2, orgEr * 0.10)),
    };
  }

  const validatedUnboosted = (boost || []).filter((b) => b.is_validated && !b.is_boosted);

  return {
    brand, freshness, floor, excluded,
    totals, cqrMix, spendByCqr, poorSplit, hookHold,
    ranked, top: ranked.slice(0, 10), bottom: ranked.slice(-10).reverse(),
    waste, wasteSpend, anomalies,
    dims, discriminating, crosstabs,
    retention: { drops, dropBySegment, dropByScreen, productTiming },
    organic: organicSummary, validatedUnboosted,
    thresholds, monthly,
    minGroup: MIN_GROUP, earlyMin: EARLY_MIN, base,
  };
}

module.exports = { build, groupBy, crosstab, summarise, rankCmp, retentionDrop, goodScore, compareToBrand, leadersOf, MIN_GROUP, EARLY_MIN };

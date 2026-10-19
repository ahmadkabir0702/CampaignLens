/**
 * media-summary — the brand's media summary, filterable by campaign.
 *
 * Formerly "Campaign KPIs", which was wrong twice: it is not measured
 * against KPI targets, and it is brand-level with a campaign filter on top
 * rather than a per-campaign page.
 *
 * Two deliberate departures from what was here before.
 *
 * ORGANIC LEADS. The old page was almost entirely paid: spend and delivery
 * at the top, Meta against TikTok at the bottom, and the one content chart
 * in the middle compared Brand Say and Others Say on hook rate, VTR and
 * watch time, all three of which are paid-only fields. On a brand with
 * nothing boosted the page was zeros. Organic is the data that exists for
 * every creative, so it carries the page, and the paid section drops out
 * entirely when there is no spend rather than showing empty tiles.
 *
 * NO CHART LIBRARY. Every figure here is a count, a share or a six-point
 * series, and all three read better as HTML than as a canvas: the type
 * matches the rest of the product, every segment can carry its own label
 * rather than relying on colour alone, and there is no chart lifecycle to
 * manage. Chart.js is still used in the creative panel, where the shapes
 * actually need it.
 *
 * Loaded after dashboard.js and uses its globals: ALL, ACCOUNT_OVERVIEW,
 * fmtN, cqrClass, isGrade, bestOrganicGrade, extractCreatorInfo.
 */

// ---------------------------------------------------------------------
//  Chart colour
//
//  Two slots for a two-way split and three for a rating. Both sets were
//  run through the palette validator rather than picked by eye:
//
//    #0B78A0 / #A8541F   worst adjacent pair ΔE 18.1 under protanopia
//    #1F8A5B / #C4891A / #C2414B   worst adjacent ΔE 8.7 under protanopia,
//                                  18.3 in normal vision
//
//  #0B78A0 is the primary pushed a step more saturated, because the
//  primary itself sits just under the chroma floor and reads grey as a
//  fill. The Average fill is under 3:1 against white, so every rating bar
//  carries its counts as text beside it.
// ---------------------------------------------------------------------
const MS_C = {
  a: '#0B78A0', b: '#A8541F',
  Good: '#1F8A5B', Average: '#C4891A', Poor: '#C2414B',
  none: '#CDD1D7',
};
const MS_GRADES = ['Good', 'Average', 'Poor'];

const msNum = (v) => (v === null || v === undefined || isNaN(v)) ? 0 : Number(v);
const msPct = (n, d) => d ? Math.round(n / d * 100) : 0;
const msEsc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MS_PLATFORMS = [
  { code: 'ig', label: 'Instagram', key: 'igOrganic', link: 'igLink' },
  { code: 'fb', label: 'Facebook',  key: 'fbOrganic', link: 'fbLink' },
  { code: 'tt', label: 'TikTok',    key: 'ttOrganic', link: 'ttLink' },
];

/** Views, in each platform's own field name. */
const msViews = (o) => o ? msNum(o.views || o.videoViews) : 0;

/**
 * Who posted it, as one dimension rather than two overlapping ones.
 *
 * Content type and "posted by" were separate filters that could be set to
 * contradict each other (Brand Say plus Community selects nothing).
 * They are one axis with three values.
 */
function msBucket(d) {
  if (d.type === 'Brand Say') return 'brand';
  return d.source === 'community' ? 'community' : 'creator';
}
const MS_BUCKET_LABEL = { brand: 'Brand Say', creator: 'Creators', community: 'Community' };

// ---------------------------------------------------------------------
//  Filters
// ---------------------------------------------------------------------
const msFilters = { campaign: 'all', month: 'all', platform: 'all', bucket: 'all' };

function msData() {
  let data = typeof ALL !== 'undefined' ? ALL : [];
  if (msFilters.campaign !== 'all') data = data.filter(d => d.campaign === msFilters.campaign);
  if (msFilters.month    !== 'all') data = data.filter(d => d.month === msFilters.month);
  if (msFilters.bucket   !== 'all') data = data.filter(d => msBucket(d) === msFilters.bucket);
  if (msFilters.platform !== 'all') {
    const p = MS_PLATFORMS.find(x => x.code === msFilters.platform);
    if (p) data = data.filter(d => d[p.key] || d[p.link]);
  }
  return data;
}

function msSetFilter(key, value) {
  msFilters[key] = value;
  msRenderBody();
}

// Kept for the nav, which calls this by name.
function renderKpiTab() { renderMediaSummary(); }
function renderKPIDashboard() { renderMediaSummary(); }

function renderMediaSummary() {
  const page = document.getElementById('page-kpi');
  if (!page || page.classList.contains('hidden')) return;
  page.innerHTML = `<div id="ms-head"></div><div id="ms-body"></div>`;
  msRenderFilters();
  msRenderBody();
}

function msRenderFilters() {
  const wrap = document.getElementById('kpi-filters-bar');
  if (!wrap) return;
  const all = typeof ALL !== 'undefined' ? ALL : [];

  const campaigns = ['all', ...[...new Set(all.map(d => d.campaign).filter(Boolean))].sort()];
  // Newest month first: the one people want is almost never the oldest.
  const months = ['all', ...[...new Set(all.map(d => d.month).filter(m => m && m !== 'Unknown'))]
    .sort((a, b) => msMonthKey(b) - msMonthKey(a))];

  const sel = (key, label, opts) => `
    <div class="ms-fgroup">
      <span class="ms-flabel">${label}</span>
      <select class="kfi-select" onchange="msSetFilter('${key}', this.value)">
        ${opts.map(([v, t]) => `<option value="${msEsc(v)}"${msFilters[key] === v ? ' selected' : ''}>${msEsc(t)}</option>`).join('')}
      </select>
    </div>`;

  wrap.innerHTML =
    sel('campaign', 'Campaign', campaigns.map(c => [c, c === 'all' ? 'All campaigns' : c])) +
    sel('month', 'Month', months.map(m => [m, m === 'all' ? 'All months' : m])) +
    sel('platform', 'Platform', [['all', 'All platforms'], ...MS_PLATFORMS.map(p => [p.code, p.label])]) +
    sel('bucket', 'Posted by', [['all', 'Everything'], ['brand', 'Brand Say'],
                                ['creator', 'Creators'], ['community', 'Community']]);

  if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn(wrap);
}

/** "October 2026" to a sortable number. */
function msMonthKey(label) {
  const M = ['January','February','March','April','May','June',
             'July','August','September','October','November','December'];
  const m = String(label || '').match(/^(\w+)\s+(\d{4})$/);
  if (!m) return 0;
  const i = M.indexOf(m[1]);
  return i < 0 ? 0 : Number(m[2]) * 12 + i;
}

// ---------------------------------------------------------------------
//  Pieces
// ---------------------------------------------------------------------

const msTile = (label, value, sub, cls) => `
  <div class="ms-tile">
    <div class="ms-tile-k">${label}</div>
    <div class="ms-tile-v ${cls || ''}">${value}</div>
    ${sub ? `<div class="ms-tile-s">${sub}</div>` : ''}
  </div>`;

const msCard = (title, body, note) => `
  <div class="ms-card">
    <div class="ms-card-head">${title}${note ? `<span class="ms-card-note">${note}</span>` : ''}</div>
    ${body}
  </div>`;

/**
 * A rating mix as one bar.
 *
 * Every segment carries its own count, so the bar is readable without
 * telling the colours apart, and the two fills that are closest under
 * colour-blindness never touch: there is a 2px gap of surface between
 * each pair.
 */
function msCqrBar(counts, total) {
  const n = total || MS_GRADES.reduce((s, g) => s + (counts[g] || 0), 0) + (counts.none || 0);
  if (!n) return `<div class="ms-bar-empty">Nothing rated yet</div>`;
  const segs = [...MS_GRADES, 'none']
    .filter(g => counts[g])
    .map(g => `<span class="ms-seg" style="width:${counts[g] / n * 100}%;background:${MS_C[g]}"
                 title="${g === 'none' ? 'Not rated' : g}: ${counts[g]}"></span>`).join('');
  const keys = [...MS_GRADES, 'none'].filter(g => counts[g]).map(g => `
    <span class="ms-key"><span class="ms-key-dot" style="background:${MS_C[g]}"></span>${
      g === 'none' ? 'Not rated' : g} ${counts[g]}</span>`).join('');
  return `<div class="ms-bar">${segs}</div><div class="ms-keys">${keys}</div>`;
}

/** The organic rating mix over a set of creatives, one vote each. */
function msMix(arr) {
  const t = { Good: 0, Average: 0, Poor: 0, none: 0 };
  arr.forEach(d => {
    const g = typeof bestOrganicGrade === 'function' ? bestOrganicGrade(d) : null;
    if (g && t[g] !== undefined) t[g]++; else t.none++;
  });
  return t;
}

/**
 * A six-point series as HTML bars.
 *
 * One series per panel rather than several on shared axes: the three
 * measures here are a count and a view total, and putting both on one
 * chart would need two scales.
 */
function msTrend(points, fmt, colour) {
  const max = Math.max(...points.map(p => p.v), 0);
  if (!max) return `<div class="ms-bar-empty">Nothing in this period</div>`;
  return `<div class="ms-trend">${points.map(p => `
    <div class="ms-trend-col" title="${msEsc(p.label)}: ${fmt(p.v)}">
      <div class="ms-trend-v">${p.v ? fmt(p.v) : ''}</div>
      <div class="ms-trend-track"><div class="ms-trend-fill"
        style="height:${Math.max(p.v ? 2 : 0, p.v / max * 100)}%;background:${colour}"></div></div>
      <div class="ms-trend-k">${msEsc(p.short)}</div>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------
//  The page
// ---------------------------------------------------------------------
function msRenderBody() {
  const data = msData();
  const head = document.getElementById('ms-head');
  const body = document.getElementById('ms-body');
  if (!body) return;

  const brandName = (typeof BRAND_NAME !== 'undefined' && BRAND_NAME) ? BRAND_NAME : '';
  const scope = [
    msFilters.campaign === 'all' ? 'All campaigns' : msFilters.campaign,
    msFilters.month === 'all' ? null : msFilters.month,
    msFilters.platform === 'all' ? null : (MS_PLATFORMS.find(p => p.code === msFilters.platform) || {}).label,
    msFilters.bucket === 'all' ? null : MS_BUCKET_LABEL[msFilters.bucket],
  ].filter(Boolean).join(' · ');

  // No heading of its own: the topbar already says Media Summary, and two
  // headings one above the other is what the old tab did.
  if (head) head.innerHTML = `<div class="ms-scope">${
    brandName ? `<b>${msEsc(brandName)}</b> · ` : ''}${msEsc(scope)} · ${
    data.length} creative${data.length === 1 ? '' : 's'}</div>`;

  if (!data.length) {
    body.innerHTML = `<div class="ms-card"><div class="ms-bar-empty">
      Nothing matches this selection. Widen a filter above.</div></div>`;
    return;
  }

  body.innerHTML =
    msSectionOutput(data) +
    msSectionTrend(data) +
    msSectionOrganic(data) +
    msSectionPaid(data) +
    msSectionWhatWorked(data) +
    msSectionCreators(data);
}

// ---------- 1. What went out ----------------------------------------
function msSectionOutput(data) {
  const by = { brand: 0, creator: 0, community: 0 };
  data.forEach(d => by[msBucket(d)]++);
  const rep = data.filter(d => d.isRepurposed).length;
  const boosted = data.filter(d => d.boostState !== 'never').length;
  const running = data.filter(d => d.boostState === 'running').length;

  const tiles =
    msTile('Creatives published', data.length,
           `${by.brand} Brand Say · ${by.creator + by.community} Others Say`) +
    msTile('Creators', by.creator,
           `${msPct(by.creator, data.length)}% of everything published`) +
    msTile('Community', by.community,
           `${msPct(by.community, data.length)}% of everything published`) +
    msTile('Repurposed', rep,
           rep ? `${msPct(rep, data.length)}% reworked from earlier content` : 'All original') +
    msTile('Boosted', boosted,
           boosted ? `${running} still running` : 'Nothing has had spend behind it');

  return `<div class="ms-sec">
    <div class="ms-sec-h">What went out</div>
    <div class="ms-tiles cols-5">${tiles}</div>
  </div>`;
}

// ---------- 2. The last six months ----------------------------------
function msSectionTrend(data) {
  // Up to six, and fewer when there is less. Months with nothing in them
  // are left in so the gaps are visible rather than closed up.
  const keys = [...new Set(data.map(d => d.month).filter(m => m && m !== 'Unknown'))]
    .sort((a, b) => msMonthKey(a) - msMonthKey(b));
  const months = keys.slice(-6);
  if (months.length < 2) return '';

  const inMonth = (m) => data.filter(d => d.month === m);
  const pts = (f) => months.map(m => ({
    label: m, short: m.replace(/^(\w{3})\w*\s+\d\d(\d\d)$/, '$1 $2'), v: f(inMonth(m)),
  }));

  const published = pts(a => a.length);
  const views = pts(a => a.reduce((s, d) =>
    s + MS_PLATFORMS.reduce((t, p) => t + msViews(d[p.key]), 0), 0));

  const note = `by publish month · ${months.length} month${months.length === 1 ? '' : 's'} on record`;

  return `<div class="ms-sec">
    <div class="ms-sec-h">The last ${months.length === 6 ? 'six months' : months.length + ' months'}</div>
    <div class="ms-grid cols-2">
      ${msCard('Creatives published', msTrend(published, v => String(v), MS_C.a), note)}
      ${msCard('Organic views', msTrend(views, v => fmtN(v), MS_C.a),
               'earned by content published that month, to date')}
    </div>
  </div>`;
}

// ---------- 3. Organic by platform ----------------------------------
function msSectionOrganic(data) {
  const rows = MS_PLATFORMS.map(p => {
    const posts = data.filter(d => d[p.key]);
    if (!posts.length) return null;
    const o = posts.map(d => d[p.key]);
    const views = o.reduce((s, x) => s + msViews(x), 0);
    const reach = o.reduce((s, x) => s + msNum(x.reach), 0);
    const inter = o.reduce((s, x) => s + msNum(x.totalInteractions ||
      (msNum(x.likes) + msNum(x.comments) + msNum(x.shares) + msNum(x.saves))), 0);
    const watchVals = o.map(x => msNum(x.avgWatchTime)).filter(v => v > 0);
    const watch = watchVals.length ? watchVals.reduce((a, b) => a + b, 0) / watchVals.length : 0;
    // Counted per platform rather than per creative: this table is about
    // how each platform did, so each post on it is its own observation.
    const mix = { Good: 0, Average: 0, Poor: 0, none: 0 };
    o.forEach(x => { if (typeof isGrade === 'function' && isGrade(x.cqr)) mix[x.cqr]++; else mix.none++; });
    return { p, posts: posts.length, views, reach, inter, watch, mix };
  }).filter(Boolean);

  if (!rows.length) {
    return `<div class="ms-sec"><div class="ms-sec-h">Organic by platform</div>
      <div class="ms-card"><div class="ms-bar-empty">No organic numbers have come back yet for this selection.</div></div>
    </div>`;
  }

  const totalViews = rows.reduce((s, r) => s + r.views, 0);

  const table = `
    <table class="ms-table">
      <thead><tr>
        <th>Platform</th><th class="n">Posts</th><th class="n">Views</th>
        <th class="n">Share of views</th><th class="n">Reach</th>
        <th class="n">Interactions</th><th class="n">Avg watch</th><th>CQR</th>
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td class="ms-plat">${r.p.label}</td>
          <td class="n">${r.posts}</td>
          <td class="n">${fmtN(r.views)}</td>
          <td class="n">${msPct(r.views, totalViews)}%</td>
          <td class="n">${fmtN(r.reach)}</td>
          <td class="n">${fmtN(r.inter)}</td>
          <td class="n">${r.watch ? r.watch.toFixed(1) + 's' : '—'}</td>
          <td class="ms-mixcell">${msCqrBar(r.mix, r.posts)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  return `<div class="ms-sec">
    <div class="ms-sec-h">Organic by platform</div>
    ${msCard('Every platform this content ran on', table,
             'one row per platform, counted per post')}
  </div>`;
}

// ---------- 4. Paid -------------------------------------------------
//
//  WHAT THIS SECTION IS FOR.
//
//  It answers what the paid creative taught us, not whether the buying
//  was right. Three rules follow from that and hold for every card here:
//
//    No money. Spend, CPM and anything a cost can be worked back from
//    stay off the page.
//
//    No buying decisions. Nothing says what was or was not boosted, kept
//    running, or switched off, because each of those reads as a verdict
//    on whoever planned it.
//
//    No names next to a negative finding. Patterns are counted; the
//    creatives behind them are not listed.
//
//  WHY THERE ARE NO RATES IN HERE EITHER.
//
//  011_paid_windowed.sql bands hook and hold against separate thresholds
//  for meta_paid and tt_paid, split again by Brand Say and Others Say, and
//  hold rate by duration on top of that. 31% on Meta and 29% on TikTok are
//  measured against different benchmarks, so the raw rates are never set
//  side by side. Every card counts ratings and bands instead, which are
//  already judged against the right benchmark.
// ---------------------------------------------------------------------

/**
 * The Pre-test Score's rating collapsed to three bands, matching the badge its own
 * panel shows, so the same creative is never Strong in one place and
 * positive in another.
 */
const MS_BS_TONE = {
  positive: 'Strong', veryPositive: 'Strong',
  medium: 'Mixed',
  negative: 'Weak', veryNegative: 'Weak',
  negativeTooLow: 'Weak', negativeTooHigh: 'Weak',
};
const MS_BS_BANDS = ['Strong', 'Mixed', 'Weak'];
// The paid rating each pre-flight band is predicting.
const MS_BS_CALLS = { Strong: 'Good', Mixed: 'Average', Weak: 'Poor' };

const msBsBand = (d) => MS_BS_TONE[d.bsRating] || null;
const msIsGrade = (v) => typeof isGrade === 'function' ? isGrade(v) : MS_GRADES.includes(v);

// Below this many creatives carrying both a Pre-test Score and a real
// paid rating, the agreement view is noise dressed as a finding.
const MS_BS_MIN = 8;

// Below this many rated creatives in a group, a pattern is one or two
// creatives' worth of luck, so the card waits rather than claiming one.
const MS_PAID_MIN = 3;

/** The paid rating mix over a set of creatives, one vote each. */
function msPaidMix(arr) {
  const t = { Good: 0, Average: 0, Poor: 0, none: 0 };
  arr.forEach(d => { if (msIsGrade(d.cqr)) t[d.cqr]++; else t.none++; });
  return t;
}

/** Each platform a creative ran paid on, as its own observation. */
const msPaidRuns = (data) => data.flatMap(d => [
  d._meta ? { ...d._meta, label: 'Meta' } : null,
  d._tt ? { ...d._tt, label: 'TikTok' } : null,
].filter(Boolean));

function msSectionPaid(data) {
  const boosted = data.filter(d => d.boostState !== 'never');
  if (!boosted.length) {
    return `<div class="ms-sec">
      <div class="ms-sec-h">Paid</div>
      <div class="ms-card"><div class="ms-bar-empty">
        Nothing in this selection has run on paid, so there is no paid delivery
        and no paid rating to show.</div></div>
    </div>`;
  }

  const sumF = (arr, f) => arr.reduce((s, x) => s + msNum(x[f]), 0);
  const impr = sumF(boosted, 'impressions');
  // Gross reach, summed per creative. d.reach is already the widest single
  // platform for that creative, so this double counts anyone reached by two
  // creatives, which is what makes it gross rather than unique.
  const grossReach = sumF(boosted, 'reach');
  const onMeta = boosted.filter(d => d._meta).length;
  const onTt = boosted.filter(d => d._tt).length;
  const live = boosted.filter(d => d.adStatus === 'ACTIVE').length;

  const tiles =
    msTile('Impressions', fmtN(impr), 'paid, across every platform') +
    msTile('Reach', fmtN(grossReach), 'gross, summed across creatives') +
    msTile('Creatives on paid', String(boosted.length),
      [onMeta ? `${onMeta} on Meta` : '', onTt ? `${onTt} on TikTok` : ''].filter(Boolean).join(' · ')) +
    msTile('Live now', String(live), live ? 'currently delivering' : 'nothing delivering today');

  const rated = boosted.filter(d => msIsGrade(d.cqr));

  const cards = [
    msPaidQualityOverTime(rated),
    msPaidHookHold(boosted),
  ].filter(Boolean);
  const pairs = [
    msPaidPlatformFit(boosted),
    msPaidWearOut(boosted),
  ].filter(Boolean);
  const learnings = msPaidWhatWorks(rated);
  const pretest = msPaidPretest(boosted);

  return `<div class="ms-sec">
    <div class="ms-sec-h">Paid</div>
    <div class="ms-note">What the paid creative taught us. Ratings are counted one creative at a
      time, each against its own platform's benchmark.</div>
    <div class="ms-tiles cols-4">${tiles}</div>
    ${cards.length ? `<div class="ms-grid cols-${Math.min(cards.length, 2)}">${cards.join('')}</div>` : ''}
    ${learnings}
    ${pairs.length ? `<div class="ms-grid cols-${Math.min(pairs.length, 2)}">${pairs.join('')}</div>` : ''}
    ${pretest}
  </div>`;
}

/**
 * Is the work getting better? The paid rating mix by publish month.
 *
 * Counted per creative rather than weighted by delivery, so the figure
 * follows the quality of what was made and not how much was put behind it.
 */
function msPaidQualityOverTime(rated) {
  const months = [...new Set(rated.map(d => d.month).filter(m => m && m !== 'Unknown'))]
    .sort((a, b) => msMonthKey(a) - msMonthKey(b)).slice(-6);
  if (months.length < 2) return '';

  const rows = months.map(m => {
    const items = rated.filter(d => d.month === m);
    return { m, items, mix: msPaidMix(items) };
  });
  const share = (r) => msPct(r.mix.Good, r.items.length);
  const first = rows[0], last = rows[rows.length - 1];
  const lead = share(last) > share(first)
    ? `${share(last)}% of paid creative published in ${msEsc(last.m)} rated Good, up from ${share(first)}% in ${msEsc(first.m)}.`
    : share(last) < share(first)
      ? `${share(last)}% of paid creative published in ${msEsc(last.m)} rated Good, against ${share(first)}% in ${msEsc(first.m)}.`
      : `The share rated Good has held at ${share(last)}% from ${msEsc(first.m)} to ${msEsc(last.m)}.`;

  return msCard('Quality over time', `
    <div class="ms-lead">${lead}</div>
    <table class="ms-table ms-table-cut">
      <tbody>${rows.map(r => `
        <tr>
          <td class="ms-cut-k">${msEsc(r.m)}<div class="ms-cut-n">${msCount(r.items.length, 'creative')}</div></td>
          <td class="ms-mixcell">${msCqrBar(r.mix, r.items.length)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`, 'paid rating by publish month');
}

/**
 * Which half of the video is holding it back.
 *
 * Each platform a creative ran on is read on its own, because hook and
 * hold are banded against that platform's thresholds. Only Strong counts
 * as clearing a bar: anything short of it is a gap worth editing for.
 */
function msPaidHookHold(boosted) {
  const runs = msPaidRuns(boosted).filter(r =>
    r.hookQual && r.holdQual && !/^No /.test(r.hookQual) && !/^No /.test(r.holdQual));
  if (runs.length < MS_PAID_MIN) return '';

  const strong = (q) => q === 'Strong';
  const groups = [
    { k: 'both',  label: 'Opens well and holds',            test: r => strong(r.hookQual) && strong(r.holdQual),   c: MS_C.Good },
    { k: 'hold',  label: 'Opens well, loses people after',  test: r => strong(r.hookQual) && !strong(r.holdQual),  c: MS_C.Average },
    { k: 'hook',  label: 'Slow opening, holds who stay',    test: r => !strong(r.hookQual) && strong(r.holdQual),  c: MS_C.Average },
    { k: 'none',  label: 'Short on both',                   test: r => !strong(r.hookQual) && !strong(r.holdQual), c: MS_C.Poor },
  ].map(g => ({ ...g, n: runs.filter(g.test).length }));

  const gaps = groups.filter(g => g.k === 'hold' || g.k === 'hook').sort((a, b) => b.n - a.n);
  const lead = gaps[0].n === 0
    ? 'Where creative falls short, it falls short on both halves at once rather than on one.'
    : gaps[0].k === 'hold'
      ? 'The opening is landing more often than the middle: the edit after the first seconds is where most is lost.'
      : 'The middle is holding more often than the opening: the first seconds are where most is lost.';
  const max = Math.max(...groups.map(g => g.n), 1);

  return msCard('Hook or hold', `
    <div class="ms-lead">${lead}</div>
    <div class="ms-compare-rows">${groups.map(g => `
      <div class="ms-compare-row">
        <div class="ms-compare-k">${g.label}</div>
        <div class="ms-compare-track"><div class="ms-compare-fill"
          style="width:${g.n ? Math.max(2, g.n / max * 100) : 0}%;background:${g.c}"></div></div>
        <div class="ms-compare-v">${g.n}</div>
      </div>`).join('')}</div>
    <div class="ms-foot">Counted per platform run (${runs.length}), each against that platform's own
      hook and hold thresholds. Strong clears the bar; anything less is counted as short.</div>`,
    'which half of the video to work on');
}

/**
 * What makes paid creative work: the rating mix cut by length, content
 * type and who posted it. The same view as What worked further down, on
 * the paid rating instead of organic.
 */
function msPaidWhatWorks(rated) {
  if (rated.length < MS_PAID_MIN) return '';
  // Length reads in its own order, shortest first; the rest by size.
  const cut = (title, groups, ordered) => {
    const rows = groups.filter(g => g.items.length)
      .map(g => ({ ...g, mix: msPaidMix(g.items) }));
    if (!ordered) rows.sort((a, b) => b.items.length - a.items.length);
    if (rows.length < 2) return '';
    return msCard(title, `
      <table class="ms-table ms-table-cut">
        <tbody>${rows.map(r => `
          <tr>
            <td class="ms-cut-k">${msEsc(r.label)}<div class="ms-cut-n">${msCount(r.items.length, 'creative')}</div></td>
            <td class="ms-mixcell">${msCqrBar(r.mix, r.items.length)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  };

  const bands = [
    { label: 'Under 10s', test: s => s > 0 && s < 10 },
    { label: '10 to 15s', test: s => s >= 10 && s < 15 },
    { label: '15 to 30s', test: s => s >= 15 && s < 30 },
    { label: '30 to 60s', test: s => s >= 30 && s < 60 },
    { label: '60s and over', test: s => s >= 60 },
  ];
  const typeNames = [...new Set(rated.map(d => d.contentType).filter(Boolean))];

  const cards = [
    cut('Length', bands.map(b => ({ label: b.label, items: rated.filter(d => b.test(msNum(d.duration))) })), true),
    cut('Content type', typeNames.map(t => ({ label: t, items: rated.filter(d => d.contentType === t) }))),
    cut('Who posted it', ['brand', 'creator', 'community'].map(b => ({
      label: MS_BUCKET_LABEL[b], items: rated.filter(d => msBucket(d) === b),
    }))),
  ].filter(Boolean);
  if (!cards.length) return '';

  return `
    <div class="ms-sub-h">What makes paid creative work</div>
    <div class="ms-note">Paid rating by the shape of the creative. Lessons for the next brief.</div>
    <div class="ms-grid cols-${Math.min(cards.length, 3)}">${cards.join('')}</div>`;
}

/**
 * Platform fit: creatives on both Meta and TikTok whose rating differs.
 *
 * A cut rated lower on one platform was usually not made native to it,
 * which is a production learning. Counts only, no names.
 */
function msPaidPlatformFit(boosted) {
  const RANK = { Good: 0, Average: 1, Poor: 2 };
  const both = boosted.filter(d => d._meta && d._tt && msIsGrade(d._meta.cqr) && msIsGrade(d._tt.cqr));
  if (both.length < MS_PAID_MIN) return '';

  const same = both.filter(d => d._meta.cqr === d._tt.cqr).length;
  const metaBetter = both.filter(d => RANK[d._meta.cqr] < RANK[d._tt.cqr]).length;
  const ttBetter = both.filter(d => RANK[d._tt.cqr] < RANK[d._meta.cqr]).length;

  const lead = metaBetter > ttBetter
    ? `${msCount(metaBetter, 'creative')} rated lower on TikTok than on Meta: those cuts were not made native to TikTok.`
    : ttBetter > metaBetter
      ? `${msCount(ttBetter, 'creative')} rated lower on Meta than on TikTok: those cuts were not made native to Meta.`
      : metaBetter
        ? 'Where the platforms disagree, neither one is consistently the weaker fit.'
        : 'Every creative on both platforms rated the same on each: the cuts are travelling well.';

  const parts = [
    { label: 'Same rating on both', n: same, c: MS_C.Good },
    { label: 'Better on Meta', n: metaBetter, c: MS_C.a },
    { label: 'Better on TikTok', n: ttBetter, c: MS_C.b },
  ];
  const max = Math.max(...parts.map(p => p.n), 1);

  return msCard('Platform fit', `
    <div class="ms-lead">${lead}</div>
    <div class="ms-compare-rows">${parts.map(p => `
      <div class="ms-compare-row">
        <div class="ms-compare-k">${p.label}</div>
        <div class="ms-compare-track"><div class="ms-compare-fill"
          style="width:${p.n ? Math.max(2, p.n / max * 100) : 0}%;background:${p.c}"></div></div>
        <div class="ms-compare-v">${p.n}</div>
      </div>`).join('')}</div>
    <div class="ms-foot">${msCount(both.length, 'creative')} rated on both Meta and TikTok, each against
      its own platform's benchmark.</div>`, 'does the cut travel');
}

/**
 * Wear-out as a pattern: of the creatives that ran long enough to compare
 * their first week with their last, how many kept their launch rating.
 *
 * Deliberately not a list. Which creatives slipped, and whether they were
 * still running when they did, is a buying question this page stays out of.
 */
function msPaidWearOut(boosted) {
  const checked = boosted.filter(d => d.fatigueChecked);
  if (checked.length < MS_PAID_MIN) return '';

  const slipped = checked.filter(d => d.fatiguing);
  const held = checked.length - slipped.length;
  const on = { meta: 0, tiktok: 0 };
  slipped.forEach(d => (d.fatigueOn || []).forEach(p => { if (on[p] !== undefined) on[p]++; }));
  const where = slipped.length && on.meta !== on.tiktok
    ? ` Where it slipped, it was more often on ${on.meta > on.tiktok ? 'Meta' : 'TikTok'}.` : '';

  const lead = slipped.length
    ? `${held} of ${checked.length} kept their launch rating into their last week.${where}`
    : `All ${checked.length} kept their launch rating into their last week.`;

  return msCard('Wear-out', `
    <div class="ms-lead">${lead}</div>
    ${msCountBar([
      { label: 'Held', n: held, c: MS_C.Good },
      { label: 'Slipped', n: slipped.length, c: MS_C.Average },
    ])}
    <div class="ms-foot">Creatives that ran at least two weeks with enough delivery in their last week
      to read, comparing the first week's rating with the last. Useful for setting refresh cycles.</div>`,
    'how long a rating lasts');
}

/**
 * How far the pre-test can be trusted: how often its pre-flight band
 * matched the paid rating the creative went on to earn.
 */
function msPaidPretest(boosted) {
  const both = boosted.filter(d => msBsBand(d) && msIsGrade(d.cqr));
  if (!boosted.some(d => msBsBand(d))) return '';

  let body;
  if (both.length < MS_BS_MIN) {
    body = `<div class="ms-bar-empty">
      ${msCount(both.length, 'creative')} so far ${both.length === 1 ? 'carries' : 'carry'} both a Pre-test Score
      and a paid rating. Below ${MS_BS_MIN} the match rate says more about which creatives happened to
      be scored than about the score itself, so it is held back.</div>`;
  } else {
    const called = both.filter(d => MS_BS_CALLS[msBsBand(d)] === d.cqr).length;
    const rows = MS_BS_BANDS.map(b => {
      const items = both.filter(d => msBsBand(d) === b);
      return { band: b, items, counts: msPaidMix(items) };
    }).filter(r => r.items.length);

    body = `
      <div class="ms-lead">The pre-test called ${called} of ${both.length} correctly
        (${msPct(called, both.length)}%).</div>
      <table class="ms-table ms-table-cut ms-table-narrow">
        <tbody>${rows.map(r => `
          <tr>
            <td class="ms-cut-k">Pre-test ${r.band}<div class="ms-cut-n">${msCount(r.items.length, 'creative')}</div></td>
            <td class="ms-mixcell">${msCqrBar(r.counts, r.items.length)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="ms-foot">A correct call is Strong ending Good, Mixed ending Average, or Weak ending Poor.
        How often it matches is a guide to how much weight the score deserves, not proof that it
        predicts every creative.</div>`;
  }

  return `<div class="ms-grid cols-1">${msCard('Pre-test accuracy', body, 'pre-flight score against paid rating')}</div>`;
}

/** A split of counts as one bar, in whatever parts the caller names. */
function msCountBar(parts) {
  const n = parts.reduce((s, p) => s + p.n, 0);
  const present = parts.filter(p => p.n);
  if (!n) return `<div class="ms-bar-empty">Nothing to split</div>`;
  return `
    <div class="ms-bar">${present.map(p =>
      `<span class="ms-seg" style="width:${p.n / n * 100}%;background:${p.c}"
         title="${msEsc(p.label)}: ${p.n}"></span>`).join('')}</div>
    <div class="ms-keys">${present.map(p => `
      <span class="ms-key"><span class="ms-key-dot" style="background:${p.c}"></span>${
        msEsc(p.label)} ${p.n}</span>`).join('')}</div>`;
}

/** "3 creatives", "1 creative". */
const msCount = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- 5. What worked ------------------------------------------
function msSectionWhatWorked(data) {
  // Rated on organic, not paid: organic is populated for everything, and
  // once there is spend behind a post its organic numbers include paid
  // delivery anyway, which is a different question from what the content
  // itself did.
  const cut = (title, groups) => {
    const rows = groups.filter(g => g.items.length)
      .map(g => ({ ...g, mix: msMix(g.items) }))
      .sort((a, b) => b.items.length - a.items.length);
    if (rows.length < 2) return '';
    return msCard(title, `
      <table class="ms-table ms-table-cut">
        <tbody>${rows.map(r => `
          <tr>
            <td class="ms-cut-k">${msEsc(r.label)}<div class="ms-cut-n">${r.items.length} creative${r.items.length === 1 ? '' : 's'}</div></td>
            <td class="ms-mixcell">${msCqrBar(r.mix, r.items.length)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  };

  const byBucket = cut('Who posted it', ['brand', 'creator', 'community'].map(b => ({
    label: MS_BUCKET_LABEL[b], items: data.filter(d => msBucket(d) === b),
  })));

  const bands = [
    { label: 'Under 10s', test: s => s > 0 && s < 10 },
    { label: '10 to 15s', test: s => s >= 10 && s < 15 },
    { label: '15 to 30s', test: s => s >= 15 && s < 30 },
    { label: '30 to 60s', test: s => s >= 30 && s < 60 },
    { label: '60s and over', test: s => s >= 60 },
  ];
  const byDuration = cut('Length', bands.map(b => ({
    label: b.label, items: data.filter(d => b.test(msNum(d.duration))),
  })));

  const typeNames = [...new Set(data.map(d => d.contentType).filter(Boolean))];
  const byType = cut('Content type', typeNames.map(t => ({
    label: t, items: data.filter(d => d.contentType === t),
  })));

  const cards = [byBucket, byDuration, byType].filter(Boolean);
  if (!cards.length) return '';

  return `<div class="ms-sec">
    <div class="ms-sec-h">What worked</div>
    <div class="ms-note">Rated on organic CQR, which exists for every creative whether or not it was boosted.</div>
    <div class="ms-grid cols-${Math.min(cards.length, 3)}">${cards.join('')}</div>
  </div>`;
}

// ---------- 6. Creators and Community ------------------------------
//
//  No ranking and no list. The Creators page holds every profile; this
//  section only says how Others Say content is doing against Brand Say,
//  which stays one card however many creators a brand works with.
function msSectionCreators(data) {
  const os = data.filter(d => d.type === 'Others Say');
  if (!os.length) return '';

  const handle = (d) => {
    const info = typeof extractCreatorInfo === 'function'
      ? extractCreatorInfo(d.creatorProfile, d.ttLink) : null;
    return (info && info.username) || d.creatorProfile || null;
  };
  const profiles = (arr) => new Set(arr.map(handle).filter(Boolean)).size;
  const views = (arr) => arr.reduce((s, d) => s + MS_PLATFORMS.reduce((t, p) => t + msViews(d[p.key]), 0), 0);

  const creators = os.filter(d => msBucket(d) === 'creator');
  const community = os.filter(d => msBucket(d) === 'community');
  const brand = data.filter(d => msBucket(d) === 'brand');

  const tiles =
    msTile('Creators', profiles(creators), `${creators.length} post${creators.length === 1 ? '' : 's'} between them`) +
    msTile('Community', profiles(community), `${community.length} post${community.length === 1 ? '' : 's'} between them`) +
    msTile('Share of organic views', msPct(views(os), views(data)) + '%',
           'from creators and community together');

  const rows = [
    { label: 'Creators', items: creators },
    { label: 'Community', items: community },
    { label: 'Brand Say', items: brand },
  ].filter(r => r.items.length);

  const table = rows.length > 1 ? msCard('Against Brand Say', `
    <table class="ms-table ms-table-cut">
      <tbody>${rows.map(r => `
        <tr>
          <td class="ms-cut-k">${r.label}<div class="ms-cut-n">${r.items.length} post${r.items.length === 1 ? '' : 's'}</div></td>
          <td class="ms-mixcell">${msCqrBar(msMix(r.items), r.items.length)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="ms-foot"><button class="ms-link" onclick="setNav('creators')">Open Creators</button></div>`,
    'organic rating, one vote per post') : '';

  return `<div class="ms-sec">
    <div class="ms-sec-h">Creators and Community</div>
    <div class="ms-tiles cols-3">${tiles}</div>
    ${table ? `<div class="ms-grid cols-1">${table}</div>` : ''}
  </div>`;
}

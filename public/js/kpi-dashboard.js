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
 * fmtN, fmt, cqrClass, isGrade, bestOrganicGrade, extractCreatorInfo.
 */

// ---------------------------------------------------------------------
//  Chart colour
//
//  Two slots for a two-way split and three for a rating. Both sets were
//  run through the palette validator rather than picked by eye:
//
//    #4747AD / #A8541F   worst adjacent pair ΔE 24.4 under protanopia
//    #04785C / #C07A12 / #A32040   worst adjacent ΔE 10.8 under protanopia
//
//  The Average step is lighter and more orange than the --warn token the
//  pills use. The token pair --warn and --neg are only ΔE 5.8 apart under
//  deuteranopia and 14.5 in normal vision, which is below the floor: side
//  by side in one bar, Average and Poor are genuinely hard to tell apart.
//  The tokens are left alone because they carry text elsewhere, where they
//  sit against white and never touch each other; these are for fills.
// ---------------------------------------------------------------------
const MS_C = {
  a: '#4747AD', b: '#A8541F',
  Good: '#04785C', Average: '#C07A12', Poor: '#A32040',
  none: '#C3C3D6',
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
 * contradict each other (Brand Say plus Community page selects nothing).
 * They are one axis with three values.
 */
function msBucket(d) {
  if (d.type === 'Brand Say') return 'brand';
  return d.source === 'community' ? 'community' : 'influencer';
}
const MS_BUCKET_LABEL = { brand: 'Brand Say', influencer: 'Influencer', community: 'Community' };

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
                                ['influencer', 'Influencers'], ['community', 'Community pages']]);

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
 * measures here are a count, a view total and a money total, and putting
 * any two of them on one chart would need two scales.
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
  const by = { brand: 0, influencer: 0, community: 0 };
  data.forEach(d => by[msBucket(d)]++);
  const rep = data.filter(d => d.isRepurposed).length;
  const boosted = data.filter(d => d.boostState !== 'never').length;
  const running = data.filter(d => d.boostState === 'running').length;

  const tiles =
    msTile('Creatives published', data.length,
           `${by.brand} Brand Say · ${by.influencer + by.community} Others Say`) +
    msTile('Influencer', by.influencer,
           `${msPct(by.influencer, data.length)}% of everything published`) +
    msTile('Community pages', by.community,
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
  const spend = pts(a => a.reduce((s, d) => s + msNum(d.spend), 0));
  const anySpend = spend.some(p => p.v > 0);

  const note = `by publish month · ${months.length} month${months.length === 1 ? '' : 's'} on record`;

  return `<div class="ms-sec">
    <div class="ms-sec-h">The last ${months.length === 6 ? 'six months' : months.length + ' months'}</div>
    <div class="ms-grid ${anySpend ? 'cols-3' : 'cols-2'}">
      ${msCard('Creatives published', msTrend(published, v => String(v), MS_C.a), note)}
      ${msCard('Organic views', msTrend(views, v => fmtN(v), MS_C.a),
               'earned by content published that month, to date')}
      ${anySpend ? msCard('Paid spend', msTrend(spend, v => fmt(v), MS_C.b),
               'lifetime spend on content published that month') : ''}
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
function msSectionPaid(data) {
  const spend = data.reduce((s, d) => s + msNum(d.spend), 0);
  if (!spend) {
    return `<div class="ms-sec">
      <div class="ms-sec-h">Paid</div>
      <div class="ms-card"><div class="ms-bar-empty">
        Nothing in this selection has had spend behind it, so there is no paid
        delivery, no cost efficiency and no paid rating to show.</div></div>
    </div>`;
  }

  const reach = data.reduce((s, d) => Math.max(s, msNum(d.reach)), 0);
  const impr = data.reduce((s, d) => s + msNum(d.impressions), 0);
  const freq = reach ? impr / reach : 0;
  const cpm = impr ? spend / impr * 1000 : 0;
  const boosted = data.filter(d => d.boostState !== 'never');

  // Where the money went, by the rating of what it went behind.
  const mix = { Good: 0, Average: 0, Poor: 0, none: 0 };
  data.forEach(d => {
    const g = (typeof isGrade === 'function' && isGrade(d.cqr)) ? d.cqr : 'none';
    mix[g] += msNum(d.spend);
  });

  const tiles =
    msTile('Spend', fmt(spend), `${boosted.length} creative${boosted.length === 1 ? '' : 's'} boosted`) +
    msTile('Reach', fmtN(reach), 'largest single-platform reach') +
    msTile('Impressions', fmtN(impr), `${freq.toFixed(2)}x frequency`) +
    msTile('CPM', 'Rs. ' + cpm.toFixed(2), 'per thousand impressions');

  // Meta against TikTok, from the per-platform blocks rather than the
  // rolled-up fields, so a creative running on both counts on both.
  const side = (k) => data.map(d => d[k]).filter(Boolean);
  const meta = side('_meta'), tt = side('_tt');
  const sum = (a, f) => a.reduce((s, x) => s + msNum(x[f]), 0);
  const mean = (a, f) => { const v = a.map(x => msNum(x[f])).filter(n => n > 0);
    return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };

  const platRow = (label, mv, tv, fmtF, lowerIsBetter) => {
    if (!meta.length || !tt.length || mv === tv || (!mv && !tv)) {
      return `<tr><td>${label}</td><td class="n">${meta.length ? fmtF(mv) : '—'}</td><td class="n">${tt.length ? fmtF(tv) : '—'}</td></tr>`;
    }
    const metaWins = lowerIsBetter ? mv < tv : mv > tv;
    return `<tr><td>${label}</td>
      <td class="n ${metaWins ? 'ms-better' : ''}">${fmtF(mv)}</td>
      <td class="n ${metaWins ? '' : 'ms-better'}">${fmtF(tv)}</td></tr>`;
  };

  const mSpend = sum(meta, 'spend'), tSpend = sum(tt, 'spend');
  const mImpr = sum(meta, 'impressions'), tImpr = sum(tt, 'impressions');
  const money = v => fmt(v), count = v => fmtN(v), rs = v => 'Rs. ' + v.toFixed(2), one = v => v.toFixed(1);

  const platTable = (meta.length || tt.length) ? `
    <table class="ms-table">
      <thead><tr><th></th><th class="n">Meta</th><th class="n">TikTok</th></tr></thead>
      <tbody>
        ${platRow('Creatives', meta.length, tt.length, v => String(v), false)}
        ${platRow('Spend', mSpend, tSpend, money, false)}
        ${platRow('Reach', sum(meta, 'reach'), sum(tt, 'reach'), count, false)}
        ${platRow('Impressions', mImpr, tImpr, count, false)}
        ${platRow('CPM', mImpr ? mSpend / mImpr * 1000 : 0, tImpr ? tSpend / tImpr * 1000 : 0, rs, true)}
        ${platRow('Hook rate', mean(meta, 'hookRate'), mean(tt, 'hookRate'), v => one(v) + '%', false)}
        ${platRow('Hold rate', mean(meta, 'holdRate'), mean(tt, 'holdRate'), v => one(v) + '%', false)}
        ${platRow('Avg watch', mean(meta, 'watchTime'), mean(tt, 'watchTime'), v => one(v) + 's', false)}
        ${platRow('Still running', meta.filter(x => x.adStatus === 'ACTIVE').length,
                  tt.filter(x => x.adStatus === 'ACTIVE').length, v => String(v), false)}
      </tbody>
    </table>
    <div class="ms-foot">The stronger side of each comparable row is marked.</div>` : '';

  return `<div class="ms-sec">
    <div class="ms-sec-h">Paid</div>
    <div class="ms-tiles cols-4">${tiles}</div>
    <div class="ms-grid cols-2">
      ${msCard('Where the money went', msSpendMix(mix, spend), 'spend by the rating of what it ran behind')}
      ${platTable ? msCard('Meta against TikTok', platTable) : ''}
    </div>
  </div>`;
}

/** Spend split by rating. Money, so the segments carry amounts. */
function msSpendMix(mix, total) {
  if (!total) return `<div class="ms-bar-empty">No spend to split</div>`;
  const order = [...MS_GRADES, 'none'].filter(g => mix[g] > 0);
  if (!order.length) return `<div class="ms-bar-empty">No spend to split</div>`;
  return `
    <div class="ms-bar">${order.map(g =>
      `<span class="ms-seg" style="width:${mix[g] / total * 100}%;background:${MS_C[g]}"
         title="${g === 'none' ? 'Not rated' : g}: ${fmt(mix[g])}"></span>`).join('')}</div>
    <div class="ms-keys">${order.map(g => `
      <span class="ms-key"><span class="ms-key-dot" style="background:${MS_C[g]}"></span>${
        g === 'none' ? 'Not rated' : g} ${fmt(mix[g])} (${msPct(mix[g], total)}%)</span>`).join('')}</div>`;
}

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

  const byBucket = cut('Who posted it', ['brand', 'influencer', 'community'].map(b => ({
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

// ---------- 6. Creators ---------------------------------------------
function msSectionCreators(data) {
  const os = data.filter(d => d.type === 'Others Say' && d.creatorProfile);
  if (!os.length) return '';

  const byCreator = {};
  os.forEach(d => {
    const info = (typeof extractCreatorInfo === 'function')
      ? extractCreatorInfo(d.creatorProfile, d.ttLink) : null;
    const n = (info && info.username) || d.creatorProfile;
    if (!n) return;
    (byCreator[n] ||= { name: n, posts: 0, good: 0, scored: 0, views: 0 });
    byCreator[n].posts++;
    MS_PLATFORMS.forEach(p => {
      const o = d[p.key];
      if (!o) return;
      byCreator[n].views += msViews(o);
      if (typeof isGrade === 'function' && isGrade(o.cqr)) {
        byCreator[n].scored++;
        if (o.cqr === 'Good') byCreator[n].good++;
      }
    });
  });

  const ranked = Object.values(byCreator)
    .sort((a, b) => (b.scored ? b.good / b.scored : -1) - (a.scored ? a.good / a.scored : -1)
                 || b.views - a.views)
    .slice(0, 8);
  if (!ranked.length) return '';

  const osViews = os.reduce((s, d) => s + MS_PLATFORMS.reduce((t, p) => t + msViews(d[p.key]), 0), 0);
  const allViews = data.reduce((s, d) => s + MS_PLATFORMS.reduce((t, p) => t + msViews(d[p.key]), 0), 0);

  const tiles =
    msTile('Creators active', Object.keys(byCreator).length, `${os.length} posts between them`) +
    msTile('Share of organic views', msPct(osViews, allViews) + '%',
           `${fmtN(osViews)} of ${fmtN(allViews)}`) +
    msTile('Top creator', ranked[0].name,
           ranked[0].scored ? `${msPct(ranked[0].good, ranked[0].scored)}% rated Good` : `${fmtN(ranked[0].views)} views`);

  const table = `
    <table class="ms-table">
      <thead><tr><th>Creator</th><th class="n">Posts</th><th class="n">Views</th><th class="n">Rated Good</th></tr></thead>
      <tbody>${ranked.map(c => `
        <tr>
          <td class="ms-plat">${msEsc(c.name)}</td>
          <td class="n">${c.posts}</td>
          <td class="n">${fmtN(c.views)}</td>
          <td class="n">${c.scored ? msPct(c.good, c.scored) + '%' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="ms-foot"><button class="ms-link" onclick="setNav('creators')">Open Creators</button></div>`;

  return `<div class="ms-sec">
    <div class="ms-sec-h">Creators</div>
    <div class="ms-tiles cols-3">${tiles}</div>
    ${msCard('Ranked on how often their posts are rated Good', table,
             'views as the tie-break, not the ranking')}
  </div>`;
}

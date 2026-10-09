/* =====================================================================
   creators.js — Creator deep dive
   New file: public/js/creators.js

   Reads the same global ALL array the other tabs use. Nothing new is
   fetched, so no backend change is needed.

   Design notes:
   - The TABLE is the primary object, not the charts. Everything is
     searchable and sortable; nothing is capped at "top 8".
   - A minimum-videos filter exists because a creator with one lucky
     asset otherwise outranks one with eight consistent ones.
   - Consistency is shown as the CQR spread, not only the mean. Four
     assets scoring G/G/G/A is a different proposition from G/P/G/P at
     the same average.
   - Cost columns appear only when paid spend is actually attributed.
     With creative_id matching incomplete they would read zero, and a
     confident zero is worse than an honest gap.
   ===================================================================== */

// Default sort is quality, not reach. Ranking creators by views rewards
// whoever got the most impressions rather than whoever made the best work.
let CREATOR_SORT = { key: 'goodShare', dir: 'desc' };
let CREATOR_SEARCH = '';
let CREATOR_MIN_VIDEOS = 1;
let CREATOR_PLATFORM = 'all';
let CREATOR_CAMPAIGN = 'all';
let CREATOR_MONTH = 'all';
let SELECTED_CREATOR = null;

// ---------------------------------------------------------------------
//  Aggregate ALL into one row per creator
// ---------------------------------------------------------------------
function buildCreators() {
  const src = (typeof ALL !== 'undefined' ? ALL : [])
    .filter(d => d.type === 'Others Say' && d.creatorProfile)
    // Campaign and month are applied here, not to the creator list, so
    // the aggregated figures describe the filtered period only.
    .filter(d => CREATOR_CAMPAIGN === 'all' || d.campaign === CREATOR_CAMPAIGN)
    .filter(d => CREATOR_MONTH === 'all' || d.month === CREATOR_MONTH);

  const map = {};
  src.forEach(d => {
    const info = (typeof extractCreatorInfo === 'function')
      ? extractCreatorInfo(d.creatorProfile, d.ttLink) : null;
    const name = (info && info.username) || d.creatorProfile;
    if (!name) return;

    if (!map[name]) map[name] = {
      name, profileUrl: (info && info.profileUrl) || null,
      assets: [], igViews: 0, ttViews: 0, fbViews: 0,
      watch: [], hooks: [], holds: [], durations: [],
      spend: 0, paidAssets: 0,
      cqr: { Good: 0, Average: 0, Poor: 0 },
      orgCqr: { Good: 0, Average: 0, Poor: 0 },
      igCount: 0, ttCount: 0, fbCount: 0,
    };
    const c = map[name];
    c.assets.push(d);
    if (d.duration) c.durations.push(d.duration);

    if (d.igOrganic) {
      c.igViews += d.igOrganic.views || 0; c.igCount++;
      if (d.igOrganic.avgWatchTime > 0) c.watch.push(d.igOrganic.avgWatchTime);
      if (c.orgCqr[d.igOrganic.cqr] !== undefined) c.orgCqr[d.igOrganic.cqr]++;
    }
    if (d.ttOrganic) {
      c.ttViews += d.ttOrganic.views || 0; c.ttCount++;
      if (d.ttOrganic.avgWatchTime > 0) c.watch.push(d.ttOrganic.avgWatchTime);
      if (c.orgCqr[d.ttOrganic.cqr] !== undefined) c.orgCqr[d.ttOrganic.cqr]++;
    }
    if (d.fbOrganic) {
      c.fbViews += d.fbOrganic.videoViews || d.fbOrganic.views || 0; c.fbCount++;
      if (c.orgCqr[d.fbOrganic.cqr] !== undefined) c.orgCqr[d.fbOrganic.cqr]++;
    }

    if (d.spend > 0) {
      c.spend += d.spend; c.paidAssets++;
      if (d.hookRate > 0) c.hooks.push(d.hookRate);
      if (d.holdRate > 0) c.holds.push(d.holdRate);
      if (c.cqr[d.cqr] !== undefined) c.cqr[d.cqr]++;
    }
  });

  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  return Object.values(map).map(c => {
    const totalViews = c.igViews + c.ttViews + c.fbViews;
    const scored = c.orgCqr.Good + c.orgCqr.Average + c.orgCqr.Poor;
    // Share of scored organic posts that were Good or Average. This is
    // the number worth renewing a partnership on — a mean CQR hides
    // whether the good result was repeatable.
    const validRate = scored ? (c.orgCqr.Good + c.orgCqr.Average) / scored * 100 : null;
    return {
      ...c,
      videos: c.assets.length,
      totalViews,
      avgViews: c.assets.length ? totalViews / c.assets.length : 0,
      avgWatch: mean(c.watch),
      avgHook: mean(c.hooks),
      avgHold: mean(c.holds),
      // Share of scored organic posts rating Good. CQR is the composite
      // of both signals, so it is the right primary measure — engagement
      // rate alone is stored as a raw weighted ratio for Others Say and
      // is not comparable with Brand Say's plain rate.
      goodShare: scored ? c.orgCqr.Good / scored * 100 : null,
      scoredPosts: scored,
      avgDuration: mean(c.durations),
      validRate,
      igShare: totalViews ? c.igViews / totalViews * 100 : 0,
      ttShare: totalViews ? c.ttViews / totalViews * 100 : 0,
      fbShare: totalViews ? c.fbViews / totalViews * 100 : 0,
      platforms: [c.igCount ? 'IG' : '', c.ttCount ? 'TT' : '', c.fbCount ? 'FB' : ''].filter(Boolean)
    };
  });
}

function filteredCreators() {
  let list = buildCreators();
  if (CREATOR_SEARCH) {
    const q = CREATOR_SEARCH.toLowerCase();
    list = list.filter(c => c.name.toLowerCase().includes(q));
  }
  if (CREATOR_MIN_VIDEOS > 1) list = list.filter(c => c.videos >= CREATOR_MIN_VIDEOS);
  if (CREATOR_PLATFORM !== 'all') {
    list = list.filter(c => c.platforms.includes(CREATOR_PLATFORM));
  }
  const k = CREATOR_SORT.key, dir = CREATOR_SORT.dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av ?? -1) - (bv ?? -1)) * dir;
  });
}

function sortCreators(key) {
  if (CREATOR_SORT.key === key) {
    CREATOR_SORT.dir = CREATOR_SORT.dir === 'desc' ? 'asc' : 'desc';
  } else {
    CREATOR_SORT = { key, dir: 'desc' };
  }
  renderCreatorTab();
}

function setCreatorSearch(v) {
  CREATOR_SEARCH = v; renderCreatorTab();
  // renderCreatorTab replaces the DOM, so the input loses focus on every
  // keystroke unless it is restored with the caret at the end.
  const el = document.getElementById('cr-search');
  if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
}
function setCreatorMinVideos(v) { CREATOR_MIN_VIDEOS = parseInt(v) || 1; renderCreatorTab(); }
function setCreatorPlatform(v) { CREATOR_PLATFORM = v; renderCreatorTab(); }

// ---------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------
function renderCreatorTab() {
  const page = document.getElementById('page-creators');
  if (!page) return;

  const all = buildCreators();
  const list = filteredCreators();

  // Options come from the unfiltered set — deriving them from the
  // filtered set would leave only the option already selected.
  const osAll = (typeof ALL !== 'undefined' ? ALL : [])
    .filter(d => d.type === 'Others Say' && d.creatorProfile);
  const campaignOpts = [...new Set(osAll.map(d => d.campaign).filter(Boolean))].sort();
  const monthOpts = [...new Set(osAll.map(d => d.month).filter(Boolean))].sort();

  if (all.length === 0) {
    page.innerHTML = `<div class="content"><div class="organic-empty">
      No creator content for ${typeof BRAND_NAME !== 'undefined' ? BRAND_NAME : 'this brand'} yet.
      Creators appear here once Others Say assets are added.
    </div></div>`;
    return;
  }

  const totalAssets = all.reduce((s, c) => s + c.videos, 0);
  const totalViews  = all.reduce((s, c) => s + c.totalViews, 0);
  const withPaid    = all.filter(c => c.spend > 0);
  const scoredAll   = all.filter(c => c.validRate !== null);
  const avgValid    = scoredAll.length
    ? scoredAll.reduce((s, c) => s + c.validRate, 0) / scoredAll.length : null;

  const th = (key, label, width) =>
    `<th style="${width ? `width:${width};` : ''}cursor:pointer" onclick="sortCreators('${key}')">
       ${label}${CREATOR_SORT.key === key ? (CREATOR_SORT.dir === 'desc' ? ' ↓' : ' ↑') : ''}
     </th>`;

  const maxViews = Math.max(...list.map(c => c.totalViews), 1);

  page.innerHTML = `
  <div class="content">

    <div class="kpi-row" style="grid-template-columns:repeat(4,1fr)">
      <div class="kpi">
        <div class="kpi-label">Creators</div>
        <div class="kpi-val">${all.length}</div>
        <div class="kpi-sub">${totalAssets} assets produced</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Creator Views</div>
        <div class="kpi-val">${fmtN(totalViews)}</div>
        <div class="kpi-sub">Across IG, TikTok and Facebook</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Validation Rate</div>
        <div class="kpi-val">${avgValid !== null ? avgValid.toFixed(0) + '%' : '—'}</div>
        <div class="kpi-sub">${avgValid !== null ? 'Posts scoring Good or Average' : 'No scored organic posts yet'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Amplified</div>
        <div class="kpi-val">${withPaid.length}</div>
        <div class="kpi-sub">Creators with paid spend behind them</div>
      </div>
    </div>

    <div class="cr-toolbar">
      <span class="cr-flabel">Campaign</span>
      <select onchange="setCreatorCampaign(this.value)">
        <option value="all"${CREATOR_CAMPAIGN === 'all' ? ' selected' : ''}>All campaigns</option>
        ${campaignOpts.map(c => `<option value="${c}"${CREATOR_CAMPAIGN === c ? ' selected' : ''}>${c}</option>`).join('')}
      </select>

      <span class="cr-flabel">Month</span>
      <div class="cr-pills">
        <button class="cr-pill ${CREATOR_MONTH === 'all' ? 'cr-pill-on' : ''}"
                onclick="setCreatorMonth('all')">All</button>
        ${monthOpts.map(m => `<button class="cr-pill ${CREATOR_MONTH === m ? 'cr-pill-on' : ''}"
                onclick="setCreatorMonth('${m}')">${m}</button>`).join('')}
      </div>

      <input id="cr-search" class="search-input" placeholder="Search creator..."
             value="${CREATOR_SEARCH}" oninput="setCreatorSearch(this.value)">
      <select onchange="setCreatorPlatform(this.value)">
        <option value="all"${CREATOR_PLATFORM === 'all' ? ' selected' : ''}>All platforms</option>
        <option value="IG"${CREATOR_PLATFORM === 'IG' ? ' selected' : ''}>Instagram</option>
        <option value="TT"${CREATOR_PLATFORM === 'TT' ? ' selected' : ''}>TikTok</option>
        <option value="FB"${CREATOR_PLATFORM === 'FB' ? ' selected' : ''}>Facebook</option>
      </select>
      <select onchange="setCreatorMinVideos(this.value)">
        <option value="1"${CREATOR_MIN_VIDEOS === 1 ? ' selected' : ''}>All creators</option>
        <option value="2"${CREATOR_MIN_VIDEOS === 2 ? ' selected' : ''}>2+ assets</option>
        <option value="3"${CREATOR_MIN_VIDEOS === 3 ? ' selected' : ''}>3+ assets</option>
        <option value="5"${CREATOR_MIN_VIDEOS === 5 ? ' selected' : ''}>5+ assets</option>
      </select>
      <span class="cr-count">${list.length} of ${all.length} creators</span>
    </div>

    <div class="chart-box" style="padding:0;overflow-x:auto">
      <table class="kpi-table">
        <thead><tr>
          ${th('name','Creator')}
          ${th('videos','Assets','70px')}
          ${th('totalViews','Total Views','150px')}
          ${th('goodShare','Quality','90px')}
          ${th('avgWatch','Avg Watch','90px')}
          ${th('avgHook','Hook Rate','90px')}
          ${th('avgDuration','Length','80px')}
          ${th('validRate','Validated','150px')}
          <th style="width:120px">Platform mix</th>
        </tr></thead>
        <tbody>
          ${list.map(c => {
            const g = c.orgCqr.Good, a = c.orgCqr.Average, p = c.orgCqr.Poor;
            const nameEl = c.profileUrl
              ? `<a href="${c.profileUrl}" target="_blank" class="creator-link">${c.name}</a>`
              : c.name;
            // A single-asset creator's averages are not a track record.
            const thin = c.videos < 2
              ? `<span class="tag-duration" title="Single asset — not yet a pattern">1 asset</span>` : '';
            return `<tr data-press style="cursor:pointer" onclick="openCreatorDetail('${c.name.replace(/'/g,"\\'")}', this)">
              <td><div style="display:flex;align-items:center;gap:6px">${nameEl}${thin}</div></td>
              <td>${c.videos}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
                  <div class="mini-bar-track" style="flex:1;max-width:70px">
                    <div class="mini-bar-fill" style="width:${Math.round(c.totalViews/maxViews*100)}%;background:var(--violet)"></div>
                  </div>
                  <span>${fmtN(c.totalViews)}</span>
                </div>
              </td>
              <td>${c.goodShare !== null
                ? `<span style="color:${c.goodShare >= 60 ? 'var(--pos-ink)' : c.goodShare >= 30 ? 'var(--warn-ink)' : 'var(--neg-ink)'}">${c.goodShare.toFixed(0)}% Good</span>`
                : '<span class="kpi-muted">—</span>'}</td>
              <td>${c.avgWatch > 0 ? c.avgWatch.toFixed(1) + 's' : '—'}</td>
              <td>${c.avgHook > 0 ? c.avgHook.toFixed(1) + '%' : '—'}</td>
              <td>${c.avgDuration > 0 ? Math.round(c.avgDuration) + 's' : '—'}</td>
              <td>
                ${g + a + p > 0 ? `
                  <div style="display:flex;height:4px;border-radius:2px;overflow:hidden;min-width:60px">
                    ${g ? `<div style="flex:${g};background:var(--pos-ink)"></div>` : ''}
                    ${a ? `<div style="flex:${a};background:var(--warn-ink)"></div>` : ''}
                    ${p ? `<div style="flex:${p};background:var(--neg-ink)"></div>` : ''}
                  </div>
                  <div style="font:500 11px var(--font-mono);color:var(--ink-400);margin-top:4px">
                    ${g}G / ${a}A / ${p}P
                  </div>` : '<span class="kpi-muted">Not scored</span>'}
              </td>
              <td>
                <div style="display:flex;height:4px;border-radius:2px;overflow:hidden">
                  ${c.igShare ? `<div style="flex:${c.igShare};background:var(--navy)"></div>` : ''}
                  ${c.ttShare ? `<div style="flex:${c.ttShare};background:var(--violet)"></div>` : ''}
                  ${c.fbShare ? `<div style="flex:${c.fbShare};background:var(--violet-400)"></div>` : ''}
                </div>
                <div style="font:500 11px var(--font-mono);color:var(--ink-400);margin-top:4px">${c.platforms.join(' ')}</div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div class="charts-row" style="margin-top:24px">
      <div class="chart-box">
        <div class="chart-box-title">Creative quality by creator</div>
        <div class="cr-note">
          Organic CQR per creator, sorted by share of Good. CQR combines both
          signals, so it says more than either rate on its own.
        </div>
        <div class="chart-container" style="height:300px"><canvas id="cr-cqr"></canvas></div>
      </div>
      <div class="chart-box">
        <div class="chart-box-title">Platform mix — share of each creator's views</div>
        <div class="cr-note">
          Which platform a creator owns, independent of how big they are.
        </div>
        <div class="chart-container" style="height:300px"><canvas id="cr-mix"></canvas></div>
      </div>
    </div>

    <div class="charts-row" style="margin-top:16px">
      <div class="chart-box">
        <div class="chart-box-title">Hook rate by creator</div>
        <div class="cr-note">
          Whether the opening stops the scroll. Bar colour is against the
          paid benchmark for the platform the asset ran on.
        </div>
        <div class="chart-container" style="height:260px"><canvas id="cr-hook"></canvas></div>
      </div>
      <div class="chart-box">
        <div class="chart-box-title">Hold rate by creator</div>
        <div class="cr-note">
          Whether the asset keeps them once hooked. A creator strong here
          but weak on hook needs a recut, not replacing.
        </div>
        <div class="chart-container" style="height:260px"><canvas id="cr-hold"></canvas></div>
      </div>
    </div>

    <div class="charts-row" style="margin-top:16px">
      <div class="chart-box">
        <div class="chart-box-title">Asset length vs quality</div>
        <div class="cr-note">
          Each point is one asset. Shows whether shorter creator content
          scores better for this brand.
        </div>
        <div class="chart-container" style="height:240px"><canvas id="cr-duration"></canvas></div>
      </div>
      <div class="chart-box">
        <div class="chart-box-title">Creator vs Brand Say</div>
        <div class="cr-note">
          Organic CQR mix, creator content against owned content.
        </div>
        <div class="chart-container" style="height:240px"><canvas id="cr-vs-brand"></canvas></div>
      </div>
    </div>

  </div>`;

  drawCreatorCharts(list, all);
}

// ---------------------------------------------------------------------
//  Charts. Two, both answering questions the table cannot.
// ---------------------------------------------------------------------
let crCqr = null, crMix = null, crHook = null, crHold = null,
    crDuration = null, crVsBrand = null;

const CR_GOOD = '#04785C', CR_AVG = '#8A5A12', CR_POOR = '#A32040';
const CR_GRID = '#E6E8F0', CR_TICK = '#6B7196';

function drawCreatorCharts(list, all) {
  [crCqr, crMix, crHook, crHold, crDuration, crVsBrand]
    .forEach(c => { if (c) c.destroy(); });

  const short = n => n.length > 14 ? n.slice(0, 12) + '…' : n;

  // 1. CQR mix per creator — the primary view. Sorted by share of Good
  //    rather than volume, so the top of the chart is the best work.
  const q = [...list].filter(c => c.scoredPosts > 0)
    .sort((a, b) => (b.goodShare ?? -1) - (a.goodShare ?? -1)).slice(0, 12);
  crCqr = new Chart(document.getElementById('cr-cqr'), {
    type: 'bar',
    data: {
      labels: q.map(c => short(c.name)),
      datasets: [
        { label: 'Good',    data: q.map(c => c.orgCqr.Good),    backgroundColor: CR_GOOD },
        { label: 'Average', data: q.map(c => c.orgCqr.Average), backgroundColor: CR_AVG },
        { label: 'Poor',    data: q.map(c => c.orgCqr.Poor),    backgroundColor: CR_POOR }
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CR_TICK, font: { size: 11 }, boxWidth: 10 } },
                 tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw} post${ctx.raw === 1 ? '' : 's'}` } } },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: CR_GRID },
             ticks: { color: CR_TICK, precision: 0 } },
        y: { stacked: true, grid: { display: false }, ticks: { color: CR_TICK, font: { size: 10 } } }
      }
    }
  });

  // 2. Platform mix, as share
  const top = list.slice(0, 12);
  crMix = new Chart(document.getElementById('cr-mix'), {
    type: 'bar',
    data: {
      labels: top.map(c => short(c.name)),
      datasets: [
        { label: 'Instagram', data: top.map(c => c.igShare), backgroundColor: '#000050' },
        { label: 'TikTok',    data: top.map(c => c.ttShare), backgroundColor: '#31117C' },
        { label: 'Facebook',  data: top.map(c => c.fbShare), backgroundColor: '#6E5BD6' }
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CR_TICK, font: { size: 11 }, boxWidth: 10 } },
                 tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toFixed(0)}%` } } },
      scales: {
        x: { stacked: true, max: 100, grid: { color: CR_GRID },
             ticks: { color: CR_TICK, callback: v => v + '%' } },
        y: { stacked: true, grid: { display: false }, ticks: { color: CR_TICK, font: { size: 10 } } }
      }
    }
  });

  // 3 & 4. Hook and hold separately, each ranked and colour-graded.
  //    Split rather than combined because the actions differ: weak hook
  //    means recut the opening, weak hold means recut the body.
  const rankBar = (canvasId, key, unit, bands, chartRef) => {
    const d = [...list].filter(c => c[key] > 0)
      .sort((a, b) => b[key] - a[key]).slice(0, 10);
    return new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: d.map(c => short(c.name)),
        datasets: [{
          data: d.map(c => parseFloat(c[key].toFixed(1))),
          backgroundColor: d.map(c => c[key] >= bands[0] ? CR_GOOD
                                    : c[key] >= bands[1] ? CR_AVG : CR_POOR)
        }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
                   tooltip: { callbacks: { label: ctx => `${ctx.raw}${unit}` } } },
        scales: {
          x: { beginAtZero: true, grid: { color: CR_GRID },
               ticks: { color: CR_TICK, callback: v => v + unit } },
          y: { grid: { display: false }, ticks: { color: CR_TICK, font: { size: 10 } } }
        }
      }
    });
  };
  // Bands follow the paid benchmarks: Meta hook 10, TikTok hook 30.
  // Using 30/10 grades against the tougher of the two.
  crHook = rankBar('cr-hook', 'avgHook', '%', [30, 10]);
  crHold = rankBar('cr-hold', 'avgHold', '%', [15, 7]);

  // 5. Length vs quality, per asset. Points coloured by that asset's
  //    best organic CQR, so the pattern is visible without a legend.
  const pts = { Good: [], Average: [], Poor: [] };
  all.forEach(c => c.assets.forEach(a => {
    if (!a.duration) return;
    const best = a.bestOrgCqr || a.cqr;
    if (pts[best]) pts[best].push({ x: a.duration, y: c.goodShare ?? 0, name: a.short || a.id });
  }));
  crDuration = new Chart(document.getElementById('cr-duration'), {
    type: 'scatter',
    data: { datasets: [
      { label: 'Good',    data: pts.Good,    backgroundColor: CR_GOOD, pointRadius: 6 },
      { label: 'Average', data: pts.Average, backgroundColor: CR_AVG,  pointRadius: 6 },
      { label: 'Poor',    data: pts.Poor,    backgroundColor: CR_POOR, pointRadius: 6 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CR_TICK, font: { size: 11 }, boxWidth: 10 } },
                 tooltip: { callbacks: { label: ctx => `${ctx.raw.name}: ${ctx.raw.x}s` } } },
      scales: {
        x: { title: { display: true, text: 'Asset length (s)', color: CR_TICK, font: { size: 11 } },
             beginAtZero: true, grid: { color: CR_GRID }, ticks: { color: CR_TICK } },
        y: { title: { display: true, text: "Creator's % Good", color: CR_TICK, font: { size: 11 } },
             min: 0, max: 100, grid: { color: CR_GRID },
             ticks: { color: CR_TICK, callback: v => v + '%' } }
      }
    }
  });

  // 6. Creator vs owned, on CQR mix rather than a single rate.
  const bs = (typeof ALL !== 'undefined' ? ALL : []).filter(d => d.type === 'Brand Say');
  const tally = arr => {
    const t = { Good: 0, Average: 0, Poor: 0 };
    arr.forEach(d => ['igOrganic', 'fbOrganic', 'ttOrganic'].forEach(k => {
      const o = d[k]; if (o && t[o.cqr] !== undefined) t[o.cqr]++;
    }));
    return t;
  };
  const crAssets = []; all.forEach(c => c.assets.forEach(a => crAssets.push(a)));
  const ct = tally(crAssets), bt = tally(bs);

  crVsBrand = new Chart(document.getElementById('cr-vs-brand'), {
    type: 'bar',
    data: {
      labels: ['Creator', 'Brand Say'],
      datasets: [
        { label: 'Good',    data: [ct.Good, bt.Good],       backgroundColor: CR_GOOD },
        { label: 'Average', data: [ct.Average, bt.Average], backgroundColor: CR_AVG },
        { label: 'Poor',    data: [ct.Poor, bt.Poor],       backgroundColor: CR_POOR }
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CR_TICK, font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: CR_GRID },
             ticks: { color: CR_TICK, precision: 0 } },
        y: { stacked: true, grid: { display: false }, ticks: { color: CR_TICK } }
      }
    }
  });
}

// ---------------------------------------------------------------------
//  Detail — one creator's assets, so the conversation moves from
//  "this creator is good" to "this asset worked, and here is why"
// ---------------------------------------------------------------------
/** @param {Element} [trigger] the row that was clicked, so the panel
 *  grows out of it rather than appearing from nowhere. */
function openCreatorDetail(name, trigger) {
  const c = buildCreators().find(x => x.name === name);
  if (!c) return;

  const PLAT = { ig: 'Instagram', tt: 'TikTok', fb: 'Facebook' };

  // One block per asset, and inside it one column per platform. A single
  // combined row hid the fact that the same asset can score Good on
  // TikTok and Poor on Instagram — which is the actionable part.
  const assetBlocks = c.assets.map(a => {
    const platCols = ['ig','tt','fb'].map(k => {
      const o = a[k + 'Organic'];
      if (!o) return `
        <div class="cr-plat-col cr-plat-empty">
          <div class="cr-plat-name">${PLAT[k]}</div>
          <div class="organic-empty">Not posted</div>
        </div>`;
      const views = o.views || o.videoViews || 0;
      const row = (label, val) => `
        <div class="organic-stat-row"><span class="organic-stat-label">${label}</span>
        <span class="organic-stat-val">${val}</span></div>`;
      return `
        <div class="cr-plat-col">
          <div class="cr-plat-name">${PLAT[k]}</div>
          ${row('Views', fmtN(views))}
          ${row('Reach', o.reach ? fmtN(o.reach) : '—')}
          ${row(k === 'fb' ? 'Reactions' : 'Likes', fmtN(o.likes || o.reactions || 0))}
          ${row('Comments', fmtN(o.comments || 0))}
          ${row('Shares', fmtN(o.shares || 0))}
          ${k !== 'fb' ? row('Saves', fmtN(o.saves || 0)) : ''}
          ${row('Avg watch', o.avgWatchTime ? o.avgWatchTime.toFixed(1) + 's' : '—')}
          ${row('Retention', o.retentionRate ? o.retentionRate.toFixed(1) + '%' : '—')}
          <div style="margin-top:8px">
            <span class="kpi-pill ${cqrClass(o.cqr)}">${o.cqr || 'Not scored'}</span>
          </div>
        </div>`;
    }).join('');

    const paid = a.spend > 0 ? `
      <div class="cr-paid-strip">
        <div><span class="cr-paid-label">Spend</span> ${fmt(a.spend)}</div>
        <div><span class="cr-paid-label">Reach</span> ${fmtN(a.reach || 0)}</div>
        <div><span class="cr-paid-label">Hook</span> ${(a.hookRate || 0).toFixed(1)}%</div>
        <div><span class="cr-paid-label">Hold</span> ${(a.holdRate || 0).toFixed(1)}</div>
        <div><span class="kpi-pill ${cqrClass(a.cqr)}">${a.cqr}</span></div>
      </div>`
      : `<div class="cr-paid-strip"><span class="kpi-muted">Not boosted — organic only</span></div>`;

    const brief = (a.contentHook || (a.segments && a.segments.length)) ? `
      <details class="org-details" style="margin-top:12px">
        <summary class="org-summary">Creative brief
          <span style="color:var(--ink-400);font-size:10px">Click to expand ▼</span></summary>
        <div class="org-content">
          ${a.contentHook ? `<div class="brief-hook"><span class="brief-hook-label">Hook</span>
            <div class="brief-hook-text">${a.contentHook}</div></div>` : ''}
          ${(a.segments || []).length ? `<div class="brief-segs" style="margin-top:12px">${
            a.segments.map((sg, i2) => `<div class="seg-row">
              <div class="seg-label">${['0–25%','25–50%','50–75%','75–100%'][i2] || ''}</div>
              <div class="seg-text">${sg}</div></div>`).join('')
          }</div>` : ''}
        </div>
      </details>` : '';

    return `
      <div class="cr-asset">
        <div class="cr-asset-head">
          <div>
            <div class="cr-asset-title">${a.short || a.id}</div>
            <div class="cr-asset-meta">${[a.campaign, a.month, a.duration ? a.duration + 's' : null]
              .filter(Boolean).join(' · ')}</div>
          </div>
          ${a.creativeLink ? `<button class="view-btn" onclick="window.open('${a.creativeLink}','_blank')">View ↗</button>` : ''}
        </div>
        ${paid}
        <div class="cr-plat-grid">${platCols}</div>
        ${brief}
      </div>`;
  }).join('');

  document.getElementById('creativeModalContent').innerHTML = `
    <div class="cm-body">
      <div class="detail-header">
        <div>
          <div class="detail-title">${c.profileUrl
            ? `<a href="${c.profileUrl}" target="_blank" class="creator-link">${c.name}</a>` : c.name}</div>
          <div class="detail-meta">${c.videos} asset${c.videos > 1 ? 's' : ''} · ${fmtN(c.totalViews)} views · ${c.platforms.join(' · ')}</div>
        </div>
        <button class="close-btn" onclick="closeCreativeModal({target:{id:'creativeModalOverlay'}})">×</button>
      </div>

      <div class="detail-metrics" style="margin-bottom:20px">
        <div class="dm"><div class="dm-label">Avg views / asset</div><div class="dm-val">${fmtN(Math.round(c.avgViews))}</div></div>
        <div class="dm"><div class="dm-label">Quality</div><div class="dm-val">${c.goodShare !== null ? c.goodShare.toFixed(0) + '% Good' : '—'}</div>
          <div style="font:400 12px var(--font-ui);color:var(--ink-500);margin-top:4px">${c.orgCqr.Good}G · ${c.orgCqr.Average}A · ${c.orgCqr.Poor}P</div></div>
        <div class="dm"><div class="dm-label">Avg watch time</div><div class="dm-val">${c.avgWatch > 0 ? c.avgWatch.toFixed(1) + 's' : '—'}</div></div>
        <div class="dm"><div class="dm-label">Paid spend</div><div class="dm-val">${c.spend > 0 ? fmt(c.spend) : '—'}</div>
          <div style="font:400 12px var(--font-ui);color:var(--ink-500);margin-top:4px">${c.paidAssets} of ${c.videos} amplified</div></div>
      </div>

      ${assetBlocks}
    </div>`;
  // Through the shared opener in dashboard.js, so this panel arrives the
  // same way the Creative Hub's does and picks up the same spring state.
  if (typeof showCreativePanel === 'function') showCreativePanel(trigger);
  else document.getElementById('creativeModalOverlay').style.display = 'flex';
}

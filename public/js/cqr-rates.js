/**
 * Media Summary: CQR Good rate, Hook Good rate and Hold Good rate, and
 * engagement rate and cost per engagement.
 *
 * Paid video, weighted by impressions, from /api/cqr-rates
 * (server/cqr-rollup.js). The rest of Media Summary is built in the
 * browser from the creatives already loaded and counts one vote per
 * creative; this card is worked out on the server because a date range
 * needs the daily delivery, which the page does not hold.
 *
 * The card has its own date range. Of the page's filters it follows only
 * Campaign; Month, Platform and Posted by are about organic posts and
 * publish months, so they do not apply here and the card says so.
 *
 * Loaded after kpi-dashboard.js and uses its helpers: msEsc, msCard, fmtN.
 */

const CQRR = {
  range: 'all', from: '', to: '',
  plat: 'combined',
  measure: 'quality',
  compare: false,
  data: null, key: null, loading: false, error: null,
  cmp: null, cmpKey: null, cmpLoading: false, cmpError: null,
  seq: 0, cmpSeq: 0,
};

const CQRR_RANGES = [
  ['all', 'All time'], ['last30', 'Last 30 days'], ['thisMonth', 'This month'],
  ['lastMonth', 'Last month'], ['thisYear', 'This year'], ['custom', 'Custom'],
];
const CQRR_PLATS = [['combined', 'Combined'], ['meta', 'Meta'], ['tiktok', 'TikTok']];
const CQRR_MEASURES = [['quality', 'Video quality'], ['engagement', 'Engagement']];

const cqrrIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The selected range as dates. Null means open at that end. */
function cqrrDates() {
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  switch (CQRR.range) {
    case 'last30': { const f = new Date(today); f.setDate(f.getDate() - 29); return [cqrrIso(f), cqrrIso(today)]; }
    case 'thisMonth': return [cqrrIso(new Date(today.getFullYear(), today.getMonth(), 1)), cqrrIso(today)];
    case 'lastMonth': return [cqrrIso(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
                              cqrrIso(new Date(today.getFullYear(), today.getMonth(), 0))];
    case 'thisYear': return [cqrrIso(new Date(today.getFullYear(), 0, 1)), cqrrIso(today)];
    case 'custom': return [CQRR.from || null, CQRR.to || null];
    default: return [null, null];
  }
}

// The presets name their period, so the server can match the true reach
// the Reach sync fetched for exactly that period. Custom has none.
const CQRR_PERIOD = { all: 'all_time', last30: 'last_30', thisMonth: 'this_month', lastMonth: 'last_month', thisYear: 'this_year' };

function cqrrQuery(extra) {
  const [from, to] = cqrrDates();
  const p = new URLSearchParams();
  if (typeof BRAND_ID !== 'undefined' && BRAND_ID) p.set('brand', BRAND_ID);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (CQRR_PERIOD[CQRR.range]) p.set('period', CQRR_PERIOD[CQRR.range]);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

async function cqrrGet(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not load the CQR rates.');
  return body;
}

// ---------------------------------------------------------------------
//  Loading
// ---------------------------------------------------------------------
function cqrrAfterRender() {
  const key = cqrrQuery();
  if (CQRR.key !== key && !(CQRR.loading && CQRR.loadingKey === key)) cqrrLoad(key);
  if (CQRR.compare) {
    const ck = cqrrQuery({ compare: 1 });
    if (CQRR.cmpKey !== ck && !(CQRR.cmpLoading && CQRR.cmpLoadingKey === ck)) cqrrLoadCompare(ck);
  }
}

async function cqrrLoad(key) {
  const seq = ++CQRR.seq;
  CQRR.loading = true; CQRR.loadingKey = key; CQRR.error = null;
  cqrrPaint();
  try {
    const data = await cqrrGet(`/api/cqr-rates?${key}`);
    if (seq !== CQRR.seq) return;
    CQRR.data = data; CQRR.key = key;
    if (!data.can_compare) CQRR.compare = false;
  } catch (e) {
    if (seq !== CQRR.seq) return;
    CQRR.error = (typeof connectionMessage === 'function' ? connectionMessage(e) : null) || e.message;
    CQRR.key = key;
  } finally {
    if (seq === CQRR.seq) { CQRR.loading = false; cqrrPaint(); }
  }
}

async function cqrrLoadCompare(key) {
  const seq = ++CQRR.cmpSeq;
  CQRR.cmpLoading = true; CQRR.cmpLoadingKey = key; CQRR.cmpError = null;
  cqrrPaint();
  try {
    const p = new URLSearchParams(key); p.delete('compare'); p.delete('brand');
    const data = await cqrrGet(`/api/cqr-rates/compare?${p.toString()}`);
    if (seq !== CQRR.cmpSeq) return;
    CQRR.cmp = data; CQRR.cmpKey = key;
  } catch (e) {
    if (seq !== CQRR.cmpSeq) return;
    CQRR.cmpError = (typeof connectionMessage === 'function' ? connectionMessage(e) : null) || e.message;
    CQRR.cmpKey = key;
  } finally {
    if (seq === CQRR.cmpSeq) { CQRR.cmpLoading = false; cqrrPaint(); }
  }
}

// ---------------------------------------------------------------------
//  Controls
// ---------------------------------------------------------------------
function cqrrSetRange(v) {
  CQRR.range = v;
  if (v === 'custom' && !CQRR.from && !CQRR.to) {
    const [f, t] = (() => { const s = CQRR.data && CQRR.data.span; return [s && s.first_day, s && s.last_day]; })();
    CQRR.from = f || ''; CQRR.to = t || '';
  }
  cqrrPaint(); cqrrAfterRender();
}
function cqrrSetDate(which, v) {
  CQRR[which] = v;
  if (CQRR.from && CQRR.to && CQRR.from > CQRR.to) { cqrrPaint(); return; }
  cqrrAfterRender();
}
function cqrrSetPlat(v) { CQRR.plat = v; cqrrPaint(); }
function cqrrSetMeasure(v) { CQRR.measure = v; cqrrPaint(); }
function cqrrToggleCompare() { CQRR.compare = !CQRR.compare; cqrrPaint(); cqrrAfterRender(); }

// ---------------------------------------------------------------------
//  Drawing
// ---------------------------------------------------------------------

/** 18.2 to "18%". Never rounds a part up to the whole or a sliver down to none. */
function cqrrPct(v) {
  if (v === null || v === undefined) return '–';
  if (v > 0 && v < 1) return '<1%';
  if (v < 100 && v >= 99.5) return '>99%';
  return `${Math.round(v)}%`;
}
const cqrrVideos = (n, d) => `(${n} of ${d} video${d === 1 ? '' : 's'})`;

// data-k carries the column name, for the stacked layout on a phone.
function cqrrCell(k, rate, n, d) {
  if (!d) return `<td class="n" data-k="${k}"><span><span class="cqrr-v">–</span><span class="cqrr-n">(none rated)</span></span></td>`;
  return `<td class="n" data-k="${k}"><span><span class="cqrr-v">${cqrrPct(rate)}</span><span class="cqrr-n">${cqrrVideos(n, d)}</span></span></td>`;
}

/** The four figures for one row, after its label cell. */
function cqrrCells(f, withImpr) {
  if (!f || !f.impressions) {
    return `<td class="n cqrr-none" colspan="${withImpr ? 5 : 4}">No paid video delivery in this range</td>`;
  }
  return cqrrCell('CQR Good rate', f.cqr_good_rate, f.cqr_good_n, f.rated_n)
    + cqrrCell('Hook Good rate', f.hook_good_rate, f.hook_good_n, f.rated_n)
    + cqrrCell('Hold Good rate', f.hold_good_rate, f.hold_good_n, f.rated_n)
    + cqrrCell('Impressions rated', f.rated_share, f.rated_n, f.video_n)
    + (withImpr ? `<td class="n" data-k="Impressions">${fmtN(f.impressions)}</td>` : '');
}

const CQRR_HEAD = `<th class="n">CQR Good rate</th><th class="n">Hook Good rate</th>
  <th class="n">Hold Good rate</th><th class="n">Impressions rated</th>`;

// ---- Engagement --------------------------------------------------------
function cqrrEr(v) {
  if (v === null || v === undefined) return '–';
  if (v > 0 && v < 0.01) return '<0.01%';
  return `${Number(v).toFixed(2)}%`;
}
function cqrrLkr(v) {
  if (v === null || v === undefined) return '–';
  return `LKR ${Number(v) >= 1000 ? fmtN(Number(v)) : Number(v).toFixed(2)}`;
}
// Engagements in full up to a million: "1K" hides most of a small number.
const cqrrCount = (v) => (Number(v) < 1e6 ? Number(v || 0).toLocaleString('en-US') : fmtN(Number(v)));
const cqrrCreatives = (n, d) => `(${n} of ${d} creative${d === 1 ? '' : 's'})`;

/** Engagement figures for one row, after its label cell. */
/** Why a row has no engagement rate, in a few words. */
function cqrrNoRate(f, status) {
  if (status === 'custom') return 'preset ranges only';
  if (status === 'not_fetched' || status === 'not_ready') return 'reach not fetched yet';
  if (!f.reach) return 'no reach for this';
  return 'no engagement data';
}

function cqrrEngCells(f, withImpr, status) {
  const span = withImpr ? 6 : 5;
  if (!f || !f.paid_impressions) {
    return `<td class="n cqrr-none" colspan="${span}">No paid delivery in this range</td>`;
  }
  if (!f.eng_impressions) {
    return `<td class="n cqrr-none" colspan="${span}">No engagement data for these days yet</td>`;
  }
  const rate = f.paid_engagement_rate !== null && f.paid_engagement_rate !== undefined
    ? `<span class="cqrr-v">${cqrrEr(f.paid_engagement_rate)}</span><span class="cqrr-n">${cqrrCreatives(f.eng_creative_n, f.paid_creative_n)}</span>`
    : `<span class="cqrr-v">–</span><span class="cqrr-n">(${cqrrNoRate(f, status)})</span>`;
  const reach = f.reach
    ? `${cqrrCount(f.reach)}${f.reach_basis === 'account' ? '<span class="cqrr-n">(whole ad account)</span>' : ''}`
    : '–';
  return `<td class="n" data-k="Engagement rate"><span>${rate}</span></td>`
    + `<td class="n" data-k="Cost per engagement"><span class="cqrr-v">${cqrrLkr(f.cost_per_engagement)}</span></td>`
    + `<td class="n" data-k="Engagements">${cqrrCount(f.engagements)}</td>`
    + `<td class="n" data-k="Reach"><span>${reach}</span></td>`
    + `<td class="n" data-k="Impressions covered">${cqrrPct(f.eng_coverage)}</td>`
    + (withImpr ? `<td class="n" data-k="Impressions">${fmtN(f.paid_impressions)}</td>` : '');
}

const CQRR_ENG_HEAD = `<th class="n">Engagement rate</th><th class="n">Cost per engagement</th>
  <th class="n">Engagements</th><th class="n">Reach</th><th class="n">Impressions covered</th>`;

const cqrrIsEng = () => CQRR.measure === 'engagement';
const cqrrImpr = (f) => (f ? (cqrrIsEng() ? f.paid_impressions : f.impressions) || 0 : 0);
const cqrrRowCells = (f, withImpr, status) => (cqrrIsEng() ? cqrrEngCells(f, withImpr, status) : cqrrCells(f, withImpr));
const cqrrRowHead = () => (cqrrIsEng() ? CQRR_ENG_HEAD : CQRR_HEAD);

const cqrrDay = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function cqrrRangeLabel() {
  const r = CQRR_RANGES.find(([v]) => v === CQRR.range);
  if (CQRR.range !== 'custom') return r ? r[1] : '';
  const fmt = (s) => s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  if (CQRR.from && CQRR.to) return `${fmt(CQRR.from)} to ${fmt(CQRR.to)}`;
  if (CQRR.from) return `From ${fmt(CQRR.from)}`;
  if (CQRR.to) return `Up to ${fmt(CQRR.to)}`;
  return 'All time';
}

function cqrrControls() {
  const d = CQRR.data;
  const span = d && d.span;
  const bad = CQRR.range === 'custom' && CQRR.from && CQRR.to && CQRR.from > CQRR.to;
  const seg = (opts, cur, fn) => `<div class="so-seg">${opts.map(([v, t]) =>
    `<button type="button" class="so-seg-btn${cur === v ? ' active' : ''}" onclick="${fn}('${v}')">${t}</button>`).join('')}</div>`;
  return `<div class="cqrr-ctl">
    <div class="ms-fgroup">
      <span class="ms-flabel">Dates</span>
      <select class="kfi-select" onchange="cqrrSetRange(this.value)" aria-label="Date range">
        ${CQRR_RANGES.map(([v, t]) => `<option value="${v}"${CQRR.range === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>
    ${CQRR.range === 'custom' ? `<div class="cqrr-dates">
      <input type="date" value="${msEsc(CQRR.from)}" aria-label="From"
        ${span && span.first_day ? `min="${msEsc(span.first_day)}"` : ''} onchange="cqrrSetDate('from', this.value)">
      <span>to</span>
      <input type="date" value="${msEsc(CQRR.to)}" aria-label="To"
        ${span && span.last_day ? `max="${msEsc(span.last_day)}"` : ''} onchange="cqrrSetDate('to', this.value)">
    </div>` : ''}
    <div class="ms-fgroup">
      <span class="ms-flabel">Tables below</span>
      <div class="cqrr-segs">
        ${seg(CQRR_MEASURES, CQRR.measure, 'cqrrSetMeasure')}
        ${seg(CQRR_PLATS, CQRR.plat, 'cqrrSetPlat')}
      </div>
    </div>
    ${d && d.can_compare ? `<button type="button" class="so-seg-btn cqrr-cmp-btn${CQRR.compare ? ' active' : ''}"
        onclick="cqrrToggleCompare()">${CQRR.compare ? 'Hide brand comparison' : 'Compare brands'}</button>` : ''}
  </div>
  ${bad ? `<div class="cqrr-err">The start date is after the end date.</div>` : ''}`;
}

function cqrrScope(d) {
  const camp = (typeof msFilters !== 'undefined' && msFilters.campaign !== 'all') ? msFilters.campaign : null;
  if (!camp) return { camp, src: d.overall, scope: 'All campaigns' };
  const c = d.campaigns.find((x) => x.name === camp);
  return { camp, src: c || { meta: null, tiktok: null, combined: null }, scope: camp };
}

function cqrrSummary(d) {
  const { camp, src, scope } = cqrrScope(d);
  const row = (label, f, strong) => `<tr${strong ? ' class="cqrr-total"' : ''}>
    <td class="ms-plat">${label}</td>${cqrrCells(f)}</tr>`;
  return msCard(`<span>Video quality: ${msEsc(scope)}<span class="cqrr-sub">${msEsc(cqrrRangeLabel())}</span></span>`,
    `<div class="cqrr-scroll"><table class="ms-table cqrr-table">
      <thead><tr><th>Platform</th>${CQRR_HEAD}</tr></thead>
      <tbody>${row('Meta', src.meta)}${row('TikTok', src.tiktok)}${row('Combined', src.combined, true)}</tbody>
    </table></div>`,
    camp ? 'Follows the Campaign filter above' : 'Paid video, weighted by impressions');
}

function cqrrEngagement(d) {
  const { camp, src, scope } = cqrrScope(d);
  const title = `<span>Engagement: ${msEsc(scope)}<span class="cqrr-sub">${msEsc(cqrrRangeLabel())}</span></span>`;
  if (!d.engagement_ready) {
    return msCard(title, `<div class="ms-bar-empty">Engagement figures appear once the engagement data has been loaded.</div>`);
  }
  const status = d.reach && d.reach.status;
  const row = (label, f, strong) => `<tr${strong ? ' class="cqrr-total"' : ''}>
    <td class="ms-plat">${label}</td>${cqrrEngCells(f, false, status)}</tr>`;
  const why = {
    custom: 'Engagement rate is on true reach, which Meta and TikTok give only for the preset ranges. Pick a preset date range to see it.',
    not_fetched: 'True reach for this period has not been fetched yet. The Reach sync runs each night.',
    not_ready: 'True reach has not been set up yet.',
  }[status];
  const dates = status === 'ok' && d.reach.period !== 'all_time' && d.reach.start
    ? `Reach and engagements cover ${cqrrDay(d.reach.start)} to ${cqrrDay(d.reach.end)}.` : '';
  return msCard(title,
    `${why ? `<div class="cqrr-why">${why}</div>` : ''}<div class="cqrr-scroll"><table class="ms-table cqrr-table">
      <thead><tr><th>Platform</th>${CQRR_ENG_HEAD}</tr></thead>
      <tbody>${row('Meta', src.meta)}${row('TikTok', src.tiktok)}${row('Combined', src.combined, true)}</tbody>
    </table></div>${dates ? `<div class="cqrr-why">${dates}</div>` : ''}`,
    camp ? 'Follows the Campaign filter above' : 'Every paid creative');
}

function cqrrCampaigns(d) {
  const camp = (typeof msFilters !== 'undefined' && msFilters.campaign !== 'all') ? msFilters.campaign : null;
  if (camp || d.campaigns.length < 2) return '';
  const pl = CQRR_PLATS.find(([v]) => v === CQRR.plat)[1];
  const what = cqrrIsEng() ? 'Engagement' : 'Video quality';
  if (cqrrIsEng() && !d.engagement_ready) return '';
  const rows = d.campaigns.filter((c) => cqrrImpr(c[CQRR.plat]) > 0)
    .sort((a, b) => cqrrImpr(b[CQRR.plat]) - cqrrImpr(a[CQRR.plat]));
  if (!rows.length) return msCard(`${what} by campaign`, `<div class="ms-bar-empty">No ${msEsc(pl)} paid ${cqrrIsEng() ? '' : 'video '}delivery in this range.</div>`, pl);
  return msCard(`${what} by campaign`,
    `<div class="cqrr-scroll"><table class="ms-table cqrr-table">
      <thead><tr><th>Campaign</th>${cqrrRowHead()}<th class="n">Impressions</th></tr></thead>
      <tbody>${rows.map((c) => `<tr><td class="ms-plat cqrr-name">${msEsc(c.name)}</td>${cqrrRowCells(c[CQRR.plat], true, d.reach && d.reach.status)}</tr>`).join('')}</tbody>
    </table></div>`, `${pl}, most impressions first`);
}

function cqrrCompare() {
  if (!CQRR.compare) return '';
  const pl = CQRR_PLATS.find(([v]) => v === CQRR.plat)[1];
  let body;
  if (CQRR.cmpError) body = `<div class="cqrr-err">${msEsc(CQRR.cmpError)}</div>`;
  else if (!CQRR.cmp || CQRR.cmpLoading && CQRR.cmpKey !== cqrrQuery({ compare: 1 })) body = `<div class="ms-bar-empty">Loading the brands…</div>`;
  else {
    const me = typeof BRAND_ID !== 'undefined' ? BRAND_ID : '';
    const rows = CQRR.cmp.brands.slice().sort((a, b) => cqrrImpr(b[CQRR.plat]) - cqrrImpr(a[CQRR.plat]));
    body = cqrrIsEng() && !CQRR.cmp.engagement_ready
      ? `<div class="ms-bar-empty">Engagement figures appear once the engagement data has been loaded.</div>`
      : `<div class="cqrr-scroll"><table class="ms-table cqrr-table">
      <thead><tr><th>Brand</th>${cqrrRowHead()}<th class="n">Impressions</th></tr></thead>
      <tbody>${rows.map((b) => `<tr${b.brand_id === me ? ' class="cqrr-total"' : ''}>
        <td class="ms-plat cqrr-name">${msEsc(b.name)}</td>${cqrrRowCells(b[CQRR.plat], true, CQRR.cmp.reach && CQRR.cmp.reach.status)}</tr>`).join('')}</tbody>
    </table></div>`;
  }
  return msCard(`<span>${cqrrIsEng() ? 'Engagement' : 'Video quality'}, brands side by side<span class="cqrr-sub">${msEsc(cqrrRangeLabel())}</span></span>`, body,
    `${pl}, same dates and rules for every brand`);
}

const CQRR_FOOT = `CQR is the creative quality rating. Each paid video is rated Good, Average or Poor
  on its hook rate and hold rate. CQR Good rate is the share of impressions on videos rated Good.
  Hook Good rate and Hold Good rate are the share of impressions on videos whose hook or hold is
  rated Good. All three are shares of the same total: impressions on videos with a CQR grade.
  Ratings are based on each video's full paid run; for a date range, only impressions inside the
  range are counted. Videos under 10,000 impressions are not rated and are left out of all three;
  Impressions rated shows how much of the paid video delivery is covered. Combined adds Meta and
  TikTok impressions together rather than averaging the two rates, and a video that ran on both
  counts once on each. The figure in brackets counts videos rather than impressions. Campaign is
  the campaign the video was added under in Campaign Lens.`;

/** The engagement half of the footnote. Instagram follows are named only as Meta reports them. */
function cqrrEngFoot(d) {
  const ig = d && d.inputs && d.inputs.ig_follows;
  return `Engagement rate is engagements divided by reach, over every paid creative. Reach is the
  number of different people who saw the ads in that period, as Meta and TikTok report it. It cannot
  be added up from days or ads, so it is fetched for each preset range every night, and a custom
  range has no engagement rate. Combined divides all engagements by Meta reach plus TikTok reach,
  so someone reached on both platforms counts twice.
  On Meta, engagements are post reactions, comments, shares, saves, link clicks${ig ? ', Instagram follows' : ''}
  and Facebook page likes. On TikTok, they are paid likes, comments, shares, follows and destination
  clicks. Not counted: 3-second plays, Post engagement and Clicks (all). TikTok favorites are not
  available from TikTok's ads reporting, so they are left out.${ig
    ? ' Meta reports Instagram follows from July 2025 only.'
    : ' Meta has not reported Instagram follows for these ads, so they are not included.'}
  Cost per engagement is spend in LKR divided by the same engagements. Only days with engagement
  data count; Impressions covered shows how much of the paid delivery that is, and below 100% the
  engagement rate reads low. The figure in brackets counts creatives with engagement data.${
    d && d.overall && d.overall.tiktok && d.overall.tiktok.reach_basis === 'account'
      ? ' TikTok reach is for the whole TikTok ad account, because TikTok would not narrow it to these ads.' : ''}`;
}

function cqrrInner() {
  const d = CQRR.data;
  let main;
  if (CQRR.error && CQRR.key === cqrrQuery()) main = msCard('CQR Good rate', `<div class="cqrr-err">${msEsc(CQRR.error)}</div>`);
  else if (!d || d.brand_id !== (typeof BRAND_ID !== 'undefined' ? BRAND_ID : '')) {
    main = msCard('CQR Good rate', `<div class="ms-bar-empty">Loading…</div>`);
  } else if (!d.overall.combined.impressions && !d.overall.combined.paid_impressions) {
    main = msCard('CQR Good rate', `<div class="ms-bar-empty">No paid delivery in this range.</div>`);
  } else {
    main = `<div class="ms-grid cols-1${CQRR.loading ? ' cqrr-busy' : ''}">${cqrrSummary(d)}${cqrrEngagement(d)}${cqrrCampaigns(d)}${cqrrCompare()}</div>`;
  }
  const span = d && d.span && d.span.first_day
    ? ` Paid delivery on file runs from ${new Date(`${d.span.first_day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} to ${new Date(`${d.span.last_day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : '';
  const engFoot = d && d.engagement_ready ? `<div class="ms-foot">${cqrrEngFoot(d)}</div>` : '';
  return `${cqrrControls()}${main}<div class="ms-foot">${CQRR_FOOT}${span}</div>${engFoot}`;
}

function cqrrPaint() {
  const el = document.getElementById('ms-cqr');
  if (!el) return;
  el.innerHTML = cqrrInner();
  if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn(el);
}

/** The section, for msRenderBody. Drawn from what is held, then refreshed. */
function msSectionCqrRates() {
  return `<div class="ms-sec">
    <div class="ms-sec-h">Paid quality and engagement</div>
    <div class="ms-note">Weighted by impressions, with its own dates. Video quality covers paid video;
      engagement covers every paid creative. Of the filters above, only Campaign applies here.</div>
    <div id="ms-cqr">${cqrrInner()}</div>
  </div>`;
}

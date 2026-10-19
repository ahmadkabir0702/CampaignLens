// =====================================================================
//  Expired session
//
//  The dashboard loads its data once and then lives in the page, so when
//  a session ends nothing looks wrong until something asks the server
//  again. The two panels that open on demand are the only things that
//  do, which is why an expired session used to surface as a bare "Not
//  authenticated" inside one creative's panel and nowhere else.
//
//  Wrapping fetch catches every call, including ones added later, and
//  says once, at the top of the page, what actually happened.
// =====================================================================
(function () {
  const realFetch = window.fetch.bind(window);
  let announced = false;

  /**
   * Lock the page.
   *
   * This was a bar along the bottom, which is the wrong weight for what it
   * says. Nothing on screen is loading any more and nothing the person does
   * will save, so letting them carry on clicking is letting them work into
   * a dead end. It blocks instead: scrim over everything, one button, no
   * way past it, and the page still visible underneath so they can see
   * where they were.
   */
  function announce() {
    if (announced) return;
    announced = true;

    const lock = document.createElement('div');
    lock.className = 'session-lock';
    lock.setAttribute('role', 'alertdialog');
    lock.setAttribute('aria-modal', 'true');
    lock.setAttribute('aria-labelledby', 'session-lock-title');
    lock.innerHTML = `
      <div class="session-lock-card">
        <div class="session-lock-title" id="session-lock-title">Your session has ended</div>
        <p class="session-lock-body">
          You have been signed out, so nothing on this page is live any more and
          nothing you do here will be saved. Sign in again to carry on.
        </p>
        <button class="session-lock-btn" data-press type="button">Sign in again</button>
      </div>`;

    const go = () => { window.location = '/login'; };
    const btn = lock.querySelector('button');
    btn.onclick = go;

    (document.body || document.documentElement).appendChild(lock);

    // Nothing behind this should be reachable: not by scrolling, not by
    // tabbing to a control that would only fail, not by Escape.
    try { document.body.style.overflow = 'hidden'; } catch (e) {}
    setTimeout(() => { try { btn.focus(); } catch (e) {} }, 0);
    lock.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); btn.focus(); }
      if (e.key === 'Escape') e.preventDefault();
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
    // Focus can still be pulled out by the page underneath; pull it back.
    document.addEventListener('focusin', (e) => {
      if (!lock.contains(e.target)) { e.stopPropagation(); btn.focus(); }
    }, true);

    // Same entrance as the creative panel, so it reads as part of the app
    // rather than a browser dialog. Reduced motion lands it immediately.
    if (window.Motion && !Motion.reduced()) {
      const card = lock.querySelector('.session-lock-card');
      let p = 0;
      const paint = (v) => {
        lock.style.setProperty('--lock-scrim', v.toFixed(3));
        card.style.setProperty('--lock-y', (10 * (1 - v)).toFixed(2) + 'px');
        card.style.setProperty('--lock-s', (0.985 + 0.015 * v).toFixed(4));
      };
      paint(0);
      Motion.spring(() => p, (v) => { p = v; paint(v); }, { preset: 'move' }).to(1);
    }
  }

  window.fetch = async function (input, init) {
    const res = await realFetch(input, init);
    try {
      const url = typeof input === 'string' ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      if (res.status === 401 && url.indexOf('/api/') !== -1) announce();
    } catch (e) { /* never let this break the call it is wrapping */ }
    return res;
  };
})();

/** The message to show in place when a panel could not load. */
function panelError(res, data) {
  if (res && res.status === 401) return 'Your session has ended. Sign in again to load this.';
  return (data && data.error) || 'Could not load';
}

const parseNum = (val) => {
    if (typeof val === 'number') return val;
    if (!val || val === 'Not Found' || val === '-') return 0;
    return parseFloat(String(val).replace(/[^0-9.-]+/g, "")) || 0;
};

let ALL = [];

// ---------------------------------------------------------------------
//  Toasts
//
//  One short line at the foot of the screen that something worked or did
//  not, in place of the browser's alert box, which stops the page and
//  looks like a different product. Errors stay up longer and are read
//  out straight away by screen readers.
// ---------------------------------------------------------------------
let toastTimer = null;
function toast(message, tone) {
  let el = document.getElementById('cl-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cl-toast';
    el.className = 'cl-toast';
    document.body.appendChild(el);
  }
  const err = tone === 'error';
  el.setAttribute('role', err ? 'alert' : 'status');
  el.classList.toggle('is-error', err);
  el.textContent = String(message || '');
  el.classList.remove('show');
  el.offsetHeight;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), err ? 6000 : 3200);
}
let ACCOUNT_OVERVIEW = [];
let CAMPAIGNS = [];
// How long a post is left alone before its organic numbers are read. Sent
// by the API so the card and the rating cannot disagree about it; the
// fallback only applies if an older server is still answering.
let VALIDATION_HOURS = 24;
let BRAND_NAME = '';
let currentPlatform = 'both', currentSort = 'date', sortAscending = false, selectedId = null;
let currentPage = 'creatives';
let chartsInit = {};

let AGENCIES = [], CURRENT_USER = '', CURRENT_ROLE = '', CURRENT_IS_INTERNAL = false;

// What this account may use. Starts closed: the controls are only put on
// the page once the server has said so, so a failed or slow /api/brands
// shows nothing rather than briefly offering a button that would 403.
let FEATURES = { askLens: false, addCreative: false, pretest: false, media: false, creators: false, sov: false };

// Pages that need a feature. A page not listed here (the Creative Hub) is
// open to every account.
const PAGE_FEATURE = { pretests: 'pretest', kpi: 'media', creators: 'creators', sov: 'sov' };

/** The page to show for a request: the one asked for, or the Creative Hub if this account may not see it. */
function allowedPage(page) {
  const flag = PAGE_FEATURE[page];
  return flag && FEATURES[flag] === false ? 'creatives' : page;
}

/**
 * Put the page in the shape this account's access allows.
 *
 * Controls are removed rather than hidden. Hiding leaves them one CSS
 * edit away, and while the server refuses the endpoints either way,
 * there is no reason to ship markup for something nobody can use.
 */
function applyFeatures() {
  for (const [page, flag] of Object.entries(PAGE_FEATURE)) {
    const nav = document.querySelector(`.nav-item[onclick*="setNav('${page}'"]`);
    if (FEATURES[flag] === false) nav?.remove();
    else nav?.classList.remove('hidden');
  }
  // A group label with no sections left under it goes too.
  document.querySelectorAll('.nav-label').forEach(label => {
    let n = label.nextElementSibling, any = false;
    while (n && !n.classList.contains('nav-label')) {
      if (n.classList.contains('nav-item') && !n.classList.contains('hidden')) any = true;
      n = n.nextElementSibling;
    }
    label.classList.toggle('is-empty', !any);
  });
  placeNavInk(false);
  // If a removed page was open, go back to the Creative Hub.
  if (typeof currentPage !== 'undefined' && allowedPage(currentPage) !== currentPage) setNav('creatives');
  if (!FEATURES.addCreative) {
    document.querySelector('.topbar-right button[onclick*="openAddCreativeModal"]')?.remove();
    document.getElementById('addCreativeModal')?.remove();
  }
  // Ask Lens builds its own button and panel, so it is simply never
  // started rather than started and then taken apart.
  if (FEATURES.askLens && typeof AskLens !== 'undefined' && !applyFeatures.askLensUp) {
    applyFeatures.askLensUp = true;
    AskLens.init({ mountButton: document.querySelector('.topbar-right') });
  }
}

async function loadBrands() {
  try {
    const res = await fetch('/api/brands');
    if (!res.ok) return;
    const { brands, active, agencies, user, isInternal, features } = await res.json();
    AGENCIES = agencies || [];
    CURRENT_USER = (user && user.displayName) || '';
    CURRENT_ROLE = (user && user.role) || '';
    CURRENT_IS_INTERNAL = !!isInternal;
    FEATURES = Object.assign({ askLens: true, addCreative: true, pretest: true, media: true, creators: true, sov: true }, features || {});
    applyFeatures();
    const sel = document.getElementById('brand-switcher');
    if (!sel) return;
    sel.innerHTML = brands
      .map(b => `<option value="${b.brand_id}"${b.brand_id === active ? ' selected' : ''}>${b.name}</option>`)
      .join('');
    if (brands.length < 2) sel.style.pointerEvents = 'none';
    if (typeof renderBrandSwitcher === 'function') renderBrandSwitcher(brands, active);
  } catch (e) { console.error('loadBrands', e); }
}

async function switchBrand(brandId) {
  try {
    const res = await fetch('/api/switch-brand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id: brandId })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `${res.status} ${res.statusText}`);
    }
    selectedId = null;
    await loadData();
    // Re-render whichever tab is open, so the switch is not lost on tab change
    if (currentPage === 'kpi' && typeof renderKPIDashboard === 'function') {
      renderKPIDashboard();
    }
    if (typeof PreTest !== 'undefined') PreTest.onBrandChange(currentPage);
  } catch (e) {
    toast('Could not switch brand: ' + e.message, 'error');
  }
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
// Placeholders in the shape of the real content, with a light sweep across them.
// Styles live in styles.css (.sk / .sk-card).
function skeletonKpis(n = 5) {
  const w = [[64,46,80],[58,62,70],[70,38,76],[52,70,64],[66,30,72]];
  return Array.from({length: n}, (_, i) => {
    const [a,b,c] = w[i % w.length];
    return `<div class="sk-card">
      <div class="sk" style="width:${a}%;height:11px;margin-bottom:12px"></div>
      <div class="sk" style="width:${b}%;height:26px"></div>
      <div class="sk" style="width:${c}%;height:10px;margin-top:8px"></div>
    </div>`;
  }).join('');
}

function skeletonCards(n = 8) {
  const w = [[44,72,56],[40,66,60],[48,78,52],[42,70,58]];
  return Array.from({length: n}, (_, i) => {
    const [a,b,c] = w[i % w.length];
    return `<div class="sk-card">
      <div class="sk" style="width:${a}%;height:10px;margin-bottom:12px"></div>
      <div class="sk" style="width:${b}%;height:16px;margin-bottom:7px"></div>
      <div class="sk" style="width:${c}%;height:11px;margin-bottom:14px"></div>
      <div class="sk" style="width:100%;height:5px;margin-bottom:9px"></div>
      <div class="sk" style="width:100%;height:5px;margin-bottom:9px"></div>
      <div class="sk" style="width:100%;height:5px"></div>
    </div>`;
  }).join('');
}

// The KPI tab renders from data already in memory, so switching brand used to
// leave the previous brand's numbers on screen for the whole fetch.
function skeletonKpiPage() {
  const chart = h => `<div class="sk-card" style="padding:20px">
      <div class="sk" style="width:34%;height:14px;margin-bottom:16px"></div>
      <div class="sk" style="width:100%;height:${h}px"></div>
    </div>`;
  return `
    <div class="sk" style="width:190px;height:18px;margin-bottom:14px"></div>
    <div class="sk-kpi-row">${skeletonKpis(5)}</div>
    <div class="sk" style="width:150px;height:18px;margin:32px 0 14px"></div>
    <div class="sk-chart-row">${chart(210)}${chart(210)}</div>
    <div class="sk" style="width:170px;height:18px;margin:32px 0 14px"></div>
    <div class="sk-chart-row">${chart(210)}${chart(210)}</div>`;
}

let isLoading = false;

function showSkeleton() {
  if (currentPage === 'kpi') {
    const p = document.getElementById('page-kpi');
    if (p) p.innerHTML = skeletonKpiPage();
    return;
  }
  const k = document.getElementById('kpi-row');
  const g = document.getElementById('card-grid');
  const c = document.getElementById('grid-count');
  if (k) k.innerHTML = skeletonKpis();
  if (g) g.innerHTML = skeletonCards();
  if (c) c.textContent = '';
}

async function loadData() {
  isLoading = true;
  showSkeleton();
  try {
    const response = await fetch('/api/dashboard-data');
    if (!response.ok) throw new Error("Backend connection failed.");
    const data = await response.json();
    ALL              = data.creatives;
    ACCOUNT_OVERVIEW = data.account;
    CAMPAIGNS        = data.campaigns;
    BRAND_NAME       = data.brand.name;
    if (data.validationHours) VALIDATION_HOURS = Number(data.validationHours);

    const bn = document.getElementById('brand-name');
    if (bn) bn.textContent = BRAND_NAME;

    if (ALL.length === 0) {
      document.getElementById('kpi-row').innerHTML =
        `<div class="load-msg">No creatives added for ${BRAND_NAME} yet. Use Add creative to enter one.</div>`;
      // Clear the previous brand's cards — returning early used to leave
      // them on screen next to a message saying there were none.
      document.getElementById('card-grid').innerHTML = '';
      document.getElementById('grid-count').textContent = '0 creatives';
      populateFilters();
      if (typeof enhanceFilterDropdowns === 'function') enhanceFilterDropdowns();
      if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
      isLoading = false;
      // The KPI tab keeps its skeleton unless we clear it here — the empty
      // path returns before render(), so renderKpiTab never runs.
      const kpEmpty = document.getElementById('page-kpi');
      if (currentPage === 'kpi' && kpEmpty) kpEmpty.innerHTML =
        `<div class="load-msg">No creatives added for ${BRAND_NAME} yet. Use Add creative to enter one.</div>`;
      return;
    }
    populateFilters();
    if (typeof enhanceFilterDropdowns === 'function') enhanceFilterDropdowns();
    if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
    if (typeof syncFilterPills === 'function') syncFilterPills();
    render();
  } catch(err) {
    document.getElementById('kpi-row').innerHTML =
      `<div class="load-msg load-msg-error">Couldn't load campaign data. ${err.message}
         <button class="load-retry" onclick="loadData()">Try again</button></div>`;
    document.getElementById('card-grid').innerHTML = '';
    document.getElementById('grid-count').textContent = '';
    const kp = document.getElementById('page-kpi');
    if (currentPage === 'kpi' && kp) kp.innerHTML =
      `<div class="load-msg load-msg-error">Couldn't load campaign data. ${err.message}
        <button class="load-retry" onclick="loadData()">Try again</button></div>`;
    console.error(err);
  } finally {
    isLoading = false;
  }
}

function extractCreatorInfo(creatorProfile, ttLink) {
  if (creatorProfile) {
    const ttM = creatorProfile.match(/tiktok\.com\/(@[^/?&#\s]+)/i);
    if (ttM) return { username: ttM[1], profileUrl: `https://www.tiktok.com/${ttM[1]}` };
    const igM = creatorProfile.match(/instagram\.com\/([^/?&#\s]+)/i);
    if (igM) return { username: `@${igM[1]}`, profileUrl: `https://www.instagram.com/${igM[1]}` };
    if (creatorProfile.startsWith('http')) return { username: creatorProfile.split('/').filter(Boolean).pop() || creatorProfile, profileUrl: creatorProfile };
    if (creatorProfile.trim()) return { username: creatorProfile.trim(), profileUrl: null };
  }
  if (ttLink) {
    const ttM = ttLink.match(/tiktok\.com\/(@[^/?&#\s]+)/i);
    if (ttM) return { username: ttM[1], profileUrl: `https://www.tiktok.com/${ttM[1]}` };
  }
  return null;
}

function populateFilters() {
  const months       = [...new Set(ALL.map(d=>d.month))].filter(Boolean).sort();
  const campaigns    = [...new Set(ALL.map(d=>d.campaign))].filter(Boolean).sort();
  const contentTypes = [...new Set(ALL.map(d=>d.contentType).filter(Boolean))].sort();

  const mSel = document.getElementById('month-filter');
  if (mSel) { mSel.innerHTML = '<option value="all">All months</option>'; months.forEach(m => { const o = document.createElement('option'); o.value=m; o.textContent=m; mSel.appendChild(o); }); }

  const cSel = document.getElementById('campaign-filter');
  if (cSel) { cSel.innerHTML = '<option value="all">All campaigns</option>'; campaigns.forEach(c => { const o = document.createElement('option'); o.value=c; o.textContent=c; cSel.appendChild(o); }); }

  const ctSel = document.getElementById('content-type-filter');
  if (ctSel) { ctSel.innerHTML = '<option value="all">All content types</option>'; contentTypes.forEach(ct => { const o = document.createElement('option'); o.value=ct; o.textContent=ct; ctSel.appendChild(o); }); }
}

// Each page opens with its title and one line on what it shows.
const PAGE_HEADS = {
  creatives: { title: 'Creative Hub',   sub: 'Every creative for the brand, newest first, with its rating.' },
  kpi:       { title: 'Media Summary',  sub: 'What went out, how it did organically, and what the paid creative taught us.' },
  creators:  { title: 'Creators',       sub: 'Every creator and community page that has posted about the brand.' },
  pretests:  { title: 'Pre-tests',      sub: 'Score a video before it goes live.' },
  sov:       { title: 'Share of voice', sub: 'The brand\'s share of the conversation in its category.' },
  signoff:   { title: 'Campaign Sign-Off', sub: 'One record per campaign, cleared before it goes live.' },
};

// The white tab behind the active section slides to it.
function placeNavInk(animate) {
  const ink = document.getElementById('nav-ink');
  const on = document.querySelector('.nav-tabs .nav-item.active');
  if (!ink) return;
  if (!on || !on.offsetHeight) { ink.classList.remove('on'); return; }
  if (!animate) ink.style.transition = 'none';
  ink.style.top = on.offsetTop + 'px';
  ink.style.height = on.offsetHeight + 'px';
  ink.classList.add('on');
  if (!animate) { ink.offsetHeight; ink.style.transition = ''; }
}
window.addEventListener('resize', () => placeNavInk(false));
if (document.fonts) document.fonts.ready.then(() => placeNavInk(false));

function setNav(page, element) {
    // Nav items are removed for pages an account may not use, but setNav
    // is also reachable from code (links inside other pages), so the page
    // itself refuses rather than relying on the link being gone.
    page = allowedPage(page);
    if (element && !element.matches(`[onclick*="setNav('${page}'"]`)) element = null;
    ['page-creatives', 'page-kpi', 'page-creators', 'page-pretests'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const selectedPage = document.getElementById(`page-${page}`);
    if (selectedPage) selectedPage.classList.remove('hidden');
    const titleEl = document.getElementById('topbar-title');
    if (titleEl) titleEl.innerText = (PAGE_HEADS[page] || {}).title || '';
    const subEl = document.getElementById('page-sub');
    if (subEl) subEl.innerText = (PAGE_HEADS[page] || {}).sub || '';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (element) {
        element.classList.add('active');
    } else {
        const navLink = document.querySelector(`[onclick="setNav('${page}',this)"]`);
        if (navLink) navLink.classList.add('active');
    }
    currentPage = page;
    placeNavInk(true);
    // Only the Creative Hub uses the topbar filter row. The KPI tab has
    // its own filter state and the Creators tab has its own controls, so
    // showing it on either would give two competing filter systems.
    const topFilters = document.querySelector('.topbar .filters');
    if (topFilters) topFilters.style.display = (page === 'creatives') ? 'flex' : 'none';
    if (page === 'kpi') {
        if (isLoading) showSkeleton();
        else if (typeof renderKPIDashboard === 'function') renderKPIDashboard();
    }
    if (page === 'creators' && typeof renderCreatorTab === 'function') {
        renderCreatorTab();
    }
    if (typeof PreTest !== 'undefined') PreTest.onPage(page);
}

function setPlatform(p, el) {
  currentPlatform = p;
  document.querySelectorAll('.pt').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  selectedId = null;
  render();
}

function setSort(s, el) {
  currentSort = s;
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  render();
}

function toggleSortDir() {
  sortAscending = !sortAscending;
  document.getElementById('sort-dir-btn').innerHTML = sortAscending ? 'Asc' : 'Desc';
  render();
}

function getData() {
  let data = ALL;
  if (currentPlatform === 'meta') {
    data = ALL.filter(d => d.platform === 'meta' || d.platform === 'both').map(d => {
      if (d.platform === 'both' && d._meta) {
        return { ...d, reach: d._meta.reach, hookRate: d._meta.hookRate, holdRate: d._meta.holdRate, spend: d._meta.spend, impressions: d._meta.impressions, cqr: d._meta.cqr, hookQual: d._meta.hookQual, holdQual: d._meta.holdQual, vtr: d._meta.vtr, watchTime: d._meta.watchTime, adStatus: d._meta.adStatus, ret: d._meta.ret };
      }
      return d;
    });
  }
  if (currentPlatform === 'tiktok') {
    data = ALL.filter(d => d.platform === 'tiktok' || d.platform === 'both').map(d => {
      if (d.platform === 'both' && d._tt) {
        return { ...d, reach: d._tt.reach, hookRate: d._tt.hookRate, holdRate: d._tt.holdRate, spend: d._tt.spend, impressions: d._tt.impressions, cqr: d._tt.cqr, hookQual: d._tt.hookQual, holdQual: d._tt.holdQual, vtr: d._tt.vtr, watchTime: d._tt.watchTime, adStatus: d._tt.adStatus, ret: d._tt.ret };
      }
      return d;
    });
  }
    
  const searchQ = (document.getElementById('search-filter')       || {}).value?.toLowerCase() || '';
  const tf      = (document.getElementById('type-filter')         || {}).value || 'all';
  const mf      = (document.getElementById('month-filter')        || {}).value || 'all';
  const campf   = (document.getElementById('campaign-filter')     || {}).value || 'all';
  const sf      = (document.getElementById('status-filter')       || {}).value || 'all';
  const vf      = (document.getElementById('validation-filter')   || {}).value || 'all';
  const ctf     = (document.getElementById('content-type-filter') || {}).value || 'all';
  const af      = (document.getElementById('action-filter')       || {}).value || 'all';
  const of      = (document.getElementById('origin-filter')       || {}).value || 'all';
  const srcf    = (document.getElementById('source-filter')       || {}).value || 'all';

  if (tf !== 'all')   data = data.filter(d => d.type === tf);
  if (mf !== 'all')   data = data.filter(d => d.month === mf);
  if (campf !== 'all') data = data.filter(d => d.campaign === campf);
  if (ctf !== 'all')  data = data.filter(d => d.contentType === ctf);
  if (af === 'actioned') {
    data = data.filter(d => {
      const actRoot = d.actionStatus ? d.actionStatus.toLowerCase() : '';
      const actMeta = (d._meta && d._meta.actionStatus) ? d._meta.actionStatus.toLowerCase() : '';
      const actTt   = (d._tt && d._tt.actionStatus) ? d._tt.actionStatus.toLowerCase() : '';
      return actRoot === 'actioned' || actMeta === 'actioned' || actTt === 'actioned';
    });
  }
  if (af === 'not_actioned') {
    data = data.filter(d => {
      // The list carries whether a recommendation exists, not its text.
      const hasRec  = d.hasRec || d.recommendation || (d._meta && d._meta.recommendation) || (d._tt && d._tt.recommendation);
      const actRoot = d.actionStatus ? d.actionStatus.toLowerCase() : '';
      const actMeta = (d._meta && d._meta.actionStatus) ? d._meta.actionStatus.toLowerCase() : '';
      const actTt   = (d._tt && d._tt.actionStatus) ? d._tt.actionStatus.toLowerCase() : '';
      const isActed = actRoot === 'actioned' || actMeta === 'actioned' || actTt === 'actioned';
      return hasRec && !isActed;
    });
  }
if (sf === 'ACTIVE')                data = data.filter(d => d.adStatus === 'ACTIVE');
  if (sf === 'STOPPED')               data = data.filter(d => d.adStatus === 'STOPPED');
  if (sf === 'BOOSTED')               data = data.filter(d => d.isBoosted);
  if (sf === 'NOT_BOOSTED')           data = data.filter(d => !d.isBoosted);
  if (sf === 'VALIDATED_NOT_BOOSTED') data = data.filter(d => d.isValidated && !d.isBoosted);
  if (sf === 'FATIGUING')             data = data.filter(d => d.fatiguing && d.boostState === 'running');
  if (sf === 'BOOST_ENDED')           data = data.filter(d => d.boostState === 'ended');
  if (srcf === 'brand')     data = data.filter(d => d.type === 'Brand Say');
  if (srcf === 'creator_led') data = data.filter(d => d.type === 'Brand Say' && d.creatorLed);
  if (srcf === 'creator')   data = data.filter(d => d.type === 'Others Say' && d.source !== 'community');
  if (srcf === 'community') data = data.filter(d => d.source === 'community');
  if (of === 'original')       data = data.filter(d => !d.isRepurposed);
  if (of === 'repurposed')     data = data.filter(d => d.isRepurposed);
  if (of === 'has_repurposed') data = data.filter(d => repurposesOf(d.id).length > 0);
  if (vf === 'validated')     data = data.filter(d => d.isValidated);
  if (vf === 'not_validated') data = data.filter(d => !d.isValidated);
  if (searchQ) data = data.filter(d => matchesSearch(d, searchQ));

  return [...data].sort((a,b) => {
    let valA = 0, valB = 0;
    // Hook and hold were sortable and are not any more: both are paid-only,
    // so they ranked every unboosted creative as a zero.
    if (currentSort==='reach') { valA = a.reach; valB = b.reach; }
    else if (currentSort==='spend') { valA = a.spend; valB = b.spend; }
    else if (currentSort==='cqr')   { const o={Good:0,Average:1,Poor:2,Invalid:3}; valB=(o[a.cqr]??4); valA=(o[b.cqr]??4); }
    // Date Posted had a button but no branch here, so it silently did nothing.
    // Blank dates sort last in either direction rather than jumping to the top.
    else if (currentSort==='date')  { valA = ts(a.date);    valB = ts(b.date); }
    else if (currentSort==='added') { valA = ts(a.addedAt); valB = ts(b.addedAt); }
    return sortAscending ? valA - valB : valB - valA;
  });
}

// Missing dates must not out-rank real ones. -Infinity in ascending order and
// the same value flipped in descending keeps them at the bottom either way.
function ts(v) {
  if (!v) return sortAscending ? Infinity : -Infinity;
  const t = Date.parse(v);
  return Number.isNaN(t) ? (sortAscending ? Infinity : -Infinity) : t;
}

function hookColor(v) { return v>=40?'#1F8A5B':v>=20?'#8A5E0F':'#C2414B'; }
function cqrClass(c)  { return {Good:'good-bg',Average:'avg-bg',Poor:'poor-bg',Invalid:'inv-bg'}[c]||'inv-bg'; }

/**
 * Seconds, for reading rather than for arithmetic.
 *
 * The database keeps the real figure, which is what the retention
 * denominator needs, and that is measured off the file: 11.447, 119.929.
 * Nobody needs three decimal places on a card.
 */
function fmtDur(sec) {
  const n = Number(sec);
  if (!isFinite(n) || n <= 0) return '';
  return (n < 1 ? n.toFixed(1) : String(Math.round(n))) + 's';
}

/**
 * Good, Average and Poor are ratings. Everything else the rating column
 * can hold is a REASON THERE IS NO RATING: Boosted, Too Early, No Views
 * and the rest. Printing those under a heading that says CQR makes
 * "Boosted" look like a grade, which is how a boosted creative ended up
 * appearing to be rated Boosted on all three platforms.
 */
const CQR_GRADES = new Set(['Good', 'Average', 'Poor']);
const isGrade = (v) => CQR_GRADES.has(v);

// Said in the space a card has.
const STATE_SHORT = {
  'Boosted':       'Mixed with paid',
  'Too Early':     'Too early',
  'Counts Hidden': 'Counts hidden',
  'No Views':      'No views yet',
  'No Duration':   'No length on file',
  'No Watch Time': 'No watch time',
  'No Threshold':  'No benchmark set',
};
const STATE_WHY = {
  'Boosted':       'Spend is behind this post, so its organic numbers include paid delivery. The paid rating is the one that applies.',
  'Too Early':     'Posted too recently to read anything from yet.',
  'Counts Hidden': 'The account has hidden its like counts.',
  'No Views':      'No views have come back for this post.',
  'No Duration':   'The video length is missing, so retention cannot be worked out.',
  'No Watch Time': 'No average watch time came back, which is what the rating needs.',
  'No Threshold':  'No benchmark is set for this platform.',
};
const stateShort = (v) => STATE_SHORT[v] || v;

/** 1st, 2nd, 3rd, 41st. It was printing "41th". */
function ordinal(n) {
  const i = Math.abs(Math.round(Number(n)));
  if (!isFinite(i)) return String(n);
  const rem100 = i % 100, rem10 = i % 10;
  const suffix = (rem100 >= 11 && rem100 <= 13) ? 'th'
    : rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th';
  return i + suffix;
}

// The platforms a creative can carry organic numbers on, in the order the
// panels list them.
const ORG_PLATFORMS = [
  { key: 'igOrganic', label: 'Instagram', link: 'igLink', short: 'IG', code: 'ig' },
  { key: 'fbOrganic', label: 'Facebook',  link: 'fbLink', short: 'FB', code: 'fb' },
  { key: 'ttOrganic', label: 'TikTok',    link: 'ttLink', short: 'TT', code: 'tt' },
];
const PAID_PLATFORM_NAME = { meta: 'Meta', tiktok: 'TikTok' };

/**
 * Where the money is, as a thing rather than a sentence.
 *
 * This was the plain string "Running on Meta and TikTok", which said the
 * right thing and looked like a log line. A live dot, the state, and the
 * platforms as their own chips reads at a glance on a grid.
 *
 * No platform logos: Instagram, Facebook and TikTok marks are their
 * trademarks and are not in the repo. If the official SVGs are dropped
 * into public/img/ they can be wired in here.
 */
function statusPill(d) {
  const ps = paidState(d);
  // One chip, names joined, rather than several that butt up against
  // each other with no separator.
  const chips = (names) => `<span class="cstat-plat">${names.join(' · ')}</span>`;
  let main;
  if (ps.running.length) {
    main = `<span class="cstat cstat-live"><span class="cstat-dot"></span>Ad running${chips(ps.running)}</span>`;
  } else if (d.boostState === 'ended') {
    const when = d.boostEnded
      ? new Date(d.boostEnded).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    main = `<span class="cstat cstat-off"><span class="cstat-dot"></span>Boost ended${
      when ? `<span class="cstat-plat">${when}</span>` : ''}</span>`;
  } else {
    main = `<span class="cstat cstat-none"><span class="cstat-dot"></span>Never boosted</span>`;
  }
  const fade = ps.fading.length
    ? `<span class="cstat cstat-fade" title="Rated ${d.fatigueFrom} in its first week, ${d.fatigueTo} last week">Fatiguing${chips(ps.fading)}</span>`
    : '';
  return `<div class="card-status">${main}${fade}</div>`;
}

/** Where this creative is live, where it has stopped, where it is fading. */
function paidState(d) {
  const by = d.paidBy || {};
  const running = [], stopped = [];
  for (const [k, v] of Object.entries(by)) {
    if (!v || !v.adStatus) continue;
    (v.adStatus === 'ACTIVE' ? running : stopped).push(PAID_PLATFORM_NAME[k] || k);
  }
  const fading = (d.fatigueOn || []).map(k => PAID_PLATFORM_NAME[k] || k);
  return { running, stopped, fading };
}
function fmt(n)  { return n>=1000000?'Rs. '+(n/1000000).toFixed(1)+'M':n>=1000?'Rs. '+(n/1000).toFixed(0)+'K':'Rs. '+n; }
function fmtN(n) { return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(0)+'K':String(n); }

// ---------------------------------------------------------------------
//  Search
//  Matches the creative ID, its short name, the creator, the campaign, and
//  any of the three post links. Pasting a link from the address bar brings
//  its own query string, and the stored link usually has a different one, so
//  a plain substring check would miss. The identifying part of the URL is
//  pulled out of both sides and compared instead.
// ---------------------------------------------------------------------

// instagram.com/reel/Dc6Vb-6zw5g/?utm_source=... -> dc6vb-6zw5g
// tiktok.com/@vaseline_sl/video/7682474116825320712 -> 7682474116825320712
function postKey(url) {
  if (!url) return '';
  const clean = String(url).split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segs = clean.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  // Skip a trailing path word like "reel" or "video" with no id after it.
  if (/^(reel|reels|video|videos|p|share|v)$/i.test(last)) return '';
  return last.toLowerCase();
}

function matchesSearch(d, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return true;

  const links = [d.igLink, d.fbLink, d.ttLink].filter(Boolean);

  // If a URL was pasted, compare on the post id rather than the whole string.
  const looksLikeUrl = /^https?:\/\//i.test(q) || /\.(com|net|org|me)\//i.test(q);
  const qKey = postKey(q);
  if (qKey && qKey.length > 4) {
    if (links.some(l => postKey(l) === qKey)) return true;
    if (links.some(l => String(l).toLowerCase().includes(qKey))) return true;
    // A pasted link that matches no post is a miss, not a reason to fall
    // through to substring matching on the domain.
    if (looksLikeUrl) return false;
  } else if (looksLikeUrl) {
    // A URL with no identifiable post in it (".../reel/") would otherwise
    // substring-match every creative on that platform.
    return false;
  }

  const fields = [d.id, d.short, d.creatorProfile, d.campaign, ...links];
  return fields.some(v => String(v || '').toLowerCase().includes(q));
}

function render() {
  const data = getData();
  if (currentPage === 'creatives') {
    renderKPIs(data);
    renderCards(data);
  } else if (currentPage === 'kpi') {
    if (typeof renderKpiTab === 'function') renderKpiTab(data);
  }
}

/**
 * The summary bar.
 *
 * Every tile answers "what needs me", not "how much do we have". A count
 * of what exists cannot be good or bad, so nobody reads it twice. These
 * can all read zero, and zero is good news on each one.
 */
const KPI_RANK = { Good: 0, Average: 1, Poor: 2 };
// The ranked five behind each named tile, filled by renderKPIs and read
// by the drawer. Each entry is { d, grade, src } rather than a bare
// creative, because the rating a tile ranked on is not always the one
// stored on the creative — see ratedBy.
const KPI_LISTS = { top: [], weak: [] };
// What the drawer calls each list. Set by renderKPIs, because the weak
// list's heading depends on whether anything was running to rank.
const KPI_HEADS = { top: '', weak: '' };

/**
 * The best organic grade this creative earned, across its platforms.
 *
 * Grades and states share one column, so a platform can come back
 * 'Boosted' or 'Too Early' where a rating would go. isGrade filters those
 * out: a state is a reason there is no rating, not a bad one.
 */
function bestOrganicGrade(d) {
  let best = null;
  for (const pl of ORG_PLATFORMS) {
    const g = (d[pl.key] || {}).cqr;
    if (isGrade(g) && (best === null || KPI_RANK[g] < KPI_RANK[best])) best = g;
  }
  if (best) return best;
  return isGrade(d.bestOrgCqr) ? d.bestOrgCqr : null;
}

/**
 * The rating to judge a creative on, and where it came from.
 *
 * Paid first: once there is spend behind a post its organic numbers
 * include paid delivery, so the paid rating is the only honest one. With
 * no spend there is no paid rating, and the organic one is all there is.
 *
 * Both named tiles used to rank on d.cqr, which is the paid rating alone.
 * On a brand that has not boosted anything yet that is undefined on every
 * creative, so both tiles read "Nothing to show" against a dashboard full
 * of rated creatives.
 */
function ratedBy(d) {
  if (isGrade(d.cqr)) return { d, grade: d.cqr, src: 'paid' };
  const o = bestOrganicGrade(d);
  return o ? { d, grade: o, src: 'organic' } : null;
}

const srcWord = (src) => src === 'paid' ? 'paid rating' : 'organic rating';

function renderKPIs(data) {
  const totalAssets = data.length;
  const bsCount = data.filter(d => d.type === 'Brand Say').length;
  const osCount = data.filter(d => d.type === 'Others Say').length;

  // Three boost states. A creative switched off after running is not the
  // same thing as one that never had spend, and "not boosted" read as both.
  const running = data.filter(d => d.boostState === 'running').length;
  const ended   = data.filter(d => d.boostState === 'ended').length;
  const never   = data.filter(d => d.boostState === 'never').length;

  // Views against views. Impressions counted a different thing from the
  // organic figure beside it, so the two were never comparable.
  let orgViews = 0;
  data.forEach(d => {
    if (d.igOrganic) orgViews += (d.igOrganic.views || 0);
    if (d.fbOrganic) orgViews += (d.fbOrganic.videoViews || 0);
    if (d.ttOrganic) orgViews += (d.ttOrganic.views || 0);
  });
  const paidViews = data.reduce((s, d) => s + (d.paidViews || 0), 0);
  const viewTotal = orgViews + paidViews;
  const orgShare = viewTotal ? Math.round((orgViews / viewTotal) * 100) : 0;

  const readyToBoost = data.filter(d => d.needsBoostWarning).length;
  const fatiguing = data.filter(d => d.fatiguing && d.boostState === 'running').length;

  const thisMonth = new Date().toISOString().slice(0, 7);
  // Every creative that has a rating at all, paid or organic.
  const rated = data.map(ratedBy).filter(Boolean);
  const rk = r => KPI_RANK[r.grade];
  const newest = (a, b) => String(b.d.date || '').localeCompare(String(a.d.date || ''));

  // Five of each, kept for the drawer. The tile names the leader; the
  // rest are one click away rather than another page.
  //
  // "This month" is the current calendar month by publish date, so early
  // in a month this is a short list and in a quiet month an empty one.
  KPI_LISTS.top = rated
    .filter(r => (r.d.date || '').startsWith(thisMonth))
    .sort((a, b) => rk(a) - rk(b) || (b.d.reach || 0) - (a.d.reach || 0))
    .slice(0, 5);

  // Worst first, then most recent. Deliberately NOT by spend: the figure
  // on a creative is its lifetime spend, and most of that was spent while
  // it was still performing. Showing it against a creative that has only
  // just turned weak reads as money already wasted, which is not what
  // happened.
  //
  // What is running on paid money comes first, because that is the one
  // worth acting on today. With nothing boosted there is nothing live to
  // rank, so the tile falls back to the weakest organically rated creative
  // and renames itself instead of going blank.
  const live = rated
    .filter(r => r.src === 'paid' && r.d.boostState === 'running')
    .sort((a, b) => rk(b) - rk(a) || newest(a, b));
  const weakIsLive = live.length > 0;
  KPI_LISTS.weak = weakIsLive ? live.slice(0, 5)
    : rated.filter(r => r.src === 'organic')
           .sort((a, b) => rk(b) - rk(a) || newest(a, b))
           .slice(0, 5);

  KPI_HEADS.top = 'Best rated this month';
  KPI_HEADS.weak = weakIsLive
    ? 'Weakest creatives currently running'
    : 'Weakest on their organic numbers — nothing is boosted';

  const top = KPI_LISTS.top[0];
  const worst = KPI_LISTS.weak[0];

  const row = document.getElementById('kpi-row');
  if (!row) return;

  const tile = (label, value, sub, o = {}) => `
    <div class="kpi ${o.filter ? 'kpi-click' : ''}"
         ${o.filter ? `data-press onclick="hubTileFilter('${o.filter}')" title="Show these in the grid"` : ''}>
      <div class="kpi-label">${label}</div>
      <div class="kpi-val"${o.color ? ` style="color:${o.color}"` : ''}>${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;

  // A named creative rather than a number, so it is wider and opens the
  // creative instead of filtering to it.
  //
  // The sub-line always says which rating the ranking used. Without it the
  // same tile silently means two different things depending on whether
  // anything happens to be boosted.
  const namedTile = (label, e, sub, emptySub, key) => e ? `
    <div class="kpi kpi-wide kpi-click" data-press
         onclick="toggleKpiList('${key}', this)" title="Show the top five">
      <div class="kpi-label">${label}<span class="kpi-more" id="kpi-more-${key}">${
        KPI_LISTS[key].length > 1 ? `+${KPI_LISTS[key].length - 1} more` : ''}</span></div>
      <div class="kpi-named">${e.d.short || e.d.id}</div>
      <div class="kpi-sub"><span class="cqr-badge ${cqrClass(e.grade)}" style="margin-right:6px">${e.grade}</span>${
        srcWord(e.src)}${sub ? ' · ' + sub : ''}</div>
    </div>` : `
    <div class="kpi kpi-wide">
      <div class="kpi-label">${label}</div>
      <div class="kpi-named kpi-none">Nothing to show</div>
      <div class="kpi-sub">${emptySub}</div>
    </div>`;

  row.innerHTML =
    tile('Total Assets', totalAssets,
         `${running} running · ${ended} boost ended · ${never} never boosted`) +
    tile('BS vs OS Split',
         `${Math.round(bsCount / (totalAssets || 1) * 100)}% / ${Math.round(osCount / (totalAssets || 1) * 100)}%`,
         `${bsCount} Brand Say · ${osCount} Others Say`) +
    tile('Organic vs Paid views', `${fmtN(orgViews)} / ${fmtN(paidViews)}`,
         `${orgShare}% of views earned, not bought`, { color: 'var(--c-os)' }) +
    tile('Ready to boost', readyToBoost,
         readyToBoost ? 'Earned it organically, no spend behind them' : 'Nothing waiting',
         { filter: 'VALIDATED_NOT_BOOSTED', color: readyToBoost ? 'var(--warn)' : undefined }) +
    tile('Fatiguing', fatiguing,
         fatiguing ? 'Running, and rated worse now than at launch' : 'Nothing running has slipped',
         { filter: 'FATIGUING', color: fatiguing ? 'var(--neg)' : undefined }) +
    namedTile('Top creative this month', top,
              top ? (top.d.campaign || '') : '',
              'Nothing published this month has a rating yet', 'top') +
    namedTile(weakIsLive ? 'Weakest live creative' : 'Weakest creative', worst,
              worst ? (worst.d.campaign || '') : '',
              'Nothing has a rating yet', 'weak');

  // A list left open while the data reloads would show stale rows.
  closeKpiList();
}

let kpiListOpen = null;

// ---------------------------------------------------------------------
//  The top-five drawer
//
//  One spring drives a single 0..1 progress, and the height, slide, fade
//  and scale are all read off it. Driving them from separate springs
//  would let them desync; driving them from one cannot.
//
//  Because the spring re-reads its position every time it is re-targeted,
//  clicking the tile again while the drawer is still closing reverses
//  from wherever it had got to, at the speed it was already moving. There
//  is no wait for the close to finish and no jump back to the top.
// ---------------------------------------------------------------------
let drawerP = 0;          // what is on screen right now
let drawerH = 0;          // measured natural height of the content
let drawerSpring = null;

function paintDrawer(p) {
  const el = document.getElementById('kpi-drawer');
  if (!el) return;
  drawerP = p;
  const inner = el.querySelector('.kpi-drawer-inner');
  const card  = el.querySelector('.kpi-drawer-card');
  el.style.height = Math.max(0, drawerH * p) + 'px';
  if (inner) {
    // Comes down from behind the tile rather than appearing in place.
    inner.style.setProperty('--dz', (-6 * (1 - p)).toFixed(2) + 'px');
    // Fades in ahead of the move so it is legible before it arrives.
    inner.style.setProperty('--df', Math.max(0, Math.min(1, p * 2)).toFixed(3));
  }
  if (card) card.style.setProperty('--ds', '1');
}

function getDrawerSpring() {
  if (drawerSpring) return drawerSpring;
  if (!window.Motion) return null;
  drawerSpring = Motion.spring(() => drawerP, (p) => paintDrawer(p), { preset: 'sheet' });
  return drawerSpring;
}

function closeKpiList() {
  const el = document.getElementById('kpi-drawer');
  kpiListOpen = null;
  document.querySelectorAll('.kpi-wide').forEach(k => k.classList.remove('kpi-open'));
  if (!el) return;
  const done = () => {
    if (kpiListOpen !== null) return;      // reopened while this was running
    el.innerHTML = '';
    el.style.height = '0px';
    // Fully closed means out of the document, not a zero-height box that
    // still takes tab stops.
    el.hidden = true;
  };
  const s = getDrawerSpring();
  if (!s) { done(); return; }
  // Out along the path it came in on, and only emptied once it has gone.
  s.to(0, { onRest: done });
}

/** The five behind a named tile, opened under the bar. */
function toggleKpiList(key, trigger) {
  const el = document.getElementById('kpi-drawer');
  if (!el) return;
  if (kpiListOpen === key) return closeKpiList();

  const rows = KPI_LISTS[key] || [];
  if (!rows.length) return closeKpiList();
  const heading = KPI_HEADS[key] || '';
  // Only worth saying per row when the list actually mixes the two. When
  // every row came from the same place the tile above already says so, and
  // repeating it five times is noise.
  const mixedSrc = new Set(rows.map(r => r.src)).size > 1;

  // Visible before it is measured: scrollHeight on a display:none box is
  // zero, and this element ships hidden.
  el.hidden = false;
  el.innerHTML = `
    <div class="kpi-drawer-inner"><div class="kpi-drawer-card">
    <div class="kpi-drawer-head">${heading}
      <button class="kpi-drawer-close" data-press onclick="closeKpiList()" title="Close">×</button>
    </div>
    <table class="kpi-list">
      <tbody>${rows.map((r, i) => `
        <tr data-press onclick="selectCard('${r.d.id}', this)" title="Open this creative">
          <td class="kpi-list-n">${i + 1}</td>
          <td>${r.d.short || r.d.id}<div class="fat-dates">${r.d.campaign || ''}${
            r.d.month ? ' · ' + r.d.month : ''}</div></td>
          <td class="kpi-list-num">${key === 'weak' ? '' : fmtN(r.d.reach || 0) + ' reach'}</td>
          <td class="kpi-list-grade"><span class="cqr-badge ${cqrClass(r.grade)}">${r.grade}</span>
            ${mixedSrc ? `<div class="kpi-list-src">${srcWord(r.src)}</div>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div></div>`;

  kpiListOpen = key;
  document.querySelectorAll('.kpi-wide').forEach(k => k.classList.remove('kpi-open'));
  const tile = trigger || document.querySelector(`.kpi-wide[onclick*="${key}"]`);
  if (tile) tile.classList.add('kpi-open');

  // Natural height, read while the box is still clipped to nothing.
  // scrollHeight reports the content regardless of the height we set.
  drawerH = el.scrollHeight;

  const card = el.querySelector('.kpi-drawer-card');
  // It grows out of the tile that opened it, so the two read as one
  // thing rather than a panel that happened to appear nearby.
  if (card && window.Motion) Motion.anchorOrigin(card, tile);

  const s = getDrawerSpring();
  if (!s) { el.style.height = drawerH + 'px'; return; }
  paintDrawer(drawerP);
  s.to(1);
}

/**
 * Tiles filter the grid. A number you cannot act on is decoration.
 *
 * Named hubTileFilter, not applyKpiFilter: kpi-dashboard.js already owns
 * that name for the Campaign KPIs tab and loads after this file, so the
 * tiles silently called the wrong function and did nothing.
 */
function hubTileFilter(value) {
  const sel = document.getElementById('status-filter');
  if (!sel) return;
  sel.value = value;
  const wrap = sel.closest('.dd');
  if (wrap && wrap._ddRepaint) wrap._ddRepaint();
  if (typeof onDraftChange === 'function') onDraftChange();
  if (typeof applyFilters === 'function') applyFilters();
}

// The platforms a creative actually lives on, in the order the pipeline
// prefers them. Used for the card's play button and the detail panel's
// open buttons, so a creative posted to three places offers all three.
const PLATFORM_LINKS = [
  { key: 'igLink', name: 'Instagram' },
  { key: 'ttLink', name: 'TikTok' },
  { key: 'fbLink', name: 'Facebook' },
];
/**
 * The card's still frame.
 *
 * It used to run full bleed across the top of the card at a fixed 200px
 * height. Nearly everything here is shot vertical, so that was a
 * landscape slice through a portrait frame: it cost 200px of height,
 * showed a band of the video, and made the card tall enough that only a
 * handful fitted on screen. It is now a portrait tile at the creative's
 * own 4:5, beside the name, which is the same shape the detail panel
 * already uses for the same picture.
 *
 * It ALWAYS returns an element. Returning nothing when a creative had no
 * still left that card a different shape from its neighbours and said
 * nothing about why, so a gap in the pipeline looked like a design
 * choice. The platform mark sits underneath the image and shows through
 * whenever there is no still or the stored one fails to load.
 */
function cardMediaHTML(d) {
  const links = platformLinks(d);
  const open = links.length ? links[0].url : '';
  const mark = d.platform === 'tiktok' ? 'TT' : 'META';
  const play = open ? `<button class="card-play" data-press title="Open on ${escapeHtml(links[0].name)}"
       aria-label="Open on ${escapeHtml(links[0].name)}"
       onclick="event.stopPropagation();window.open('${escapeHtml(open)}','_blank','noopener')"
      >${playMark(13)}</button>` : '';
  const img = d.thumbnail
    ? `<img src="${escapeHtml(d.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<div class="card-thumb${d.thumbnail ? '' : ' card-thumb-none'}"
       ${d.thumbnail ? '' : 'title="No still frame on file for this creative"'}>
    <span class="card-thumb-mark">${mark}</span>${img}${play}
  </div>`;
}

function platformLinks(d) {
  return PLATFORM_LINKS
    .filter(p => d[p.key])
    .map(p => ({ name: p.name, url: d[p.key] }));
}

// A play triangle. Same mark on the card and in the detail panel so the
// gesture reads the same in both places.
function playMark(size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M9.5 7.6v8.8a.7.7 0 0 0 1.07.6l6.9-4.4a.7.7 0 0 0 0-1.2l-6.9-4.4a.7.7 0 0 0-1.07.6Z" fill="currentColor"/>
  </svg>`;
}

/**
 * The answers, before anything is expanded.
 *
 * Every rating on this panel used to live inside a collapsed section, so
 * opening a creative told you its name and nothing about how it did until
 * you went looking. These are the four things people open a creative to
 * find out.
 */
/**
 * Replace the summary's organic cell with what the panel actually worked
 * out.
 *
 * The dashboard payload carries the stored rating column, and for a post
 * with spend behind it that column holds the STATE "Boosted" rather than
 * a grade. The validation endpoint recomputes the grade from the same
 * numbers, which is why the panel could show Average on two platforms
 * while the strip above it said Not rated. Same data, one of them stale.
 */
function updateSummaryOrganic(v) {
  const box = document.getElementById('dsum-organic');
  if (!box || !v || !Array.isArray(v.platforms)) return;
  const byCode = {};
  for (const p of v.platforms) if (p && p.platform) byCode[p.platform] = p;
  const cells = ORG_PLATFORMS.filter(pl => byCode[pl.code]).map(pl => {
    const p = byCode[pl.code];
    const g = p.cqr || null;
    return `<span class="dsum-plat"><span class="dsum-plat-k">${pl.label}</span>${
      isGrade(g) ? `<span class="dsum-plat-v ${cqrClass(g)}">${g}</span>`
                 : `<span class="dsum-plat-v dsum-plat-none">${p.state ? stateShort(p.state) : '—'}</span>`}</span>`;
  });
  if (!cells.length) return;
  const target = box.querySelector('.dsum-plats') || box.querySelector('.dsum-val');
  if (target) target.outerHTML = `<div class="dsum-plats">${cells.join('')}</div>`;
}

function detailSummaryHTML(d) {
  const ps = paidState(d);
  const cell = (label, value, cls, sub) => `
    <div class="dsum-cell">
      <div class="dsum-label">${label}</div>
      <div class="dsum-val ${cls || ''}">${value}</div>
      ${sub ? `<div class="dsum-sub">${sub}</div>` : ''}
    </div>`;

  // Deliberately per platform rather than one rolled-up value. A creative
  // can be Average on Instagram and Poor on Facebook, and a single figure
  // hides exactly the thing you would act on.
  //
  // It starts from the stored column, which returns the STATE for a
  // boosted post rather than a grade, so it can read "Not rated" while
  // the panel underneath shows Average. The panel recomputes the real
  // grade server side, so when that response lands this cell is rewritten
  // from it. See updateSummaryOrganic.
  const orgCells = ORG_PLATFORMS
    .filter(pl => d[pl.link] || d[pl.key])
    .map(pl => ({ label: pl.label, v: (d[pl.key] || {}).cqr || null }));
  const paid = (d.cqr && d.cqr !== 'Invalid') ? d.cqr : null;

  let status, statusCls, statusSub = '';
  if (ps.running.length) {
    status = 'Running'; statusCls = 'dsum-pos';
    statusSub = 'on ' + ps.running.join(' and ');
  } else if (d.boostState === 'ended') {
    status = 'Boost ended'; statusCls = '';
    statusSub = d.boostEnded
      ? new Date(d.boostEnded).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  } else {
    status = 'Never boosted'; statusCls = 'dsum-quiet';
  }
  if (ps.fading.length) {
    statusCls = 'dsum-warn';
    statusSub = (statusSub ? statusSub + ' · ' : '') + 'fatiguing on ' + ps.fading.join(' and ');
  }

  return `<div class="dsum">
    <div class="dsum-cell" id="dsum-organic">
      <div class="dsum-label">Organic CQR</div>
      ${orgCells.length ? `<div class="dsum-plats">${orgCells.map(o =>
        `<span class="dsum-plat"><span class="dsum-plat-k">${o.label}</span>${
          isGrade(o.v) ? `<span class="dsum-plat-v ${cqrClass(o.v)}">${o.v}</span>`
                       : `<span class="dsum-plat-v dsum-plat-none">${o.v ? stateShort(o.v) : '—'}</span>`}</span>`
        ).join('')}</div>` : `<div class="dsum-val dsum-quiet">Not rated</div>`}
    </div>
    ${cell('Paid CQR', paid || (d.boostState === 'never' ? 'No spend yet' : 'Not rated'),
           paid ? 'dsum-' + cqrClass(paid) : 'dsum-quiet')}
    ${cell('Pre-test Score', d.bsScore === null || d.bsScore === undefined ? 'Not scored' : d.bsScore,
           d.bsScore === null || d.bsScore === undefined ? 'dsum-quiet' : '',
           d.bsRating || (d.bsScore === null || d.bsScore === undefined ? '' : 'of 100'))}
    ${cell('Paid status', status, statusCls, statusSub)}
  </div>`;
}

/** "Instagram, Facebook and TikTok" rather than a comma-joined list. */
function listWords(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * How far a new post is through its validation window.
 *
 * A post inside the window is not unrated because something is wrong with
 * it. It is unrated because distribution is still running and reading it
 * now would be reading noise. The card said "Posted too recently to read
 * anything from yet" and left it there, which looks the same as a failure
 * and gives no idea whether to come back in an hour or tomorrow.
 *
 * Elapsed time comes from the post's own timestamps rather than the date
 * field, which is a day with no clock on it.
 */
function validationStrip(d, platformNames) {
  const states = ORG_PLATFORMS.map(pl => (d[pl.key] || {}).cqr).filter(Boolean);
  if (!states.length || !states.every(s => s === 'Too Early')) return '';
  const on = (platformNames || []).length
    ? `Reading ${listWords(platformNames)}. ` : '';

  const window = Number(VALIDATION_HOURS) || 24;
  const stamps = ORG_PLATFORMS
    .map(pl => (d[pl.key] || {}).timePosted)
    .filter(Boolean)
    .map(t => Date.parse(t))
    .filter(t => !Number.isNaN(t));
  const posted = stamps.length ? Math.max(...stamps) : (d.date ? Date.parse(d.date) : NaN);
  if (Number.isNaN(posted)) {
    return `<div class="card-validating">
      <div class="card-validating-l">Still being validated</div>
      <div class="card-validating-s">${on}Distribution is still running, so there is nothing to read yet.</div>
    </div>`;
  }

  const hours = Math.max(0, (Date.now() - posted) / 3600000);
  const pct = Math.max(4, Math.min(100, hours / window * 100));
  const left = Math.max(0, window - hours);
  // Under an hour left, "0h left" reads as finished when it is not.
  const when = left >= 1 ? `about ${Math.round(left)}h to go`
             : left > 0 ? 'ready within the hour'
             : 'due to be read on the next pull';

  return `<div class="card-validating">
    <div class="card-validating-l">Still being validated<span class="card-validating-t">${when}</span></div>
    <div class="card-validating-track"><div class="card-validating-fill" style="width:${pct}%"></div></div>
    <div class="card-validating-s">${on}${Math.max(1, Math.round(hours))}h of ${window}h.</div>
  </div>`;
}

// ---------------------------------------------------------------------
//  The grid, a page at a time
//
//  Drawing every card at once was fine at a hundred and not at a few
//  thousand: the browser builds and lays out every node before showing
//  any. The first CARD_PAGE cards are drawn, and the next page follows as
//  the end of the grid comes into view, or from the button under it.
// ---------------------------------------------------------------------
const CARD_PAGE = 48;
let CARD_DATA = [], CARD_SHOWN = 0, cardObserver = null;

function renderCards(data) {
  document.getElementById('grid-count').textContent = `${data.length} creatives`;
  CARD_DATA = data;
  CARD_SHOWN = 0;
  document.getElementById('card-grid').innerHTML = '';
  appendCards();
}

function appendCards() {
  const grid = document.getElementById('card-grid');
  if (!grid) return;
  const next = CARD_DATA.slice(CARD_SHOWN, CARD_SHOWN + CARD_PAGE);
  grid.insertAdjacentHTML('beforeend', next.map(cardHTML).join(''));
  CARD_SHOWN += next.length;

  let more = document.getElementById('card-more');
  if (CARD_SHOWN >= CARD_DATA.length) {
    if (more) more.remove();
    return;
  }
  if (!more) {
    more = document.createElement('div');
    more.id = 'card-more';
    more.className = 'card-more';
    grid.after(more);
  }
  more.innerHTML = `<button class="card-more-btn" data-press onclick="appendCards()">Show more</button>
    <span>Showing ${CARD_SHOWN} of ${CARD_DATA.length}</span>`;
  if ('IntersectionObserver' in window) {
    if (!cardObserver) cardObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && CARD_SHOWN < CARD_DATA.length) appendCards();
    }, { rootMargin: '600px 0px' });
    cardObserver.disconnect();
    cardObserver.observe(more);
  }
}

function cardHTML(d) {
  {


    const kidCount = repurposesOf(d.id).length;
    const repTag  = d.isRepurposed
      ? `<span class="tag-repurposed">Repurposed</span>`
      : (kidCount ? `<span class="tag-lineage">${kidCount} repurposed</span>` : '');
    const valTag  = d.isValidated  ? `<span class="tag-validated">✓ Validated</span>` : '';
    const durTag  = d.duration     ? `<span class="tag-duration">${fmtDur(d.duration)}</span>` : '';
    const ctTag   = d.contentType  ? `<span class="tag-content-type">${d.contentType}</span>` : '';

    // Type and sub-type in one chip. BS, Creator-led and Community page
    // used to sit as three separate chips saying one thing between them.
    const isBS = d.type === 'Brand Say';
    const typeText = isBS
      ? (d.creatorLed ? 'Brand Say · Creator-led' : 'Brand Say')
      : (d.source === 'community' ? 'Others Say · Community' : 'Others Say · Creator');

    // Per platform: what it did, and how it was rated.
    //
    // The card used to carry the rating and nothing else, so a post inside
    // its validation window showed one grey sentence and no numbers at
    // all, while the panel behind it held views, reach and engagement for
    // all three platforms. The numbers are the reason to open the card, so
    // they belong on it.
    const orgVals = ORG_PLATFORMS
      .filter(pl => d[pl.link] || d[pl.key])
      .map(pl => ({ label: pl.label, o: d[pl.key] || null, v: (d[pl.key] || {}).cqr || null }));

    // The card carries the verdict and nothing else.
    //
    // Counts belong in the panel, where there is room to place them
    // against something. On the card they were four numbers with no
    // reference point, and a grid of them is harder to scan than the
    // grades alone, which is the thing the card exists to show.
    //
    // "Not rated yet" and "no numbers have arrived" are different things,
    // and the card said the first for both. A platform with no organic row
    // at all has not been measured, which is not a verdict on the post.
    const row = (label, v, o, hideState) => `<div class="card-cqr-row">
        <div class="card-cqr-main">
          <span class="card-cqr-plat">${label}</span>
          ${isGrade(v)
            ? `<span class="cqr-badge ${cqrClass(v)}">${v}</span>`
            : (hideState ? ''
              : `<span class="card-cqr-state" title="${escapeHtml(STATE_WHY[v] || '')}">${
                  v ? stateShort(v) : (o ? 'Not rated yet' : 'No numbers yet')}</span>`)}
        </div>
      </div>`;

    // When no platform has a rating and they all give the same reason, the
    // reason is said once above the rows rather than as three identical
    // grey chips. The rows stay, because they now carry the numbers.
    const states = [...new Set(orgVals.map(o => o.v))];
    const sharedState = !orgVals.some(o => isGrade(o.v)) && states.length === 1 && states[0]
      ? states[0] : null;

    // One reason, then the platforms it ran on as a list. Rows with the
    // chip suppressed left a column of bare platform names beside nothing
    // at all, which looked like a rendering fault rather than a state.
    const sharedNote = sharedState && sharedState !== 'Too Early'
      ? `<div class="card-cqr-note" title="${escapeHtml(STATE_WHY[sharedState] || '')}">${
          escapeHtml(STATE_WHY[sharedState] || stateShort(sharedState))}</div>
         <div class="card-cqr-stats">On ${escapeHtml(listWords(orgVals.map(o => o.label)))}.</div>`
      : '';

    // Inside the validation window the counts are deliberately left off.
    //
    // They are still climbing, so a number read now is not the number this
    // post will settle at, and putting it on the card invites comparing it
    // against posts that have finished. What is true right now is the
    // state, so the state is what shows: the strip above carries it with
    // how far through the window it is, and the rows name the platforms
    // being read rather than repeating "Too early" once per platform.
    // Inside the window the strip is the whole organic block, so the
    // platform list goes into it rather than under a second heading.
    const inWindow = sharedState === 'Too Early';
    const orgBlock = (!orgVals.length || inWindow) ? ''
      : sharedState ? sharedNote
      : orgVals.map(o => row(o.label, o.v, o.o, false)).join('');

    // The rating that does apply once there is spend behind it. Shown as
    // soon as there is spend, rated or not: "boosted but not yet rated" is
    // a different thing from "never boosted", and the card could not tell
    // them apart while this block only appeared on a grade.
    //
    const paidVals = [['meta', 'Meta'], ['tiktok', 'TikTok']]
      .filter(([k]) => (d.paidBy || {})[k])
      .map(([k, label]) => row(label, d.paidBy[k].cqr, null, false)).join('');

    const validating = validationStrip(d, ORG_PLATFORMS
      .filter(pl => d[pl.link] || d[pl.key]).map(pl => pl.label));

    // Who posted it. Others Say is creator content by definition, and
    // creator-led Brand Say is fronted by one, so both carry a handle the
    // card never showed: two posts from very different accounts were
    // indistinguishable until you opened them.
    const ci = (d.type === 'Others Say' || d.creatorLed) && typeof extractCreatorInfo === 'function'
      ? extractCreatorInfo(d.creatorProfile, d.ttLink) : null;
    // Always drawn, empty when there is no creator, so every card keeps the
    // same rows and the grid stays even.
    const creatorTag = `<div class="card-creator"${ci && ci.username ? ` title="${escapeHtml(ci.username)}"` : ''}>${
      ci && ci.username ? escapeHtml(ci.username) : ''}</div>`;


    // Three fixed zones (who and what, the ratings, the state) so every card
    // in the grid is the same height whatever it carries.
    const ratings = (orgBlock || paidVals) ? `<div class="card-ratings">
        <div class="card-cqr"><div class="card-cqr-head">Organic</div>${orgBlock || '<span class="card-cqr-state">No numbers yet</span>'}</div>
        <div class="card-cqr"><div class="card-cqr-head">Paid</div>${paidVals || '<span class="card-cqr-state">Not on paid</span>'}</div>
      </div>` : '';
    return `<div class="card ${d.id===selectedId?'selected':''}" data-press onclick="selectCard('${d.id}', this)">
      <div class="card-head">
        ${cardMediaHTML(d)}
        <div class="card-ident">
          <div class="card-type-line">${typeText}${repTag}</div>
          <div class="card-name" title="${escapeHtml(d.id)}">${d.short || d.id}</div>
          <div class="card-campaign">${d.campaign} · ${d.month}</div>
          ${creatorTag}
          <div class="card-tags">${durTag}${ctTag}${valTag}</div>
        </div>
      </div>
      <div class="card-mid">${validating || ratings || '<div class="card-mid-empty">No numbers yet</div>'}</div>
    <div class="card-footer">
      ${statusPill(d)}
      ${typeof PreTest !== 'undefined' ? PreTest.cardBadge(d) : ''}
    </div>
    </div>`;
  }
}

let retChart = null, radarChart = null;

// ---------------------------------------------------------------------
//  The creative panel
//
//  Two independent springs, because a single spring on a combined 2D
//  distance desyncs the moment the two axes are moving at different
//  speeds. One owns how open the panel is (scrim, scale, blur); the
//  other owns the drag offset. Every paint writes the sum, so the two
//  never fight over the transform.
//
//  Grab the header and it tracks the pointer 1:1 from wherever you took
//  hold of it. Dragging up resists instead of stopping, and on release
//  the decision is made from where the gesture was HEADING rather than
//  where the finger happened to be, so a short fast flick dismisses and
//  a long slow drag that stopped halfway does not.
// ---------------------------------------------------------------------
let modalP = 0, modalY = 0;
let modalPSpring = null, modalYSpring = null;
let modalDrag = null;
const MODAL_DISMISS_VELOCITY = 650;   // px/s, a deliberate flick

function modalEls() {
  return {
    overlay: document.getElementById('creativeModalOverlay'),
    panel: document.getElementById('creativeModalContent'),
  };
}

/** No spring available: land on the open state rather than mid-flight. */
function paintModalOpenNow() {
  modalP = 1; modalY = 0; paintModal();
}

function paintModal() {
  const { overlay, panel } = modalEls();
  if (!overlay || !panel) return;
  const p = modalP;
  overlay.style.setProperty('--scrim', Math.max(0, Math.min(1, p)).toFixed(3));
  // The enter path and the drag share one axis: 8px on the way in, plus
  // whatever the hand has added.
  panel.style.setProperty('--sheet-y', (8 * (1 - p) + modalY).toFixed(2) + 'px');
  // Barely a scale. Enough to read as arriving, not enough to watch.
  panel.style.setProperty('--sheet-s', (0.988 + 0.012 * p).toFixed(4));
}

function modalSprings() {
  if (!window.Motion) return null;
  if (!modalPSpring) {
    modalPSpring = Motion.spring(() => modalP, (v) => { modalP = v; paintModal(); }, { preset: 'move' });
    modalYSpring = Motion.spring(() => modalY, (v) => { modalY = v; paintModal(); }, { preset: 'snap' });
  }
  return { p: modalPSpring, y: modalYSpring };
}

/**
 * Show the creative panel. The one way it is ever opened.
 *
 * creators.js fills the same overlay and used to reveal it by setting
 * display itself. Once the panel carries spring-driven scale, blur and
 * scrim, doing that leaves whatever the last close wrote still on the
 * element, so the panel would come back shrunk and blurred behind a
 * transparent scrim. Both callers come through here instead.
 *
 * @param {Element} [trigger] what was clicked, so it grows out of it
 */
function showCreativePanel(trigger) {
  const { overlay, panel } = modalEls();
  if (!overlay || !panel) return;
  overlay.style.display = 'flex';

  const sp = modalSprings();
  if (!sp) { paintModalOpenNow(); return; }
  // Out of the thing that was clicked, which is the spatial cue that
  // says this panel is that card opened rather than a new screen.
  if (trigger) Motion.anchorOrigin(panel, trigger);
  else panel.style.transformOrigin = '50% 40%';

  modalY = 0;
  sp.y.stop();
  // Start from closed every time, so a reopen is a journey rather than
  // a panel that was already there.
  modalP = 0;
  paintModal();
  sp.p.to(1);
  installModalDrag();
}

// ---------------------------------------------------------------------
//  Panel-only fields, fetched when needed
//
//  The list leaves out the scene timeline, the brief and the
//  recommendation text, which only the panel reads. They are fetched the
//  first time a creative is opened and merged into its entry in ALL, so a
//  second open is instant and everything downstream sees one object.
// ---------------------------------------------------------------------
async function ensureDetails(ids) {
  const want = ids.filter(id => { const d = ALL.find(x => x.id === id); return d && !d._detail; });
  if (!want.length) return;
  for (let i = 0; i < want.length; i += 200) {
    const chunk = want.slice(i, i + 200);
    const r = await fetch('/api/creative-details?ids=' + chunk.map(encodeURIComponent).join(','));
    if (!r.ok) throw new Error(`details ${r.status}`);
    const { details } = await r.json();
    for (const id of chunk) {
      const d = ALL.find(x => x.id === id);
      if (!d) continue;
      // Marked fetched even when the server had nothing for it, so a
      // creative with no details is not asked for again on every open.
      d._detail = true;
      const det = details[id];
      if (!det) continue;
      const { _meta, _tt, ...rest } = det;
      Object.assign(d, rest);
      if (_meta && d._meta) Object.assign(d._meta, _meta);
      if (_tt && d._tt) Object.assign(d._tt, _tt);
    }
  }
}

function panelSkeleton() {
  return `<div class="cm-body" aria-busy="true">
    <div class="sk" style="height:22px;width:45%;margin-bottom:10px"></div>
    <div class="sk" style="height:14px;width:30%;margin-bottom:22px"></div>
    <div class="sk" style="height:84px;margin-bottom:16px"></div>
    <div class="sk" style="height:220px;margin-bottom:16px"></div>
    <div class="sk" style="height:160px"></div>
  </div>`;
}

// Previous and next step through the grid as it is filtered and sorted
// now, without closing the panel.
function panelNavHTML(id) {
  const i = CARD_DATA.findIndex(x => x.id === id);
  if (i < 0 || CARD_DATA.length < 2) return '';
  const btn = (dir, label, on, path) => `<button class="detail-step" data-press aria-label="${label}" ${on ? '' : 'disabled'}
      onclick="panelStep(${dir})"><svg viewBox="0 0 12 12" width="14" height="14"><path d="${path}"/></svg></button>`;
  return btn(-1, 'Previous creative', i > 0, 'M7.5 2.5 4 6l3.5 3.5') +
    `<span class="detail-pos">${(i + 1).toLocaleString()} of ${CARD_DATA.length.toLocaleString()}</span>` +
    btn(1, 'Next creative', i < CARD_DATA.length - 1, 'M4.5 2.5 8 6 4.5 9.5');
}

function panelStep(dir) {
  const i = CARD_DATA.findIndex(x => x.id === panelFor);
  const next = CARD_DATA[i + dir];
  if (i < 0 || !next) return;
  // Keep the grid behind the panel in step, so closing lands on it.
  while (CARD_SHOWN <= i + dir && CARD_SHOWN < CARD_DATA.length) appendCards();
  selectedId = next.id;
  document.querySelectorAll('#card-grid .card.selected').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`#card-grid .card[onclick*="selectCard('${next.id}'"]`);
  if (card) card.classList.add('selected');
  openPanelFor(next);
  const panel = document.getElementById('creativeModalContent');
  if (panel) panel.scrollTop = 0;
}

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('creativeModalOverlay');
  if (!overlay || overlay.style.display !== 'flex' || !panelFor) return;
  if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); panelStep(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); panelStep(-1); }
});

let panelFor = null;
function openPanelFor(item) {
  const id = item.id;
  panelFor = id;
  const fill = () => {
    if (panelFor !== id) return;   // another creative was opened meanwhile
    try {
      renderDetail(item);
    } catch (err) {
      console.error('[hub] renderDetail failed, panel still opened', err);
    }
  };
  if (item._detail) fill();
  else {
    document.getElementById('creativeModalContent').innerHTML = panelSkeleton();
    ensureDetails([id]).catch(err => console.error('[hub] details failed, showing what the list has', err)).then(fill);
  }
}

function selectCard(id, trigger) {
  const item = ALL.find(d => d.id === id);
  if (!item) return;
  const { overlay } = modalEls();
  overlay.style.display = 'flex';
  // The panel opens whatever happens while filling it. renderDetail
  // reaches for a chart library and several optional endpoints, and a
  // throw in there used to abort this function before the animation
  // started, leaving a panel on screen at scale 0.94 with a transparent
  // scrim: invisible, but covering the page and swallowing clicks.
  openPanelFor(item);
  showCreativePanel(trigger);
}

/**
 * Close along the same path it opened on.
 *
 * opts.keepY is for a dismiss that came from a drag: the gesture already
 * owns the y axis and has been handed its release velocity, so touching
 * y here would snap the panel back to centre while it faded out.
 */
function closeCreativeModal(e, opts) {
  opts = opts || {};
  if (e && e.target && e.target.id !== 'creativeModalOverlay') return;
  const { overlay, panel } = modalEls();
  if (!overlay) return;
  const sp = modalSprings();
  if (!sp) {
    overlay.style.display = 'none';
    if (panel) panel.innerHTML = '';
    return;
  }
  sp.p.to(0, {
    onRest: () => {
      // A reopen may have happened while this was still running.
      if (modalP > 0.01) return;
      overlay.style.display = 'none';
      if (panel) panel.innerHTML = '';
      modalY = 0;
      paintModal();
    },
  });
  if (!opts.keepY) sp.y.to(0, { velocity: opts.velocity || 0 });
}

function installModalDrag() {
  const { panel } = modalEls();
  if (!panel || panel._dragWired) return;
  panel._dragWired = true;

  const tracker = new Motion.Tracker();

  panel.addEventListener('pointerdown', (e) => {
    const header = e.target.closest && e.target.closest('.detail-header');
    if (!header) return;
    // Buttons and links inside the header stay buttons.
    if (e.target.closest('button, a, input, select, summary')) return;
    if (e.button !== undefined && e.button !== 0) return;

    const sp = modalSprings();
    if (!sp) return;
    // Take over mid-flight: adopt what is on screen, do not restart.
    sp.y.stop();
    sp.p.stop();
    modalDrag = { startY: e.clientY, baseY: modalY, h: panel.getBoundingClientRect().height };
    tracker.reset(modalY);
    panel.classList.add('is-dragging');
    panel.setPointerCapture(e.pointerId);
  });

  panel.addEventListener('pointermove', (e) => {
    if (!modalDrag) return;
    const raw = modalDrag.baseY + (e.clientY - modalDrag.startY);
    // Down is free. Up has nowhere to go, so it resists rather than
    // stopping dead, which reads as responsive instead of frozen.
    modalY = raw >= 0 ? raw : Motion.rubberband(raw, modalDrag.h);
    tracker.add(modalY);
    // While dragging, the panel stays fully present: fading it out as it
    // moves would hide the thing the hand is holding.
    modalP = 1;
    paintModal();
  });

  const release = (e) => {
    if (!modalDrag) return;
    const { h } = modalDrag;
    modalDrag = null;
    panel.classList.remove('is-dragging');
    if (e && e.pointerId !== undefined && panel.hasPointerCapture(e.pointerId)) {
      panel.releasePointerCapture(e.pointerId);
    }

    const v = tracker.velocity();
    const sp = modalSprings();
    if (!sp) return;
    // Where it is going, not where it stopped.
    const projected = modalY + Motion.project(v);
    const dismiss = projected > h * 0.32 || v > MODAL_DISMISS_VELOCITY;

    if (dismiss) {
      // Hand the release velocity straight to the spring so there is no
      // seam between the drag and the animation that finishes it.
      sp.y.to(h + 120, { velocity: v, bounce: 0, duration: 0.25 });
      closeCreativeModal(null, { keepY: true });
    } else {
      sp.y.to(0, { velocity: v });
      sp.p.to(1);
    }
  };

  panel.addEventListener('pointerup', release);
  panel.addEventListener('pointercancel', release);
}

function getMetricsHTML(item, titleLabel) {
  if (!item) return '';
  const cqrColorClass = item.cqr === 'Good' ? 'cqr-good' : (item.cqr === 'Average' ? 'cqr-avg' : 'cqr-poor');
  const hlValFormatted = item.holdRate >= 1000 ? (item.holdRate/1000).toFixed(1)+'K' : (item.holdRate||0).toFixed(1);
  const durLabel = item.duration ? `<div style="font-size:10px;color:var(--c-muted);margin-top:3px;">Duration: ${fmtDur(item.duration)}</div>` : '';
  return `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--c-muted);margin-bottom:6px;text-transform:uppercase;">${titleLabel} Paid Stats</div>
      <div class="detail-metrics" style="margin-bottom:6px;">
        <div class="dm"><div class="dm-label">CQR</div><div class="dm-val big-cqr ${cqrColorClass}">${item.cqr||'—'}</div>${durLabel}</div>
        <div class="dm"><div class="dm-label">Spend &amp; Reach</div><div class="dm-val">${fmt(item.spend)}</div><div style="font-size:10px;color:var(--c-muted);margin-top:2px;">Reach: ${fmtN(item.reach)} | Impr: ${fmtN(item.impressions)}</div></div>
        <div class="dm"><div class="dm-label">Hook Rate</div><div class="dm-val" style="color:${hookColor(item.hookRate)}">${(item.hookRate||0).toFixed(1)}%</div><div><span class="kpi-pill ${cqrClass(item.hookQual)}">${item.hookQual||'—'}</span></div></div>
        <div class="dm"><div class="dm-label">Hold Rate</div><div class="dm-val" style="color:var(--ink-900)">${hlValFormatted}</div><div><span class="kpi-pill ${cqrClass(item.holdQual)}">${item.holdQual||'—'}</span></div></div>
      </div>
    </div>`;
}


// ---------------------------------------------------------------------
//  Structured recommendation rendering
//  Claude returns discrete fields rather than one blob, so each part is
//  shown as what it is: a verdict line, what is holding up, what is not,
//  and the action. Evidence timestamps are listed because a claim that
//  cannot point at a scene is not worth acting on.
// ---------------------------------------------------------------------
const REC_PRIORITY = {
  high:   { label: 'High priority',   cls: 'rec-chip-high' },
  medium: { label: 'Medium priority', cls: 'rec-chip-med' },
  low:    { label: 'Low priority',    cls: 'rec-chip-low' },
};
const REC_ACTION = {
  edit:      'Edit',
  scale:     'Scale',
  repurpose: 'Repurpose',
  monitor:   'Monitor',
};

function recChipsHTML(r) {
  const out = [];
  const p = REC_PRIORITY[r.priority];
  if (p) out.push(`<span class="rec-chip ${p.cls}">${p.label}</span>`);
  if (REC_ACTION[r.actionType]) out.push(`<span class="rec-chip rec-chip-type">${REC_ACTION[r.actionType]}</span>`);
  if (r.confidence === 'low') out.push(`<span class="rec-chip rec-chip-low-conf" title="The model flagged this call as uncertain">Low confidence</span>`);
  return out.length ? `<div class="rec-chips">${out.join('')}</div>` : '';
}

function recStructuredHTML(r) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const part = (label, text, cls) => text
    ? `<div class="rec-part ${cls}"><div class="rec-part-label">${label}</div><div class="rec-part-text">${esc(text)}</div></div>`
    : '';
  const ev = Array.isArray(r.evidence) && r.evidence.length
    ? `<div class="rec-evidence"><span class="rec-part-label">Based on</span>${
        r.evidence.map(e => `<span class="rec-ts" title="${esc(e.why)}">${fmtTs(e.t)}</span>`).join('')
      }</div>`
    : '';
  return `
    ${r.verdict ? `<div class="rec-verdict">${esc(r.verdict)}</div>` : ''}
    ${part('Working', r.working, 'rec-good')}
    ${part('Not working', r.notWorking, 'rec-bad')}
    ${part('Do this', r.action, 'rec-action')}
    ${ev}`;
}

function fmtTs(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return String(t);
  const m = Math.floor(n / 60), s = Math.round(n % 60);
  return m ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
}

function getRecHTML(item, titleLabel) {
  if (!item) return '';
  if (item.recommendation) {
    const isActioned = item.actionStatus && item.actionStatus.toLowerCase() === 'actioned';
    // Only the admin (role='admin') or a client user (not internal agency
    // staff) may mark a recommendation actioned and assign it to an agency.
    // Everyone else sees the same pending state with no way to act on it.
    const canAssignAgency = CURRENT_ROLE === 'admin' || !CURRENT_IS_INTERNAL;
    const actionBadge = isActioned
      ? `<div class="sheet-rec-action">Actioned by ${item.actionBy||'Unknown'} on ${item.actionDate||'Date unknown'} (${item.agency||'Agency unassigned'})</div>`
      : `<div class="sheet-rec-action" style="color:#8A5A12">Pending action (${item.agency||'Agency unassigned'}) ${canAssignAgency ? `<button class="action-btn" onclick="openActionModal('${item.id}', '${titleLabel}')">Mark Actioned</button>` : ''}</div>`;
    // Structured recommendations render as parts. Rows written before the
    // structured schema have no .rec and fall back to the original blob.
    const r = item.rec;
    const body = r ? recStructuredHTML(r)
                   : `<div class="sheet-rec-text">${item.recommendation}</div>`;
    const chips = r ? recChipsHTML(r) : '';
    return `<div class="sheet-rec"><div class="sheet-rec-content"><div class="sheet-rec-head"><div class="sheet-rec-label">${titleLabel} Live Recommendation</div>${chips}</div>${body}${actionBadge}</div></div>`;
  } else {
    return `<div class="sheet-rec" style="opacity:0.6;border-color:var(--c-border);background:var(--c-surface);"><div class="sheet-rec-content"><div class="sheet-rec-label" style="color:var(--c-muted);">${titleLabel} Live Recommendation</div><div class="sheet-rec-text" style="color:var(--c-muted);">No recommendation provided.</div></div></div>`;
  }
}

function buildOrganicHTML(d) {
  const ig = d.igOrganic, fb = d.fbOrganic, tt = d.ttOrganic;
  if (!ig && !fb && !tt) return `<div class="organic-empty">No organic data available.</div>`;

  const met24Badge = (meets) => meets ? `<div style="margin-top:4px"><span class="tag-validated" style="font-size:9px;padding:1px 5px;">✓ 24hr Met</span></div>` : '';

  const igBox = !ig ? `<div class="organic-box"><div class="organic-platform">Instagram</div><div class="organic-empty">No data</div></div>` : `<div class="organic-box">
    <div class="organic-platform">Instagram</div>
    <div class="organic-stat-row"><span class="organic-stat-label">Views</span><span class="organic-stat-val">${fmtN(ig.views||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Likes</span><span class="organic-stat-val">${fmtN(ig.likes||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Comments</span><span class="organic-stat-val">${fmtN(ig.comments||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Saves</span><span class="organic-stat-val">${fmtN(ig.saves||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Shares</span><span class="organic-stat-val">${fmtN(ig.shares||0)}</span></div>
    ${ig.avgWatchTime ? `<div class="organic-stat-row"><span class="organic-stat-label">Avg Watch</span><span class="organic-stat-val">${ig.avgWatchTime.toFixed(1)}s</span></div>` : ''}
    ${ig.cqr ? `<div style="margin-top:8px"><span class="val-badge ${ig.cqr==='Good'?'val-good':(ig.cqr==='Average'?'val-avg':'inv-bg')}">CQR: ${ig.cqr}</span></div>` : ''}
    ${met24Badge(ig.meets24hr)}
  </div>`;

  const fbBox = !fb ? `<div class="organic-box"><div class="organic-platform">Facebook</div><div class="organic-empty">No data</div></div>` : `<div class="organic-box">
    <div class="organic-platform">Facebook</div>
    <div class="organic-stat-row"><span class="organic-stat-label">Video Views</span><span class="organic-stat-val">${fmtN(fb.videoViews||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Reactions</span><span class="organic-stat-val">${fmtN(fb.reactions||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Comments</span><span class="organic-stat-val">${fmtN(fb.comments||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Shares</span><span class="organic-stat-val">${fmtN(fb.shares||0)}</span></div>
    ${fb.cqr ? `<div style="margin-top:8px"><span class="val-badge ${fb.cqr==='Good'?'val-good':(fb.cqr==='Average'?'val-avg':'inv-bg')}">CQR: ${fb.cqr}</span></div>` : ''}
    ${met24Badge(fb.meets24hr)}
  </div>`;

  const ttBox = !tt ? `<div class="organic-box"><div class="organic-platform">TikTok</div><div class="organic-empty">No data</div></div>` : `<div class="organic-box">
    <div class="organic-platform">TikTok</div>
    <div class="organic-stat-row"><span class="organic-stat-label">Views</span><span class="organic-stat-val">${fmtN(tt.views||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Likes</span><span class="organic-stat-val">${fmtN(tt.likes||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Comments</span><span class="organic-stat-val">${fmtN(tt.comments||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Saves</span><span class="organic-stat-val">${fmtN(tt.saves||0)}</span></div>
    <div class="organic-stat-row"><span class="organic-stat-label">Shares</span><span class="organic-stat-val">${fmtN(tt.shares||0)}</span></div>
    ${tt.avgWatchTime ? `<div class="organic-stat-row"><span class="organic-stat-label">Avg Watch</span><span class="organic-stat-val">${tt.avgWatchTime.toFixed(1)}s</span></div>` : ''}
    ${tt.cqr ? `<div style="margin-top:8px"><span class="val-badge ${tt.cqr==='Good'?'val-good':(tt.cqr==='Average'?'val-avg':'inv-bg')}">CQR: ${tt.cqr}</span></div>` : ''}
    ${met24Badge(tt.meets24hr)}
  </div>`;

  return `<div class="organic-grid">${igBox}${fbBox}${ttBox}</div>`;
}

// ---------------------------------------------------------------------
//  Organic validation. Everything the CQR badge does not say: why the
//  post got that rating, where it sits against this brand's own organic,
//  what to do per platform, whether it is still climbing, and what it
//  has in common with past paid winners.
//
//  Loaded on first expand rather than with the dashboard payload, so the
//  payload stays the size it is on a brand with a thousand creatives.
// ---------------------------------------------------------------------
const orgValCache = new Map();

async function loadOrganicValidation(detailsEl, creativeId) {
  if (!detailsEl.open) return;
  const box = detailsEl.querySelector('.org-content');
  if (!box || box.dataset.loadedFor === creativeId) return;

  if (orgValCache.has(creativeId)) {
    const cached = orgValCache.get(creativeId);
    box.innerHTML = buildValidationHTML(cached);
    // The summary strip is rebuilt with the panel every time it opens, so
    // it starts from the stored column again and needs the recomputed
    // grades put back on reopen as much as on first load.
    updateSummaryOrganic(cached);
    box.dataset.loadedFor = creativeId;
    return;
  }
  box.innerHTML = `<div class="organic-empty">Loading…</div>`;
  try {
    const res = await fetch(`/api/organic-validation?creative_id=${encodeURIComponent(creativeId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(panelError(res, data));
    orgValCache.set(creativeId, data);
    box.innerHTML = buildValidationHTML(data);
    updateSummaryOrganic(data);
    box.dataset.loadedFor = creativeId;
  } catch (err) {
    // The numbers themselves came with the dashboard payload, so a failed
    // validation call falls back to showing them rather than nothing.
    const fallback = box.dataset.fallback ? decodeURIComponent(box.dataset.fallback) : '';
    box.innerHTML = `<div class="organic-empty">Could not load the validation detail: ${String(err.message || err)}</div>${fallback}`;
  }
}

// ---------------------------------------------------------------------
//  Creative fatigue. The rating elsewhere is a lifetime figure that
//  takes the best single day a creative ever had, so decay is invisible
//  there. This grades each stretch of time on its own.
// ---------------------------------------------------------------------
const fatigueCache = new Map();

async function loadFatigue(detailsEl, creativeId) {
  if (!detailsEl.open) return;
  const box = detailsEl.querySelector('.org-content');
  if (!box || box.dataset.loadedFor === creativeId) return;

  if (fatigueCache.has(creativeId)) {
    box.innerHTML = buildFatigueHTML(fatigueCache.get(creativeId));
    box.dataset.loadedFor = creativeId;
    return;
  }
  box.innerHTML = `<div class="organic-empty">Loading…</div>`;
  try {
    const res = await fetch(`/api/creative-fatigue?creative_id=${encodeURIComponent(creativeId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(panelError(res, data));
    fatigueCache.set(creativeId, data);
    box.innerHTML = buildFatigueHTML(data);
    box.dataset.loadedFor = creativeId;
  } catch (err) {
    box.innerHTML = `<div class="organic-empty">Could not load this: ${String(err.message || err)}</div>`;
  }
}

function buildFatigueHTML(f) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!f || !f.platforms || !f.platforms.length) {
    return `<div class="organic-empty">This creative has not run as paid, so there is no run to read over time.</div>`;
  }
  const chip = g => g && GRADE_CLASS[g]
    ? `<span class="val-badge ${GRADE_CLASS[g]}">${esc(g)}</span>`
    : `<span class="val-badge inv-bg">${esc(g || '—')}</span>`;
  const day = d => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

  const blocks = f.platforms.map(p => {
    const rows = p.windows.map(w => `
      <tr class="${w.key === 'lifetime' ? 'fat-lifetime' : ''}">
        <td>${esc(w.label)}<div class="fat-dates">${day(w.from)} to ${day(w.to)}</div></td>
        <td class="fat-num">${w.hook_rate === null ? '—' : w.hook_rate + '%'}</td>
        <td class="fat-num">${w.hold_rate === null ? '—' : w.hold_rate + '%'}</td>
        <td class="fat-num">${fmt(Math.round(w.spend || 0))}</td>
        <td class="fat-grade">${chip(w.cqr)}${w.thin ? '<div class="fat-dates">thin</div>' : ''}</td>
      </tr>`).join('');

    const dirClass = p.too_short ? 'fat-none' : (p.trend ? `fat-${p.trend.direction}` : 'fat-none');
    return `<div class="orgval-plat">
      <div class="orgval-plat-head">
        <span class="organic-platform" style="margin:0">${esc(p.label)}</span>
        <span class="orgval-chips">${p.still_running
          ? '<span class="val-badge val-good">Running</span>'
          : `<span class="val-badge inv-bg">Stopped${p.ended ? ' ' + day(p.ended) : ''}</span>`}</span>
      </div>
      <table class="fat-table">
        <thead><tr><th>Window</th><th class="fat-num">Hook</th><th class="fat-num">Hold</th><th class="fat-num">Spend</th><th class="fat-grade">CQR</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${p.verdict ? `<div class="orgval-rec-wrap"><div class="orgval-rec ${dirClass}">${esc(p.verdict)}</div></div>` : ''}
    </div>`;
  }).join('');

  const hist = (f.history || []).filter(h => h.channel === 'paid');
  const histBlock = hist.length > 1
    ? `<div class="orgval-winners"><div class="orgval-winners-head">CQR changes recorded</div>
        <ul class="orgval-list">${hist.map(h =>
          `<li>${day(h.changed_at)}: ${esc(h.platform)} CQR ${h.is_first ? 'first read as' : 'moved to'} ${esc(h.cqr || 'unrated')}</li>`
        ).join('')}</ul></div>`
    : `<div class="orgval-winners"><div class="orgval-line orgval-muted">CQR changes are recorded from the night this was switched on, so the list fills up from here rather than reaching back.</div></div>`;

  return `<div class="orgval-grid">${blocks}</div>${histBlock}
    <div class="orgval-line orgval-muted" style="margin-top:12px">${esc(f.note || '')}</div>`;
}

const GRADE_CLASS = { Good: 'val-good', Average: 'val-avg', Poor: 'inv-bg' };
const ACTION_LABEL = {
  boost: 'Boost', boost_reach: 'Boost for reach', recut: 'Recut the opening',
  hold: 'Hold', wait: 'Wait', no_data: 'No data', no_grade: 'Cannot grade',
  already_boosted: 'Already boosted',
};

function buildValidationHTML(v) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!v || !Array.isArray(v.platforms) || !v.platforms.length) {
    return `<div class="organic-empty">This creative has no organic platform on file, so there is nothing to validate.</div>`;
  }


  // "No data" and "no benchmark" are different things and the panel says
  // which. Instagram and Facebook do not return watch time for organic
  // posts, so their retention is absent, not unmeasured-and-weak.
  // rateRow and statusChip were here and were already unused: they printed
  // a rated metric with its figure and grade, which is the thing this panel
  // no longer shows. Left in place they were a working renderer for the
  // method, one call site away from putting it back. Removed rather than
  // kept as dead code.

  // Facebook reaction split. The one sentiment signal available without
  // reading comments, and the one that can contradict the totals: a sad
  // and an angry count towards engagement exactly like a like does.
  const reactionsBlock = (p) => {
    const r = p.reactions;
    if (!r || !r.rows || !r.rows.length) return '';
    const bar = r.rows.filter(x => x.count > 0).map(x =>
      `<span class="orgval-react-seg react-${x.key}" style="width:${x.share}%" title="${x.label} ${x.count}"></span>`).join('');
    const keys = r.rows.filter(x => x.count > 0).map(x =>
      `<span class="orgval-react-key"><span class="orgval-react-dot react-${x.key}"></span>${x.label} ${x.share}%</span>`).join('');
    return `<div class="orgval-divider">How people reacted</div>
      <div class="orgval-react-bar">${bar}</div>
      <div class="orgval-react-keys">${keys}</div>
      <div class="orgval-line ${r.negative_share >= 10 && r.enough ? '' : 'orgval-muted'}">${esc(r.verdict)}</div>`;
  };

  // What the rating means, not what it is made of.
  //
  // This block used to print the metric name, the figure, and the Good and
  // Poor thresholds under the heading "How it is judged", which published
  // the rating method and the brand's benchmarks to anyone with a login.
  // The API no longer sends any of that, so there is nothing here to draw
  // even if a future edit asked for it.
  //
  // What a planner needs from this panel is the same three things either
  // way: what the audience did, where it places against the brand's own
  // output, and whether to act. All three survive without the arithmetic.
  const DIM_COLOUR = (pct) => pct >= 70 ? '#1F8A5B' : pct >= 40 ? '#C4891A' : '#C2414B';
  const ord = (n) => ordinal(n);

  // Each dimension as a rank. The faint mark at the midpoint is the
  // brand's own median, so a bar is read against something rather than
  // floating against an empty track.
  // Label and rank on one line, bar on its own underneath.
  //
  // Side by side, a 112px label and a 44px figure left about thirty
  // pixels of track inside a panel card, which is not a bar. Stacked, the
  // track gets the full width of the card at every breakpoint.
  const dimBars = (dims) => !dims || !dims.length ? '' : `
    <div class="orgval-dims">${dims.map(d => `
      <div class="orgval-dim">
        <div class="orgval-dim-head">
          <span class="orgval-dim-k">${esc(d.label)}</span>
          <span class="orgval-dim-v">${ord(d.percentile)}</span>
        </div>
        <span class="orgval-dim-track"><span class="orgval-dim-mid"></span><span
          class="orgval-dim-fill" style="width:${Math.max(3, Math.min(100, d.percentile))}%;background:${DIM_COLOUR(d.percentile)}"></span></span>
      </div>`).join('')}</div>`;

  /**
   * What the rating means, in four parts: where it ranks, a one-line read
   * of the dimensions, the dimensions themselves, and what is and is not
   * working stated in counts.
   *
   * Boosted is its own shape. The old block delivered a confident grade
   * and then explained that spend was behind the numbers it came from,
   * which is a verdict undercutting itself in the same breath. Once there
   * is spend the organic grade is history, so it is worded as history.
   */
  const judgedRows = (p) => {
    const sg = p.signal || {};
    const st = p.state || null;

    if (p.boosted) {
      // The recommendation below already says to judge it on paid from
      // here, so this stops at what the organic grade was and means.
      return `<div class="orgval-line">${
        sg.grade
          ? `Rated <b>${esc(sg.grade)}</b> organically before the spend started. That is what it earned on its own.`
          : 'Spend started before there was enough organic data to rate it.'
      }</div>`;
    }

    if (!sg.grade) {
      return `<div class="orgval-note">${esc(
        p.state_note || STATE_WHY[st] || 'Not enough has come back to rate this yet.')}</div>`;
    }

    const dims = p.dimensions || [];
    // No headline percentile.
    //
    // signal.percentile is the rank on the figure the rating is built
    // from, so printed beside the dimension bars it is identical to one
    // of them, and whichever it matches is the rating dimension. That
    // hands back the method these bars exist to replace. The bars say
    // where this sits on each dimension; the grade is the verdict.

    // Below the floor the panel says how many comparable posts there were
    // rather than printing a rank computed from three of them.
    const thin = !dims.length
      ? `<div class="orgval-note">Only ${p.peer_count || 0} comparable post${
          (p.peer_count || 0) === 1 ? '' : 's'} this quarter, too few to place it against.</div>`
      : '';

    const summary = p.dimension_summary
      ? `<div class="orgval-dim-sum">${esc(p.dimension_summary)}</div>` : '';

    const wn = (p.working || p.not_working) ? `
      <div class="orgval-wn">
        ${p.working ? `<div class="orgval-line"><b>Working</b> ${esc(p.working)}</div>` : ''}
        ${p.not_working ? `<div class="orgval-line"><b>Not working</b> ${esc(p.not_working)}</div>` : ''}
      </div>` : '';

    return `${thin}${summary}${dimBars(dims)}${wn}`;
  };

  // "Boost — " with nothing after the dash is what an empty recommendation
  // used to render as. The dash is punctuation between two things, so it
  // only belongs here when there are two.
  const recLine = (rec) => {
    const r = rec || {};
    const head = ACTION_LABEL[r.action] || 'Recommendation';
    return `<b>${head}</b>${r.text ? ' — ' + esc(r.text) : ''}`;
  };

  // The raw counts, in each platform's own naming.
  const countsBlock = (p) => {
    const isFb = p.platform === 'fb';
    const rows = [
      [isFb ? 'Video views' : 'Views', p.views],
      ['Reach', p.reach],
      [isFb ? 'Reactions' : 'Likes', p.likes],
      ['Comments', p.comments],
      ['Saves', p.saves],
      ['Shares', p.shares],
    ].filter(([, v]) => v !== null && v !== undefined);
    const watch = p.avg_watch_time
      ? `<div class="organic-stat-row"><span class="organic-stat-label">Avg watch</span><span class="organic-stat-val">${fmtDur(p.avg_watch_time)}</span></div>` : '';
    return `<div class="orgval-counts">${rows.map(([l, v]) =>
      `<div class="organic-stat-row"><span class="organic-stat-label">${l}</span><span class="organic-stat-val">${fmtN(v)}</span></div>`
    ).join('')}${watch}</div>`;
  };

  const platBlocks = v.platforms.map(p => {
    if (p.missing) {
      return `<div class="orgval-plat">
        <div class="orgval-plat-head"><span class="organic-platform" style="margin:0">${esc(p.label)}</span><span class="val-badge inv-bg">No data</span></div>
        <div class="orgval-rec-wrap"><div class="orgval-rec orgval-rec-none">${recLine(p.recommendation)}</div></div>
      </div>`;
    }
    const velocity = p.velocity && p.velocity.text
      ? `<div class="orgval-line">${esc(p.velocity.text)}</div>`
      : (p.velocity && p.velocity.points === 1
          ? `<div class="orgval-line orgval-muted">Only one reading so far, so there is no trend yet. A second pull will show whether it is still climbing.</div>`
          : '');
    const judged = judgedRows(p);
    // The rank line inside judgedRows says where this sits, so the old
    // standing sentence is kept only for posts that have no rank of their
    // own: printing both said the same thing twice in different words.
    const ranked = (p.signal || {}).percentile !== null
      && (p.signal || {}).percentile !== undefined && !p.boosted;
    const standing = ranked ? ''
      : (p.standing && p.standing.words
        ? `<div class="orgval-line"><b>Where it sits:</b> ${esc(p.standing.words)}, against ${p.standing.peers} other posts of the same kind.</div>`
        : '');
    const recClass = p.recommendation.action === 'boost' ? 'orgval-rec-go'
                   : p.recommendation.action === 'hold' ? 'orgval-rec-stop'
                   : ['wait', 'no_data', 'no_grade'].includes(p.recommendation.action) ? 'orgval-rec-none'
                   : 'orgval-rec-mid';

    return `<div class="orgval-plat">
      <div class="orgval-plat-head">
        <span class="organic-platform" style="margin:0">${esc(p.label)}</span>
        <span class="orgval-chips">
          ${p.cqr
            ? `<span class="orgval-grade ${cqrClass(p.cqr)}">${esc(p.cqr)}</span>`
            : `<span class="orgval-grade orgval-grade-none">${esc(p.state ? stateShort(p.state) : 'Not rated')}</span>`}
          ${p.cqr && p.state
            ? `<span class="val-badge inv-bg" title="${esc(p.state_note || '')}">${esc(p.state)}</span>` : ''}
        </span>
      </div>
      ${countsBlock(p)}
      ${reactionsBlock(p)}
      ${judged ? `<div class="orgval-divider">${
        p.boosted ? 'Where the organic rating stands' : 'What this rating means'}</div>` : ''}
      ${judged}
      ${standing}
      ${velocity}
      <div class="orgval-rec-wrap"><div class="orgval-rec ${recClass}">${recLine(p.recommendation)}</div></div>
    </div>`;
  }).join('');

  const split = v.split ? `<div class="orgval-split">${esc(v.split)}</div>` : '';
  const flags = (v.flags || []).length
    ? `<div class="orgval-flags">${v.flags.map(f => `<div>${esc(f)}</div>`).join('')}</div>` : '';

  const w = v.winners || {};
  // A heading over nothing is still an empty box on the page. It only
  // earns its space once there is something under it.
  const winners = (!w.verdict && !(w.matches || []).length) ? '' : `<div class="orgval-winners">
    <div class="orgval-winners-head">What it has in common with your paid winners</div>
    ${w.verdict ? `<div class="orgval-line">${esc(w.verdict)}</div>` : ''}
    ${(w.matches || []).length
      ? `<ul class="orgval-list">${w.matches.slice(0, 5).map(m => `<li class="${m.helps ? 'orgval-supports' : 'orgval-against'}">
          <b>${esc(m.label)}</b> <span class="orgval-when">${m.timing === 'opening' ? 'opening' : 'whole video'}</span><br>
          <span class="orgval-muted">Rated Good ${m.with.goodRate}% of the time with it (${m.with.creatives} creatives) against ${m.without.goodRate}% without (${m.without.creatives}).${m.early ? ' Early sign, small groups.' : ''}</span>
        </li>`).join('')}</ul>`
      : ''}
    ${w.basis ? `<div class="orgval-line orgval-muted">Based on ${w.basis} paid creatives above the delivery floor.</div>` : ''}
  </div>`;

  return `${split}${flags}<div class="orgval-grid">${platBlocks}</div>${winners}`;
}

function buildCreativeBriefHTML(d) {
  const timeline = Array.isArray(d.timeline) ? d.timeline : [];
  const hasQuartiles = d.segments && d.segments.length > 0;
  if (!d.contentHook && !timeline.length && !hasQuartiles) return '';

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Format classification, when the creative has been analysed with it.
  const FORMAT_LABEL = {
    music_video:'Music video', product_demo:'Product demo', talking_head:'Talking head',
    testimonial:'Testimonial', lifestyle:'Lifestyle', tutorial:'Tutorial',
    ugc:'UGC', animation:'Animation', other:'Other',
  };
  const ROLE_LABEL = {
    hero:'Product is the subject', featured:'Product featured',
    incidental:'Product incidental', absent:'Product not shown',
  };
  const metaBits = [
    FORMAT_LABEL[d.format] ? `<span class="brief-tag">${FORMAT_LABEL[d.format]}</span>` : '',
    ROLE_LABEL[d.productRole] ? `<span class="brief-tag brief-tag-quiet">${ROLE_LABEL[d.productRole]}</span>` : '',
    d.duration ? `<span class="brief-tag brief-tag-quiet">${fmtDur(d.duration)}</span>` : '',
  ].filter(Boolean).join('');

  // The scene timeline, grouped into quarters so a 76-window video is
  // readable. Each row is a real window with its timestamp.
  let timelineHTML = '';
  if (timeline.length) {
    const total = d.duration || (timeline[timeline.length-1].t + 2);
    const groups = [
      { label:'First quarter',  from:0,           to:total*0.25 },
      { label:'Second quarter', from:total*0.25,  to:total*0.5 },
      { label:'Third quarter',  from:total*0.5,   to:total*0.75 },
      { label:'Final quarter',  from:total*0.75,  to:Infinity },
    ];
    timelineHTML = `<div class="brief-timeline">` + groups.map(g => {
      const rows = timeline.filter(s => s.t >= g.from && s.t < g.to);
      if (!rows.length) return '';
      return `<div class="brief-group">
          <div class="brief-group-label">${g.label} <span class="brief-group-range">${fmtBriefTs(rows[0].t)}–${fmtBriefTs(rows[rows.length-1].t)}</span></div>
          ${rows.map(s => `<div class="brief-scene"><span class="brief-ts">${fmtBriefTs(s.t)}</span><span class="brief-scene-text">${esc(s.d)}</span></div>`).join('')}
        </div>`;
    }).join('') + `</div>`;
  } else if (hasQuartiles) {
    // Creatives described before the timeline format existed.
    const segLabels = ['0–25%', '25–50%', '50–75%', '75–100%'];
    timelineHTML = `<div class="brief-segs">${d.segments.map((s,i) =>
      `<div class="seg-row"><div class="seg-label">${segLabels[i]||`Seg ${i+1}`}</div><div class="seg-text">${esc(s)}</div></div>`).join('')}</div>`;
  }

  const sceneCount = timeline.length ? `<span class="brief-count">${timeline.length} scenes</span>` : '';

  return `
    <details class="org-details" style="margin-top:12px;">
      <summary class="org-summary">Creative Brief <span style="color:var(--c-muted);font-size:10px;">Click to expand ▼</span></summary>
      <div class="org-content">
        ${metaBits ? `<div class="brief-tags">${metaBits}</div>` : ''}
        ${d.formatNote ? `<div class="brief-note">${esc(d.formatNote)}</div>` : ''}
        ${d.contentHook ? `<div class="brief-hook"><span class="brief-hook-label">Hook</span><div class="brief-hook-text">${esc(d.contentHook)}</div></div>` : ''}
        ${timelineHTML ? `<div class="brief-timeline-head"><span class="brief-hook-label">Scene by scene</span>${sceneCount}</div>${timelineHTML}` : ''}
      </div>
    </details>`;
}

function fmtBriefTs(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return String(t);
  const m = Math.floor(n / 60), s = Math.round(n % 60);
  return m ? `${m}:${String(s).padStart(2,'0')}` : `0:${String(s).padStart(2,'0')}`;
}

// ── Lineage ───────────────────────────────────────────────────────────────────
// Repurposed assets carry extractedOrigId pointing back at their source.
function repurposesOf(id) {
  if (!id || typeof ALL === 'undefined') return [];
  return ALL.filter(x => x.isRepurposed && x.extractedOrigId === id);
}

function originOf(d) {
  if (!d.isRepurposed || !d.extractedOrigId || typeof ALL === 'undefined') return null;
  return ALL.find(x => x.id === d.extractedOrigId) || null;
}

function lineageRow(x) {
  const bits = [x.campaign, x.month].filter(Boolean).join(' · ');
  const hook = (x.hookRate || x.hookRate === 0) ? kpiPct(x.hookRate) : '—';
  return `<button class="lin-row" data-press onclick="selectCard('${x.id}', this)">
      <span class="lin-name">${x.short || x.id}</span>
      <span class="lin-meta">${bits}</span>
      <span class="lin-metric">Hook ${hook}</span>
    </button>`;
}

function kpiPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v > 1 ? v : v * 100).toFixed(1) + '%';
}

function buildLineageHTML(d) {
  const kids = repurposesOf(d.id);
  const orig = originOf(d);

  if (orig) {
    return `<div class="lineage">
        <div class="lin-title">Repurposed from</div>
        ${lineageRow(orig)}
      </div>`;
  }
  if (kids.length) {
    return `<div class="lineage">
        <div class="lin-title">Repurposed into <span class="lin-count">${kids.length}</span></div>
        ${kids.map(lineageRow).join('')}
      </div>`;
  }
  // Repurposed, but the source is not in this brand's data
  if (d.isRepurposed && d.originalName) {
    return `<div class="lineage">
        <div class="lin-title">Repurposed from</div>
        <div class="lin-row lin-row-plain"><span class="lin-name">${d.originalName}</span>
          <span class="lin-meta">Not in this dataset</span></div>
      </div>`;
  }
  return '';
}

function renderDetail(d) {
  const platLabel = d.platform === 'both' ? 'Meta & TikTok' : (d.platform==='tiktok'?'TikTok':'Meta');
  let statsHTML = '', recsHTML = '';
  if (d.platform === 'both') {
    statsHTML = getMetricsHTML(d._meta, 'Meta') + getMetricsHTML(d._tt, 'TikTok');
    recsHTML  = getRecHTML(d._meta, 'Meta') + getRecHTML(d._tt, 'TikTok');
  } else {
    statsHTML = getMetricsHTML(d, d.platform==='meta'?'Meta':'TikTok');
    recsHTML  = getRecHTML(d, d.platform==='meta'?'Meta':'TikTok');
  }

  // One button per platform the creative was actually posted to, rather than
  // a single button to whichever link happened to come first.
  const links = platformLinks(d);
  let linkBtns = '<div class="btn-group">';
  links.forEach((l, i) => {
    linkBtns += `<button class="view-btn${i === 0 ? ' primary' : ''}"
      onclick="window.open('${escapeHtml(l.url)}','_blank','noopener')">Open on ${escapeHtml(l.name)}</button>`;
  });
  if (!links.length && d.originalUrl) {
    linkBtns += `<button class="view-btn primary" onclick="window.open('${escapeHtml(d.originalUrl)}','_blank','noopener')">Open the original</button>`;
  }
  linkBtns += '</div>';

  const previewLink = links.length ? links[0] : null;
  const previewHTML = d.thumbnail ? `
    <div class="detail-media">
      <img src="${escapeHtml(d.thumbnail)}" alt="" onerror="this.closest('.detail-media').remove()">
      ${previewLink ? `<button class="detail-play" data-press title="Open on ${escapeHtml(previewLink.name)}"
         aria-label="Open on ${escapeHtml(previewLink.name)}"
         onclick="window.open('${escapeHtml(previewLink.url)}','_blank','noopener')"
        >${playMark(26)}</button>` : ''}
    </div>` : '';

  let valUI = '';
  if (d.isValidated) {
    const cls = d.bestOrgCqr === 'Good' ? 'val-good' : 'val-avg';
    valUI = `<span class="val-badge ${cls}">✓ Validated (${d.bestOrgCqr||'24hr Met'})</span>`;
    if (d.needsBoostWarning) valUI += `<div class="warning-badge">Alert: Validated > 48h, Not Boosted</div>`;
  }

  const repText = '';

  let creatorHTML = '';
  if (d.type === 'Others Say') {
    const creator = extractCreatorInfo(d.creatorProfile, d.ttLink);
    if (creator) {
      const linkEl = creator.profileUrl
        ? `<a href="${creator.profileUrl}" target="_blank" class="creator-link">${creator.username} ↗</a>`
        : `<span class="creator-name">${creator.username}</span>`;
      creatorHTML = `<div class="creator-row">Creator: ${linkEl}</div>`;
    }
  }

  const metaParts = [platLabel, d.campaign, d.month];
  if (d.duration) metaParts.push(fmtDur(d.duration));
  if (d.contentType) metaParts.push(d.contentType);

  document.getElementById('creativeModalContent').innerHTML = `
    <div class="cm-body">
      <div class="detail-header">
        <div>
          <div class="detail-title">${d.short}<span class="card-type ${d.type==='Brand Say'?'bs-tag':'os-tag'}" style="margin-left:6px">${d.type}</span>${d.source==='community'?'<span class="card-type community-tag" style="margin-left:4px">Community</span>':''}${d.creatorLed?'<span class="card-type creator-led-tag" style="margin-left:4px">Creator-led</span>':''}${valUI}</div>
          <div class="detail-meta">${metaParts.join(' · ')}</div>
          ${creatorHTML}${repText}${linkBtns}
        </div>
        ${previewHTML}
        <div class="detail-nav">${panelNavHTML(d.id)}
          <button class="close-btn" data-press aria-label="Close" onclick="closeCreativeModal({target:{id:'creativeModalOverlay'}})">×</button>
        </div>
      </div>

      ${detailSummaryHTML(d)}

      ${buildLineageHTML(d)}

      <details class="org-details" style="margin-top:12px;" open ontoggle="loadOrganicValidation(this, '${d.id}')">
        <summary class="org-summary">Organic Performance <span style="color:var(--c-muted);font-size:10px;">Numbers, why this rating, and whether to boost ▼</span></summary>
        <div class="org-content"
             data-fallback="${encodeURIComponent(buildOrganicHTML(d))}"><div class="organic-empty">Loading…</div></div>
      </details>

      ${typeof PreTest !== 'undefined' ? PreTest.detailSection(d) : ''}

      ${statsHTML}

      ${buildCreativeBriefHTML(d)}

      <details class="org-details" style="margin-top:12px;" ontoggle="loadFatigue(this, '${d.id}')">
        <summary class="org-summary">How it is holding up <span style="color:var(--c-muted);font-size:10px;">CQR over time, not lifetime ▼</span></summary>
        <div class="org-content"><div class="organic-empty">Loading…</div></div>
      </details>

      <div style="margin-top:14px">${recsHTML}</div>

      <div class="charts-row" style="margin-top:14px;">
        <div class="chart-box"><div class="chart-box-title">Retention drop-off</div><div class="chart-container" style="height:160px"><canvas id="retChart"></canvas></div></div>
        <div class="chart-box"><div class="chart-box-title">Performance radar</div><div class="chart-container" style="height:160px"><canvas id="radarChart"></canvas></div></div>
      </div>
    </div>`;

  // Organic opens by default now, and ontoggle only fires when the open
  // state changes, so an initially-open details never calls its loader.
  const openOrg = document.querySelector('#creativeModalContent details.org-details[open]');
  if (openOrg) loadOrganicValidation(openOrg, d.id);

  if (retChart)   retChart.destroy();
  if (radarChart) radarChart.destroy();

  const gc = '#E4E6EA';   // gridlines, line-200
  const tc = '#8A909B';   // axis labels, ink-400
  const norm = v => Math.min(Math.round(v), 100);

  const retDatasets = [], radDatasets = [];
  let hookPointLabel = 'Hook Point';

  if (d.platform === 'both') {
    hookPointLabel = 'Hook (3s/2s)';
    retDatasets.push({label:'Meta %',   data:d._meta.ret, borderColor:'#1877f2', backgroundColor:'rgba(24,119,242,0.1)', fill:true, tension:0.3, pointBackgroundColor:'#1877f2', pointRadius:0, borderWidth:2});
    retDatasets.push({label:'TikTok %', data:d._tt.ret,   borderColor:'#ff0050', backgroundColor:'rgba(255,0,80,0.1)',   fill:true, tension:0.3, pointBackgroundColor:'#ff0050', pointRadius:0, borderWidth:2});

    // Radar: Eng Rate, Hook Rate, Hold Rate, CPM Efficiency, Reach
    const metaEngRate = d._meta.impressions > 0 ? norm((d._meta.reach / d._meta.impressions) * 200) : 0;
    const ttEngRate   = d._tt.impressions   > 0 ? norm((d._tt.reach   / d._tt.impressions)   * 200) : 0;
    const metaCPMEff  = (d._meta.spend > 0 && d._meta.reach > 0) ? norm(Math.max(0, 100 - (d._meta.spend / d._meta.reach * 1000))) : 0;
    const ttCPMEff    = (d._tt.spend   > 0 && d._tt.reach   > 0) ? norm(Math.max(0, 100 - (d._tt.spend   / d._tt.reach   * 1000))) : 0;
    const metaReachN  = norm(d._meta.reach / 50000 * 100);
    const ttReachN    = norm(d._tt.reach   / 50000 * 100);

    radDatasets.push({label:'Meta',   data:[metaEngRate, norm(d._meta.hookRate*2), norm(d._meta.holdRate*2), metaCPMEff, metaReachN], borderColor:'#1877f2', backgroundColor:'rgba(24,119,242,0.15)', borderWidth:2, pointRadius:0});
    radDatasets.push({label:'TikTok', data:[ttEngRate,   norm(d._tt.hookRate*2),   norm(d._tt.holdRate*2),   ttCPMEff,   ttReachN],   borderColor:'#ff0050', backgroundColor:'rgba(255,0,80,0.15)',   borderWidth:2, pointRadius:0});
  } else {
    hookPointLabel = d.platform==='tiktok'?'2s hook':'3s hook';
    const color  = d.platform==='tiktok'?'#ff0050':'#1877f2';
    const bgLine = d.platform==='tiktok'?'rgba(255,0,80,0.1)':'rgba(24,119,242,0.1)';
    const bgRad  = d.platform==='tiktok'?'rgba(255,0,80,0.15)':'rgba(24,119,242,0.15)';
    retDatasets.push({label:'%', data:d.ret, borderColor:color, backgroundColor:bgLine, fill:true, tension:0.3, pointBackgroundColor:color, pointRadius:0, borderWidth:2});

    const engRate = d.impressions > 0 ? norm((d.reach / d.impressions) * 200) : 0;
    const cpmEff  = (d.spend > 0 && d.reach > 0) ? norm(Math.max(0, 100 - (d.spend / d.reach * 1000))) : 0;
    const reachN  = norm(d.reach / 50000 * 100);

    radDatasets.push({label:d.platform, data:[engRate, norm(d.hookRate*2), norm(d.holdRate*2), cpmEff, reachN], borderColor:color, backgroundColor:bgRad, borderWidth:2, pointRadius:0});
  }

  retChart = new Chart(document.getElementById('retChart'), {
    type:'line', data:{labels:['Start',hookPointLabel,'25%','50%','75%','100%'], datasets:retDatasets},
    options:{responsive:true,maintainAspectRatio:false,scales:{y:{min:0,max:105,grid:{color:gc},ticks:{color:tc,callback:v=>v+'%'}},x:{grid:{color:gc},ticks:{color:tc,font:{size:10}}}},plugins:{legend:{display:d.platform==='both',labels:{color:tc,font:{size:10},boxWidth:10}},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw.toFixed(1)}%`}}}}
  });

  radarChart = new Chart(document.getElementById('radarChart'), {
    type:'radar',
    data:{
      labels:['Eng. Rate','Hook Rate','Hold Rate','CPM Eff.','Reach'],
      datasets:radDatasets
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      scales:{r:{min:0,max:100,grid:{color:gc},ticks:{display:false},pointLabels:{color:tc,font:{size:10}},angleLines:{color:gc}}},
      plugins:{
        legend:{display:d.platform==='both',labels:{color:tc,font:{size:10},boxWidth:10}},
        tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw}`}}
      }
    }
  });
}

let pendingAction = null;

function openActionModal(creativeId, platform) {
  pendingAction = { id: creativeId, platform };
  document.getElementById('actionModal').style.display = 'flex';
  document.getElementById('actionNameDisplay').textContent = CURRENT_USER || 'Unknown user';
  const ag = document.getElementById('actionAgencyInput');
  ag.innerHTML = '<option value="">Select agency</option>' +
    AGENCIES.map(a => `<option value="${a.name}">${a.name}</option>`).join('');
}

function closeActionModal() {
  document.getElementById('actionModal').style.display = 'none';
  pendingAction = null;
}

async function confirmAction() {
  const name   = CURRENT_USER;
  const agency = document.getElementById('actionAgencyInput').value;
  if (!agency) return toast("Please select an agency.", 'error');
  const btn = document.getElementById('modalConfirmBtn');
  const origText = btn.innerText;
  btn.innerText = 'Updating...'; btn.disabled = true;
  try {
    const creative = ALL.find(c => c.id === pendingAction.id);
    const platform = pendingAction.platform === 'Meta' ? 'meta' : 'tiktok';
    const sourceItem = platform === 'meta' ? (creative._meta || creative) : (creative._tt || creative);
    const dateStr = new Date().toISOString().slice(0, 10);

    const res = await fetch('/api/update-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creative_id: pendingAction.id,
        platform,
        action_status: 'Actioned',
        actioned_by: name,
        action_date: dateStr,
        agency
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    sourceItem.actionStatus = 'Actioned';
    sourceItem.actionBy = name;
    sourceItem.actionDate = dateStr;
    sourceItem.agency = agency;
    closeActionModal();
    renderDetail(creative);
    toast('Marked as actioned.');
  } catch(err) {
    toast("Couldn't update it: " + err.message, 'error');
  } finally {
    btn.innerText = origText; btn.disabled = false;
  }
}

function openAddCreativeModal() {
  resetAddCreativeForm();
  document.getElementById('addCreativeModal').style.display = 'flex';
  const campaignSelect = document.getElementById('ac-campaign');
  const campaigns = CAMPAIGNS.length > 0
    ? CAMPAIGNS
    : [...new Set(ALL.map(c => c.campaign).filter(c => c && c !== 'Unknown'))];
  campaignSelect.innerHTML = '<option value="" disabled selected>Select Campaign</option>';
  if (campaigns.length === 0) {
    campaignSelect.innerHTML += '<option value="Cool Fresh">Cool Fresh</option>';
  } else {
    campaigns.forEach(c => { campaignSelect.innerHTML += `<option value="${c}">${c}</option>`; });
  }
  const orgIdSelect = document.getElementById('ac-original-id');
  const creativeIds = [...new Set(ALL.map(c => c.id).filter(id => id))];
  orgIdSelect.innerHTML = '<option value="" disabled selected>Select Original Creative ID</option>';
  if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn('addCreativeModal');
  if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
  creativeIds.forEach(id => { orgIdSelect.innerHTML += `<option value="${id}">${id}</option>`; });
  // Last, not first: the styled controls have to exist before anything can
  // be hidden, or they are built visible around a hidden select.
  toggleCreativeFields();
}

function closeAddCreativeModal() {
  document.getElementById('addCreativeModal').style.display = 'none';
  document.getElementById('addCreativeForm').reset();
  toggleCreativeFields();
}

/**
 * Show or hide one field in the Add Creative form.
 *
 * dropdowns.js replaces each native <select> with a styled button, wrapping
 * the select in a div.dd and moving it inside. Hiding the select therefore
 * hides something that is already hidden, and the visible control stays put.
 * That is why Repurposed and Original Creative ID were showing on Others Say
 * creatives. Hide the wrapper when there is one.
 */
/**
 * Show or hide one field in the Add Creative form.
 *
 * Every field sits in a persistent .ac-field wrapper in the markup.
 * dropdowns.js replaces each <select> with a styled control and moves the
 * select into a div of its own, so toggling the select itself is both
 * invisible and order-dependent: hide it before the styled controls are
 * built and a fresh, visible wrapper appears around it a moment later.
 * That is why every field was showing when the modal opened and behaving
 * correctly only after the first pick. Toggling the outer wrapper works
 * either way round.
 */
function acShowField(id, visible, { required = false, clear = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const shell = el.closest('.ac-field') || el.closest('.dd') || el;
  shell.style.display = visible ? '' : 'none';
  el.required = visible && required;
  if (!visible && clear) {
    if (el.type === 'checkbox') el.checked = false;
    else el.value = '';
    // The styled button paints from the select, so it needs repainting
    // after a value is cleared or it keeps showing the old choice.
    const wrap = el.closest('.dd');
    if (wrap && wrap._ddRepaint) wrap._ddRepaint();
  }
}

// Each field appears only once the answer above it makes it relevant.
function toggleCreativeFields() {
  const type = document.getElementById('ac-type').value;
  const isBrand = type === 'Brand Say';
  const isOthers = type === 'Others Say';

  // Others Say: who posted it, a creator or the public.
  acShowField('ac-source', isOthers, { required: true });

  // Brand Say: was it repurposed, and was it led by a creator.
  acShowField('ac-repurposed', isBrand, { required: true });
  acShowField('ac-creator-led', isBrand);

  // Original creative only follows a Yes on repurposed.
  toggleOriginalIdField();
}

function toggleOriginalIdField() {
  const isBrand = document.getElementById('ac-type').value === 'Brand Say';
  const repurposed = document.getElementById('ac-repurposed').value;
  acShowField('ac-original-id', isBrand && repurposed === 'Yes', { required: true });
}

let LAST_CREATIVE_ID = null;

function showCreativeSummary(result) {
  LAST_CREATIVE_ID = result.creativeId;
  const a = result.analysis || {};
  const segs = (a.segments || []).filter(Boolean);
  const labels = ['0–25%', '25–50%', '50–75%', '75–100%'];
  const failed = !a.hook && segs.length === 0;
    // submitCreative disables pointer events on the modal while processing.
  // The old code restored them in resetSubmitUI(); this path bypasses it.
  document.getElementById('addCreativeModal').style.pointerEvents = 'auto';

  document.getElementById('ac-progress-container').style.display = 'none';
  document.getElementById('ac-confirm-btn').style.display = 'none';
  document.getElementById('ac-cancel-btn').style.display = 'none';
  document.getElementById('ac-done-btn').style.display = 'inline-flex';
  document.getElementById('ac-regen-btn').style.display = failed ? 'inline-flex' : 'none';

  const box = document.getElementById('ac-summary');
  box.style.display = 'block';
  box.innerHTML = `
    <div class="brief-hook" style="margin-bottom:12px">
      <span class="brief-hook-label">Creative ID</span>
      <div class="brief-hook-text" style="font-family:var(--font-mono);font-size:13px">${result.creativeId}</div>
      <div style="font:400 12px/16px var(--font-ui);color:var(--ink-500);margin-top:6px">
        Add this after the pipe in the ad name when the asset is boosted.
      </div>
    </div>
    ${a.duration ? `<div class="organic-stat-row"><span class="organic-stat-label">Duration</span><span class="organic-stat-val">${fmtDur(a.duration)}</span></div>` : ''}
    ${failed ? `
      <div class="warning-badge" style="display:block;margin-top:12px">
        Analysis did not complete
      </div>
      <div style="font:400 13px/18px var(--font-ui);color:var(--ink-500);margin-top:8px">
        The creative is saved. Descriptions can be generated again without re-entering anything.
      </div>` : `
      ${a.hook ? `<div class="brief-hook" style="margin-top:12px"><span class="brief-hook-label">Hook</span><div class="brief-hook-text">${a.hook}</div></div>` : ''}
      ${segs.length ? `<div class="brief-segs" style="margin-top:12px">${
        segs.map((s,i)=>`<div class="seg-row"><div class="seg-label">${labels[i]||''}</div><div class="seg-text">${s}</div></div>`).join('')
      }</div>` : ''}`}
  `;
}

// ---------------------------------------------------------------------
//  readJson(res)
//  An expired session redirects to /login, which returns HTML. Calling
//  res.json() on that gives "Unexpected token '<'", which says nothing
//  about the real cause. This reads the body once and reports what
//  actually happened.
// ---------------------------------------------------------------------
async function readJson(res) {
  const text = await res.text();
  const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
  if (looksHtml) {
    if (res.status === 401 || res.status === 403 || res.redirected || /\/login/.test(res.url || '')) {
      throw new Error('Your session has expired. Reload the page and sign in again.');
    }
    throw new Error(`Server returned a page instead of data (HTTP ${res.status}). The request may have timed out or the server may have restarted.`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Unreadable response from server (HTTP ${res.status}): ${text.slice(0, 160)}`); }
  if (!res.ok) throw new Error(json.error || `Request failed (HTTP ${res.status}).`);
  return json;
}

async function regenerateDescription() {
  const btn = document.getElementById('ac-regen-btn');
  const orig = btn.innerText;
  btn.innerText = 'Analysing...'; btn.disabled = true;
  try {
    const res = await fetch('/api/regenerate-description', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creative_id: LAST_CREATIVE_ID }),
      signal: AbortSignal.timeout(120000)
    });
    const result = await readJson(res);
    if (result.error) throw new Error(result.error);
    showCreativeSummary(result);
  } catch (err) {
    // yt-dlp writes warnings to stderr; the real cause is the last line.
    const lines = String(err.message).split('\n').filter(l => l.trim() && !/^\s*(WARNING|It is strongly|Run "yt-dlp|To suppress|Pre-merged|To prioritize)/.test(l));
    toast('Analysis failed: ' + (lines.pop() || err.message).trim(), 'error');
  } finally {
    btn.innerText = orig; btn.disabled = false;
  }
}


// ---------------------------------------------------------------------
//  Platform toggles + review step
//  A link field is only editable when its toggle is on, and then it is
//  required. Turning a platform off is a deliberate "not used", which is
//  different from leaving a box blank by accident.
// ---------------------------------------------------------------------
const AC_PLATS = [
  { k: 'ig', label: 'Instagram' },
  { k: 'fb', label: 'Facebook' },
  { k: 'tt', label: 'TikTok' },
];

// The checkbox is the single source of truth for whether a link field is
// editable. form.reset() unchecks boxes without firing change, so anything
// that resets the form must call syncPlatFields() rather than set .disabled
// itself — that drift is what left a toggle on with its box still disabled.
function syncPlatFields({ clearOff = true } = {}) {
  AC_PLATS.forEach(p => {
    const box = document.getElementById(`ac-${p.k}-on`);
    const input = document.getElementById(`ac-${p.k}`);
    if (!box || !input) return;
    input.disabled = !box.checked;
    if (!box.checked && clearOff) input.value = '';
  });
}

const DESCRIPTION_MAX = 20;
function slugForId(s) {
  return String(s || '').toUpperCase().replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]+/g, '').slice(0, DESCRIPTION_MAX);
}

// Mirrors the server's id rule. The trailing number is allocated on save from
// a per-brand counter, so it cannot be known here; #### stands in for it.
function previewCreativeId() {
  const el = document.getElementById('ac-id-preview');
  if (!el) return;
  const type = (document.getElementById('ac-type') || {}).value;
  const desc = (document.getElementById('ac-description') || {}).value;
  const slug = slugForId(desc);
  const code = type === 'Others Say' ? 'OS' : 'BS';
  const brand = (typeof BRAND_NAME !== 'undefined' && BRAND_NAME ? BRAND_NAME : 'BRAND').toUpperCase();
  el.innerHTML = `ID will be <b>${brand}_${code}_${slug}####</b>, with the number assigned on save.`;
}

function onPlatToggle(k) {
  syncPlatFields();
  const box = document.getElementById(`ac-${k}-on`);
  const input = document.getElementById(`ac-${k}`);
  if (box && box.checked && input) input.focus();
}

function acReadForm() {
  const plats = {};
  AC_PLATS.forEach(p => {
    plats[p.k] = {
      on: document.getElementById(`ac-${p.k}-on`).checked,
      link: document.getElementById(`ac-${p.k}`).value.trim(),
      label: p.label,
    };
  });
  return {
    description: (document.getElementById('ac-description') || {}).value || '',
    campaign: document.getElementById('ac-campaign').value,
    type: document.getElementById('ac-type').value,
    source: (document.getElementById('ac-source') || {}).value || '',
    creatorLed: !!(document.getElementById('ac-creator-led') || {}).checked,
    repurposed: document.getElementById('ac-repurposed').value || 'No',
    originalId: document.getElementById('ac-original-id').value || '',
    plats,
  };
}

// Returns an error string, or null when the form is good to review.
function acValidate(f) {
  if (!f.campaign) return 'Select a campaign.';
  if (!f.type) return 'Select a category.';
  if (f.type === 'Others Say' && !f.source) return 'Choose whether this is creator or community content.';
  const anyOn = AC_PLATS.some(p => f.plats[p.k].on);
  if (!anyOn) return 'Turn on at least one platform. A creative with no links cannot have stats.';
  let bad = false;
  for (const p of AC_PLATS) {
    const v = f.plats[p.k];
    if (!v.on) { acSetErr(p.k, ''); continue; }
    if (!v.link) { acSetErr(p.k, 'Add the link or turn this platform off.'); bad = true; continue; }
    const r = window.CLLinks.validate(p.k, v.link, { source: f.source });
    // needsResolve is not an error: the server follows the redirect.
    if (!r.ok && !r.needsResolve) { acSetErr(p.k, r.error); bad = true; }
    else acSetErr(p.k, '');
  }
  return bad ? 'Fix the highlighted links.' : null;
}

/**
 * What "Posted by" currently says.
 *
 * Only Others Say has a source, and only 'community' changes anything: a
 * community page's Facebook post may be a photo or a plain post, where a
 * brand's or a creator's has to be a video. Read live from the form rather
 * than passed in, because the blur handler has no form object.
 */
function acSource() {
  const type = (document.getElementById('ac-type') || {}).value || '';
  if (type !== 'Others Say') return '';
  return (document.getElementById('ac-source') || {}).value || '';
}

// ---- inline link errors -------------------------------------------------
function acSetErr(k, msg) {
  const el = document.getElementById(`ac-${k}-err`);
  const input = document.getElementById(`ac-${k}`);
  if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
  if (input) input.classList.toggle('plat-input-bad', !!msg);
}
function acClearErr(k) { acSetErr(k, ''); }

// Instant format check on blur. Duplicates and short-link resolution need
// the server, so those are checked when Review is pressed.
function acCheckOne(k) {
  const box = document.getElementById(`ac-${k}-on`);
  const input = document.getElementById(`ac-${k}`);
  if (!box || !box.checked || !input || !input.value.trim()) return;
  const r = window.CLLinks.validate(k, input.value, { source: acSource() });
  acSetErr(k, (!r.ok && !r.needsResolve) ? r.error : '');
}

/**
 * Re-check the Facebook box when "Posted by" changes.
 *
 * The same link is valid under one setting and not the other, so an error
 * left over from the previous setting would be wrong, and worse, a link
 * accepted as a community post would stay accepted after switching to
 * creator. Only Facebook is affected.
 */
function acRecheckFb() {
  const input = document.getElementById('ac-fb');
  const box = document.getElementById('ac-fb-on');
  if (!input || !box) return;
  if (!box.checked || !input.value.trim()) { acSetErr('fb', ''); return; }
  acCheckOne('fb');
}

// Server check: resolves short links, catches duplicates. Returns true when
// every link passes, having written each field's error under it.
async function acServerCheck(f) {
  const body = { source: f.source || '' };
  AC_PLATS.forEach(p => { if (f.plats[p.k].on) body[p.k] = f.plats[p.k].link; });
  let data;
  try {
    const r = await fetch('/api/check-links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  } catch (e) {
    toast('Could not check the links: ' + e.message, 'error');
    return false;
  }
  for (const p of AC_PLATS) {
    const res = data.fields && data.fields[p.k];
    acSetErr(p.k, res && !res.ok ? res.error : '');
    // Show the cleaned link, so a short TikTok link visibly becomes the
    // full one before the user confirms.
    if (res && res.ok && res.url) document.getElementById(`ac-${p.k}`).value = res.url;
  }
  AC_CONTENT = data.content || null;
  return !!data.ok;
}

// A warning shown in the review step when the links do not look like the
// same video. Informational notes (could not compare) are shown quietly.
function acContentBlock() {
  const c = AC_CONTENT;
  if (!c) return '';
  if (c.verdict === 'different') {
    return `<div class="rv-content-warn"><b>These links look like different videos.</b> ${escapeHtml(c.warning || '')}
      <div class="rv-content-sub">Only one of them is analysed, so the creative's description would not match the other's numbers.
      Go back and check the links, or add it anyway if they really are the same content.</div></div>`;
  }
  if (c.note) return `<div class="rv-content-note">${escapeHtml(c.note)}</div>`;
  return '';
}

function acRenderReview(f) {
  const line = (k, v, off) => `<div class="rv-line"><span class="rv-k">${k}</span><span class="rv-v ${off ? 'rv-off' : ''}">${escapeHtml(v)}</span></div>`;
  const offCount = AC_PLATS.filter(p => !f.plats[p.k].on).length;
  return `<div class="rv">
    <h4>Check before submitting</h4>
    ${f.description ? line('Description', f.description) : ''}
    ${line('Campaign', f.campaign)}
    ${line('Category', f.type)}
    ${f.type === 'Others Say' ? line('Posted by', f.source === 'community' ? 'Community' : 'Creator') : ''}
    ${f.type === 'Brand Say' ? line('Led by a creator', f.creatorLed ? 'Yes' : 'No') : ''}
    ${f.type === 'Brand Say' ? line('Repurposed', f.repurposed) : ''}
    ${f.repurposed === 'Yes' && f.originalId ? line('Original creative', f.originalId) : ''}
    ${AC_PLATS.map(p => {
      const v = f.plats[p.k];
      return line(p.label, v.on ? v.link : 'Not used', !v.on);
    }).join('')}
    ${offCount ? `<div class="rv-warn">${offCount} platform${offCount > 1 ? 's' : ''} recorded as not used. Go back if that is wrong.</div>` : ''}
  </div>`;
}

function backToEdit() {
  document.getElementById('ac-review').style.display = 'none';
  document.getElementById('addCreativeForm').querySelectorAll('input,select').forEach(el => {
    if (!el.id.startsWith('ac-')) return;
    el.style.display = '';
  });
  document.querySelectorAll('#addCreativeForm .plat-rows').forEach(el => el.style.display = '');
  ['ac-campaign', 'ac-type', 'ac-repurposed', 'ac-original-id'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.acHidden === '1') { el.style.display = el.dataset.acDisplay || ''; delete el.dataset.acHidden; }
  });
  document.getElementById('ac-back-btn').style.display = 'none';
  document.getElementById('ac-confirm-btn').innerText = 'Review';
  AC_REVIEWED = false;
  AC_CONTENT = null;
}

let AC_REVIEWED = false;
// Result of comparing the links' videos at Review. When they look like
// different videos the person must confirm before the creative is added.
let AC_CONTENT = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function submitCreative(e) {
  e.preventDefault();

  const f = acReadForm();

  // First press validates and shows the review. Nothing is sent yet.
  if (!AC_REVIEWED) {
    const err = acValidate(f);
    if (err) { if (err !== 'Fix the highlighted links.') toast(err, 'error'); return; }
    const btn = document.getElementById('ac-confirm-btn');
    const label = btn.innerText;
    btn.disabled = true; btn.innerText = 'Checking links…';
    const linksOk = await acServerCheck(f);
    btn.disabled = false; btn.innerText = label;
    if (!linksOk) return;
    // The check may have rewritten links to their full form.
    Object.assign(f, acReadForm());
    const rv = document.getElementById('ac-review');
    rv.innerHTML = acRenderReview(f) + acContentBlock();
    rv.style.display = 'block';
    ['ac-campaign', 'ac-type', 'ac-repurposed', 'ac-original-id'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') { el.dataset.acDisplay = el.style.display; el.dataset.acHidden = '1'; el.style.display = 'none'; }
    });
    document.querySelectorAll('#addCreativeForm .plat-rows').forEach(el => el.style.display = 'none');
    document.getElementById('ac-back-btn').style.display = '';
    document.getElementById('ac-confirm-btn').innerText =
      (AC_CONTENT && AC_CONTENT.verdict === 'different') ? 'Add anyway' : 'Confirm and add';
    AC_REVIEWED = true;
    return;
  }

  const campaign = f.campaign;
  const type = f.type;
  const source = f.source || null;
  const creator_led = f.type === 'Brand Say' ? !!f.creatorLed : null;
  const ig = f.plats.ig.on ? f.plats.ig.link : '';
  const fb = f.plats.fb.on ? f.plats.fb.link : '';
  const tt = f.plats.tt.on ? f.plats.tt.link : '';
  const description = f.description;
  const repurposed = f.repurposed;
  const originalId = f.originalId;
  
  const btnConfirm = document.getElementById('ac-confirm-btn');
  const btnCancel = document.getElementById('ac-cancel-btn');
  const progressContainer = document.getElementById('ac-progress-container');
  const progressText = document.getElementById('ac-progress-text');
  const progressBar = document.getElementById('ac-progress-bar');

  btnConfirm.disabled = true;
  btnCancel.disabled = true;
  document.getElementById('addCreativeModal').style.pointerEvents = 'none';
  progressContainer.style.display = 'block';

  const setProgress = (pct, msg, color) => {
    progressBar.style.width = pct + '%';
    progressBar.style.background = color || '#0F6E8C';
    progressText.innerText = msg;
  };

  setProgress(10, 'Submitting creative details...', '#0F6E8C');

  try {
    const t1 = setTimeout(() => setProgress(30, 'Downloading video...', '#0F6E8C'), 800);
    const t2 = setTimeout(() => setProgress(55, 'AI is analysing content...', '#0F6E8C'), 4000);
    const t3 = setTimeout(() => setProgress(75, 'Generating hook & segment descriptions...', '#0F6E8C'), 15000);
    const t4 = setTimeout(() => setProgress(90, 'Saving to database...', '#0F6E8C'), 35000);

    const res = await fetch('/api/add-creative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign, type, source, creator_led, ig, fb, tt, repurposed, originalId, description, brand: BRAND_NAME,
        content_confirmed: !!(AC_CONTENT && AC_CONTENT.verdict === 'different') }),
      signal: AbortSignal.timeout(120000)
    });
    clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4);

    const result = await readJson(res);
    if (result.success) {
      // Queued work is confirmed, not watched. A progress bar here would be
      // polling theatre — the analysis takes minutes and the result arrives
      // by email, so say what happened and let the user get on with it.
      showQueuedConfirmation(result);
    } else if (result.contentWarning) {
      progressContainer.style.display = 'none';
      resetSubmitUI(0);
      AC_CONTENT = result.content || { verdict: 'different', warning: result.contentWarning };
      const rv = document.getElementById('ac-review');
      rv.innerHTML = acRenderReview(acReadForm()) + acContentBlock();
      document.getElementById('ac-confirm-btn').innerText = 'Add anyway';
    } else if (result.fieldErrors) {
      // The server's link check disagreed with the browser, most likely a
      // duplicate added by someone else a moment ago. Show it where it belongs.
      progressContainer.style.display = 'none';
      resetSubmitUI(0);
      backToEdit();
      Object.entries(result.fieldErrors).forEach(([k, msg]) => acSetErr(k, msg));
    } else {
      setProgress(100, 'Failed: ' + (result.error || 'Unknown error'), '#C2414B');
      progressBar.style.background = '#C2414B';
      resetSubmitUI(3000);
    }
  } catch (err) {
    console.error(err);
    setProgress(100, 'Network error — could not reach server.', '#C2414B');
    progressBar.style.background = '#C2414B';
    resetSubmitUI(3000);
  }
}

function showQueuedConfirmation(result) {
  const form = document.getElementById('addCreativeForm');
  if (!form) return;

  // The confirmation has to live OUTSIDE the form: hiding the form to show it
  // would hide the confirmation too, leaving an empty modal.
  let box = document.getElementById('ac-queued-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ac-queued-box';
    form.parentNode.insertBefore(box, form.nextSibling);
  }

  const queued = result.queued !== false;
  box.innerHTML = `
    <div class="ac-queued">
      <div class="ac-queued-title">${queued ? 'Queued for analysis' : 'Creative added'}</div>
      <p class="ac-queued-body">${
        queued
          ? 'The video is being downloaded and analysed. Once it is processed the creative will appear in the Creative Hub, and the creative ID will be emailed to you for the ad name.'
          : (result.message || 'Added.')
      }</p>
      ${queued ? '<p class="ac-queued-note">If anything goes wrong you will get an email explaining why, and nothing will be added.</p>' : ''}
      <div class="ac-queued-actions">
        <button type="button" class="btn-outline" onclick="closeAddCreativeModal()">Done</button>
        <button type="button" class="btn-outline primary" onclick="resetAddCreativeForm()">Add another</button>
      </div>
    </div>`;
  box.style.display = 'block';
  form.style.display = 'none';
  document.getElementById('addCreativeModal').style.pointerEvents = 'auto';
  toast(queued ? 'Added to the queue. Analysis has started.' : 'Creative added.');
}

function resetAddCreativeForm() {
  const form = document.getElementById('addCreativeForm');
  const box  = document.getElementById('ac-queued-box');
  if (box)  { box.innerHTML = ''; box.style.display = 'none'; }
  if (form) { form.reset(); form.style.display = ''; }
  const prog = document.getElementById('ac-progress-container');
  if (prog) prog.style.display = 'none';
  const summary = document.getElementById('ac-summary');
  if (summary) { summary.innerHTML = ''; summary.style.display = 'none'; }
  ['ac-confirm-btn', 'ac-cancel-btn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.disabled = false; b.style.display = ''; }
  });
  const orig = document.getElementById('ac-original-id');
  if (orig) orig.style.display = 'none';
  const desc = document.getElementById('ac-description');
  if (desc) desc.value = '';
  const idPrev = document.getElementById('ac-id-preview');
  if (idPrev) idPrev.innerHTML = '';
  const rv = document.getElementById('ac-review');
  if (rv) { rv.innerHTML = ''; rv.style.display = 'none'; }
  AC_PLATS.forEach(p => {
    const t = document.getElementById(`ac-${p.k}-on`); if (t) t.checked = false;
    acSetErr(p.k, '');
  });
  syncPlatFields();
  document.querySelectorAll('#addCreativeForm .plat-rows').forEach(el => el.style.display = '');
  ['ac-campaign', 'ac-type'].forEach(id => {
    const el = document.getElementById(id); if (el) { el.style.display = ''; delete el.dataset.acHidden; }
  });
  const back = document.getElementById('ac-back-btn');
  if (back) back.style.display = 'none';
  const conf = document.getElementById('ac-confirm-btn');
  if (conf) conf.innerText = 'Review';
  AC_REVIEWED = false;
  AC_CONTENT = null;
  document.getElementById('addCreativeModal').style.pointerEvents = 'auto';
}

function resetSubmitUI(delay = 0) {
  setTimeout(() => {
    document.getElementById('ac-confirm-btn').disabled = false;
    document.getElementById('ac-cancel-btn').disabled = false;
    document.getElementById('ac-progress-container').style.display = 'none';
    document.getElementById('ac-progress-bar').style.width = '0%';
    document.getElementById('addCreativeModal').style.pointerEvents = 'auto';
  }, delay);
}

loadBrands().then(loadData);

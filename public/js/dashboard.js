const parseNum = (val) => {
    if (typeof val === 'number') return val;
    if (!val || val === 'Not Found' || val === '-') return 0;
    return parseFloat(String(val).replace(/[^0-9.-]+/g, "")) || 0;
};

let ALL = [];
let ACCOUNT_OVERVIEW = [];
let CAMPAIGNS = [];
let BRAND_NAME = '';
let currentPlatform = 'both', currentSort = 'hook', sortAscending = false, selectedId = null;
let currentPage = 'creatives';
let chartsInit = {};

let AGENCIES = [], CURRENT_USER = '', CURRENT_ROLE = '', CURRENT_IS_INTERNAL = false;

async function loadBrands() {
  try {
    const res = await fetch('/api/brands');
    if (!res.ok) return;
    const { brands, active, agencies, user, isInternal } = await res.json();
    AGENCIES = agencies || [];
    CURRENT_USER = (user && user.displayName) || '';
    CURRENT_ROLE = (user && user.role) || '';
    CURRENT_IS_INTERNAL = !!isInternal;
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
  } catch (e) {
    alert('Could not switch brand: ' + e.message);
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

function setNav(page, element) {
    ['page-creatives', 'page-kpi', 'page-creators'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const selectedPage = document.getElementById(`page-${page}`);
    if (selectedPage) selectedPage.classList.remove('hidden');
    const titles = { 'creatives': 'Creative Hub', 'kpi': 'Campaign KPIs', 'creators': 'Creators' };
    const titleEl = document.getElementById('topbar-title');
    if (titleEl) titleEl.innerText = titles[page] || '';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (element) {
        element.classList.add('active');
    } else {
        const navLink = document.querySelector(`[onclick="setNav('${page}',this)"]`);
        if (navLink) navLink.classList.add('active');
    }
    currentPage = page;
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
      const hasRec  = d.recommendation || (d._meta && d._meta.recommendation) || (d._tt && d._tt.recommendation);
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
  if (of === 'original')       data = data.filter(d => !d.isRepurposed);
  if (of === 'repurposed')     data = data.filter(d => d.isRepurposed);
  if (of === 'has_repurposed') data = data.filter(d => repurposesOf(d.id).length > 0);
  if (vf === 'validated')     data = data.filter(d => d.isValidated);
  if (vf === 'not_validated') data = data.filter(d => !d.isValidated);
  if (searchQ) data = data.filter(d => matchesSearch(d, searchQ));

  return [...data].sort((a,b) => {
    let valA = 0, valB = 0;
    if (currentSort==='hook')  { valA = a.hookRate; valB = b.hookRate; }
    else if (currentSort==='hold')  { valA = a.holdRate; valB = b.holdRate; }
    else if (currentSort==='reach') { valA = a.reach; valB = b.reach; }
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

function hookColor(v) { return v>=40?'#04785C':v>=20?'#8A5A12':'#A32040'; }
function cqrClass(c)  { return {Good:'good-bg',Average:'avg-bg',Poor:'poor-bg',Invalid:'inv-bg'}[c]||'inv-bg'; }
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

function renderKPIs(data) {
  const totalAssets = data.length;
  const bsCount = data.filter(d=>d.type==='Brand Say').length;
  const osCount = data.filter(d=>d.type==='Others Say').length;
  const valCount = data.filter(d=>d.isValidated).length;
  const totalImp = data.reduce((s,d)=>s+(d.impressions||0),0);
  let totalOrgViews = 0;
  data.forEach(d => {
    if (d.igOrganic) totalOrgViews += (d.igOrganic.views||0);
    if (d.fbOrganic) totalOrgViews += (d.fbOrganic.videoViews||0);
    if (d.ttOrganic) totalOrgViews += (d.ttOrganic.views||0);
  });
 const boostedCount = data.filter(d=>d.isBoosted).length;
  const notBoostedCount = data.filter(d=>!d.isBoosted).length;
  const row = document.getElementById('kpi-row');
  if (!row) return;
  row.innerHTML=`
    <div class="kpi"><div class="kpi-label">Total Assets</div><div class="kpi-val">${totalAssets}</div><div class="kpi-sub">${boostedCount} boosted · ${notBoostedCount} not boosted</div></div>
    <div class="kpi"><div class="kpi-label">BS vs OS Split</div><div class="kpi-val">${Math.round(bsCount/(totalAssets||1)*100)}% / ${Math.round(osCount/(totalAssets||1)*100)}%</div><div class="kpi-sub">${bsCount} Brand Say · ${osCount} Others Say</div></div>
    <div class="kpi"><div class="kpi-label">Validated Assets</div><div class="kpi-val" style="color:var(--c-good)">${valCount}</div><div class="kpi-sub">CQR Good or Average</div></div>
    <div class="kpi"><div class="kpi-label">Total Org Views</div><div class="kpi-val" style="color:var(--c-os)">${fmtN(totalOrgViews)}</div><div class="kpi-sub">IG, FB, TT Combined</div></div>
    <div class="kpi"><div class="kpi-label">Total Paid Impr.</div><div class="kpi-val">${fmtN(totalImp)}</div><div class="kpi-sub">${boostedCount} amplified assets</div></div>`;
}

function renderCards(data) {
  const maxHook  = Math.max(...data.map(d=>d.hookRate||0),1);
  const maxHold  = Math.max(...data.map(d=>d.holdRate||0),1);
  const maxReach = Math.max(...data.map(d=>d.reach||0),1);

  document.getElementById('grid-count').textContent = `${data.length} creatives`;
  document.getElementById('card-grid').innerHTML = data.map(d => {
    const hkPct  = Math.round((d.hookRate/maxHook)*100);
    const hdPct  = Math.round((d.holdRate/maxHold)*100);
    const rchPct = Math.round((d.reach/maxReach)*100);
    const isAct  = d.adStatus === 'ACTIVE';
    const isNotBoosted = d.adStatus === 'NOT_BOOSTED';
    const displayCqr = (d.cqr && d.cqr !== 'Invalid') ? d.cqr : d.bestOrgCqr || 'Invalid';

    const platHTML = d.platform === 'both'
      ? `<span style="color:var(--c-meta);font-weight:700;font-size:10px">META</span> <span style="color:var(--c-muted)">&amp;</span> <span style="color:var(--c-tt);font-weight:700;font-size:10px">TT</span>`
      : `<span style="color:${d.platform==='tiktok'?'var(--c-tt)':'var(--c-meta)'};font-weight:700;font-size:10px">${d.platform==='tiktok'?'TT':'META'}</span>`;

    const hlValFormatted = d.holdRate >= 1000 ? (d.holdRate/1000).toFixed(1)+'K' : (d.holdRate||0).toFixed(1);
    const kidCount = repurposesOf(d.id).length;
    const repTag  = d.isRepurposed
      ? `<span class="tag-repurposed">Repurposed</span>`
      : (kidCount ? `<span class="tag-lineage">${kidCount} repurposed</span>` : '');
    const valTag  = d.isValidated  ? `<span class="tag-validated">✓ Validated</span>` : '';
    const durTag  = d.duration     ? `<span class="tag-duration">${d.duration}s</span>` : '';
    const ctTag   = d.contentType  ? `<span class="tag-content-type">${d.contentType}</span>` : '';

    return `<div class="card ${d.id===selectedId?'selected':''}" onclick="selectCard('${d.id}')">
      <div class="card-top">
        <div class="card-plat"><div class="status-dot ${isAct?'status-active-dot':isNotBoosted?'':'status-stopped-dot'}"></div>${platHTML}</div>
        <div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap;justify-content:flex-end">
          <span class="card-type ${d.type==='Brand Say'?'bs-tag':'os-tag'}">${d.type==='Brand Say'?'BS':'OS'}</span>${repTag}
        </div>
      </div>
      <div class="card-name">${d.id}</div>
      <div style="font-size:9px;color:var(--c-muted);margin-top:-6px;margin-bottom:4px;">${d.short !== d.id ? d.short : ''}</div>
      <div class="card-campaign">${d.campaign} · ${d.month}</div>
      <div class="card-tags">${durTag}${ctTag}${valTag}</div>
      <div class="mini-bars">
        <div class="mini-bar-row"><div class="mini-bar-label">Reach</div><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${rchPct}%;background:#000050"></div></div><div class="mini-bar-val">${fmtN(d.reach)}</div></div>
        <div class="mini-bar-row"><div class="mini-bar-label">Hook</div><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${hkPct}%;background:${hookColor(d.hookRate)}"></div></div><div class="mini-bar-val" style="color:${hookColor(d.hookRate)}">${(d.hookRate||0).toFixed(1)}%</div></div>
        <div class="mini-bar-row"><div class="mini-bar-label">Hold</div><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${hdPct}%;background:#000050"></div></div><div class="mini-bar-val">${hlValFormatted}</div></div>
      </div>
    <div class="card-footer"><span class="cqr-badge ${isNotBoosted?'inv-bg':cqrClass(displayCqr)}">${isNotBoosted?'Not Boosted':displayCqr}</span></div>
    </div>`;
  }).join('');
}

let retChart = null, radarChart = null;

function selectCard(id) {
  const item = ALL.find(d=>d.id===id);
  if (item) { document.getElementById('creativeModalOverlay').style.display = 'flex'; renderDetail(item); }
}

function closeCreativeModal(e) {
  if (e && e.target.id === 'creativeModalOverlay') {
    document.getElementById('creativeModalOverlay').style.display = 'none';
    document.getElementById('creativeModalContent').innerHTML = '';
  }
}

function getMetricsHTML(item, titleLabel) {
  if (!item) return '';
  const cqrColorClass = item.cqr === 'Good' ? 'cqr-good' : (item.cqr === 'Average' ? 'cqr-avg' : 'cqr-poor');
  const hlValFormatted = item.holdRate >= 1000 ? (item.holdRate/1000).toFixed(1)+'K' : (item.holdRate||0).toFixed(1);
  const durLabel = item.duration ? `<div style="font-size:10px;color:var(--c-muted);margin-top:3px;">Duration: ${item.duration}s</div>` : '';
  return `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--c-muted);margin-bottom:6px;text-transform:uppercase;">${titleLabel} Paid Stats</div>
      <div class="detail-metrics" style="margin-bottom:6px;">
        <div class="dm"><div class="dm-label">CQR Rating</div><div class="dm-val big-cqr ${cqrColorClass}">${item.cqr||'—'}</div>${durLabel}</div>
        <div class="dm"><div class="dm-label">Spend &amp; Reach</div><div class="dm-val">${fmt(item.spend)}</div><div style="font-size:10px;color:var(--c-muted);margin-top:2px;">Reach: ${fmtN(item.reach)} | Impr: ${fmtN(item.impressions)}</div></div>
        <div class="dm"><div class="dm-label">Hook Rate</div><div class="dm-val" style="color:${hookColor(item.hookRate)}">${(item.hookRate||0).toFixed(1)}%</div><div><span class="kpi-pill ${cqrClass(item.hookQual)}">${item.hookQual||'—'}</span></div></div>
        <div class="dm"><div class="dm-label">Hold Rate</div><div class="dm-val" style="color:#000050">${hlValFormatted}</div><div><span class="kpi-pill ${cqrClass(item.holdQual)}">${item.holdQual||'—'}</span></div></div>
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
    // Only the admin (role='admin') or a client user (not internal WPP/agency
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
    d.duration ? `<span class="brief-tag brief-tag-quiet">${d.duration}s</span>` : '',
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
  return `<button class="lin-row" onclick="selectCard('${x.id}')">
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

  let linkBtns = `<div class="btn-group">`;
  if (d.creativeLink || d.originalUrl) linkBtns += `<button class="view-btn primary" onclick="window.open('${d.creativeLink||d.originalUrl}','_blank')">View Creative ↗</button>`;
  linkBtns += `</div>`;

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
  if (d.duration) metaParts.push(`${d.duration}s`);
  if (d.contentType) metaParts.push(d.contentType);

  document.getElementById('creativeModalContent').innerHTML = `
    <div class="cm-body">
      <div class="detail-header">
        <div>
          <div class="detail-title">${d.short}<span class="card-type ${d.type==='Brand Say'?'bs-tag':'os-tag'}" style="margin-left:6px">${d.type}</span>${valUI}</div>
          <div class="detail-meta">${metaParts.join(' · ')}</div>
          ${creatorHTML}${repText}${linkBtns}
        </div>
        <button class="close-btn" onclick="closeCreativeModal({target:{id:'creativeModalOverlay'}})">×</button>
      </div>

      ${buildLineageHTML(d)}
      ${statsHTML}
      ${buildCreativeBriefHTML(d)}

      <details class="org-details" style="margin-top:12px;">
        <summary class="org-summary">Organic Performance <span style="color:var(--c-muted);font-size:10px;">Click to expand ▼</span></summary>
        <div class="org-content">${buildOrganicHTML(d)}</div>
      </details>

      <div style="margin-top:14px">${recsHTML}</div>

      <div class="charts-row" style="margin-top:14px;">
        <div class="chart-box"><div class="chart-box-title">Retention drop-off</div><div class="chart-container" style="height:160px"><canvas id="retChart"></canvas></div></div>
        <div class="chart-box"><div class="chart-box-title">Performance radar</div><div class="chart-container" style="height:160px"><canvas id="radarChart"></canvas></div></div>
      </div>
    </div>`;

  if (retChart)   retChart.destroy();
  if (radarChart) radarChart.destroy();

  const gc = '#DCDCE6';   // gridlines, line-200
  const tc = '#6B6B90';   // axis labels, ink-400
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
  if (!agency) return alert("Please select an agency.");
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
  } catch(err) {
    alert("Failed to update: " + err.message);
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
}

function closeAddCreativeModal() {
  document.getElementById('addCreativeModal').style.display = 'none';
  document.getElementById('addCreativeForm').reset();
  toggleCreativeFields();
}

function toggleCreativeFields() {
  const type = document.getElementById('ac-type').value;
  const repurposedSelect = document.getElementById('ac-repurposed');
  const originalIdSelect = document.getElementById('ac-original-id');
  if (type === 'Brand Say') {
    repurposedSelect.style.display = 'block';
    repurposedSelect.required = true;
  } else {
    repurposedSelect.style.display = 'none';
    repurposedSelect.required = false;
    repurposedSelect.value = "";
    originalIdSelect.style.display = 'none';
    originalIdSelect.required = false;
    originalIdSelect.value = "";
  }
}

function toggleOriginalIdField() {
  const repurposed = document.getElementById('ac-repurposed').value;
  const originalIdSelect = document.getElementById('ac-original-id');
  if (repurposed === 'Yes') {
    originalIdSelect.style.display = 'block';
    originalIdSelect.required = true;
  } else {
    originalIdSelect.style.display = 'none';
    originalIdSelect.required = false;
    originalIdSelect.value = "";
  }
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
    ${a.duration ? `<div class="organic-stat-row"><span class="organic-stat-label">Duration</span><span class="organic-stat-val">${a.duration}s</span></div>` : ''}
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
    alert('Analysis failed: ' + (lines.pop() || err.message).trim());
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

// Mirrors the server's id rule so the field shows what will actually be
// created. The server still decides, and appends a stamp if the id is taken.
const DESCRIPTION_MAX = 20;
function slugForId(s) {
  return String(s || '').toUpperCase().replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]+/g, '').slice(0, DESCRIPTION_MAX);
}

function previewCreativeId() {
  const el = document.getElementById('ac-id-preview');
  if (!el) return;
  const type = (document.getElementById('ac-type') || {}).value;
  const desc = (document.getElementById('ac-description') || {}).value;
  const slug = slugForId(desc);
  if (!slug) { el.innerHTML = 'No description: the ID will be auto-generated.'; return; }
  const code = type === 'Others Say' ? 'OS' : 'BS';
  const brand = (typeof BRAND_NAME !== 'undefined' && BRAND_NAME ? BRAND_NAME : 'BRAND').toUpperCase();
  el.innerHTML = `ID will be <b>${brand}_${code}_${slug}</b>`;
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
    date: document.getElementById('ac-date').value,
    repurposed: document.getElementById('ac-repurposed').value || 'No',
    originalId: document.getElementById('ac-original-id').value || '',
    plats,
  };
}

// Returns an error string, or null when the form is good to review.
function acValidate(f) {
  if (!f.date) return 'Select a date.';
  if (!f.campaign) return 'Select a campaign.';
  if (!f.type) return 'Select a category.';
  const anyOn = AC_PLATS.some(p => f.plats[p.k].on);
  if (!anyOn) return 'Turn on at least one platform. A creative with no links cannot have stats.';
  for (const p of AC_PLATS) {
    const v = f.plats[p.k];
    if (v.on && !v.link) return `${p.label} is on but has no link. Add the link or turn it off.`;
    if (v.on && !/^https?:\/\//i.test(v.link)) return `${p.label} link should start with http:// or https://`;
  }
  return null;
}

function acRenderReview(f) {
  const line = (k, v, off) => `<div class="rv-line"><span class="rv-k">${k}</span><span class="rv-v ${off ? 'rv-off' : ''}">${escapeHtml(v)}</span></div>`;
  const offCount = AC_PLATS.filter(p => !f.plats[p.k].on).length;
  return `<div class="rv">
    <h4>Check before submitting</h4>
    ${line('Date', f.date)}
    ${f.description ? line('Description', f.description) : ''}
    ${line('Campaign', f.campaign)}
    ${line('Category', f.type)}
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
  ['ac-date', 'ac-campaign', 'ac-type', 'ac-repurposed', 'ac-original-id'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.acHidden === '1') { el.style.display = el.dataset.acDisplay || ''; delete el.dataset.acHidden; }
  });
  document.getElementById('ac-back-btn').style.display = 'none';
  document.getElementById('ac-confirm-btn').innerText = 'Review';
  AC_REVIEWED = false;
}

let AC_REVIEWED = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function submitCreative(e) {
  e.preventDefault();

  const f = acReadForm();

  // First press validates and shows the review. Nothing is sent yet.
  if (!AC_REVIEWED) {
    const err = acValidate(f);
    if (err) { alert(err); return; }
    const rv = document.getElementById('ac-review');
    rv.innerHTML = acRenderReview(f);
    rv.style.display = 'block';
    ['ac-date', 'ac-campaign', 'ac-type', 'ac-repurposed', 'ac-original-id'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') { el.dataset.acDisplay = el.style.display; el.dataset.acHidden = '1'; el.style.display = 'none'; }
    });
    document.querySelectorAll('#addCreativeForm .plat-rows').forEach(el => el.style.display = 'none');
    document.getElementById('ac-back-btn').style.display = '';
    document.getElementById('ac-confirm-btn').innerText = 'Confirm and add';
    AC_REVIEWED = true;
    return;
  }

  const campaign = f.campaign;
  const type = f.type;
  const date = f.date;
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
    progressBar.style.background = color || '#000050';
    progressText.innerText = msg;
  };

  setProgress(10, 'Submitting creative details...', '#000050');

  try {
    const t1 = setTimeout(() => setProgress(30, 'Downloading video...', '#000050'), 800);
    const t2 = setTimeout(() => setProgress(55, 'AI is analysing content...', '#000050'), 4000);
    const t3 = setTimeout(() => setProgress(75, 'Generating hook & segment descriptions...', '#000050'), 15000);
    const t4 = setTimeout(() => setProgress(90, 'Saving to database...', '#000050'), 35000);

    const res = await fetch('/api/add-creative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign, type, date, ig, fb, tt, repurposed, originalId, description, brand: BRAND_NAME }),
      signal: AbortSignal.timeout(120000)
    });
    clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4);

    const result = await readJson(res);
    if (result.success) {
      // Queued work is confirmed, not watched. A progress bar here would be
      // polling theatre — the analysis takes minutes and the result arrives
      // by email, so say what happened and let the user get on with it.
      showQueuedConfirmation(result);
    } else {
      setProgress(100, 'Failed: ' + (result.error || 'Unknown error'), '#A32040');
      progressBar.style.background = '#A32040';
      resetSubmitUI(3000);
    }
  } catch (err) {
    console.error(err);
    setProgress(100, 'Network error — could not reach server.', '#A32040');
    progressBar.style.background = '#A32040';
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
  box.innerHTML = queued ? `
    <div class="ac-queued">
      <div class="ac-queued-head">
        <span class="ac-queued-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
          </svg>
        </span>
        <div>
          <div class="ac-queued-title">Added to the queue</div>
          <p class="ac-queued-body">
            The video is being downloaded and analysed. This usually takes a few minutes.
          </p>
        </div>
      </div>

      <ul class="ac-queued-steps">
        <li>You will get an email with the creative ID once it is done</li>
        <li>The creative appears in the Creative Hub at the same time</li>
        <li>If it fails you will get an email explaining why, and nothing is added</li>
      </ul>

      <p class="ac-queued-note">You can close this and keep working.</p>

      <div class="ac-queued-actions">
        <button type="button" class="btn-outline" onclick="closeAddCreativeModal()">Close</button>
        <button type="button" class="btn-outline primary" onclick="resetAddCreativeForm()">Add another</button>
      </div>
    </div>` : `
    <div class="ac-queued">
      <div class="ac-queued-title">Creative added</div>
      <p class="ac-queued-body">${result.message || 'Added.'}</p>
      <div class="ac-queued-actions">
        <button type="button" class="btn-outline" onclick="closeAddCreativeModal()">Close</button>
        <button type="button" class="btn-outline primary" onclick="resetAddCreativeForm()">Add another</button>
      </div>
    </div>`;
  box.style.display = 'block';
  box.innerHTML = `
    <div class="brief-hook" style="margin-bottom:12px">
      <span class="brief-hook-label">Creative ID</span>
      <div class="brief-hook-text" style="font-family:var(--font-mono);font-size:13px">${result.creativeId}</div>
      <div style="font:400 12px/16px var(--font-ui);color:var(--ink-500);margin-top:6px">
        Add this after the pipe in the ad name when the asset is boosted.
      </div>
    </div>
    ${a.duration ? `<div class="organic-stat-row"><span class="organic-stat-label">Duration</span><span class="organic-stat-val">${a.duration}s</span></div>` : ''}
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
  });
  syncPlatFields();
  document.querySelectorAll('#addCreativeForm .plat-rows').forEach(el => el.style.display = '');
  ['ac-date', 'ac-campaign', 'ac-type'].forEach(id => {
    const el = document.getElementById(id); if (el) { el.style.display = ''; delete el.dataset.acHidden; }
  });
  const back = document.getElementById('ac-back-btn');
  if (back) back.style.display = 'none';
  const conf = document.getElementById('ac-confirm-btn');
  if (conf) conf.innerText = 'Review';
  AC_REVIEWED = false;
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

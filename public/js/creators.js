/* =====================================================================
   creators.js — Creators and Community

   Reads the same global ALL array the other tabs use. Nothing new is
   fetched, so no backend change is needed.

   Design notes:
   - Two views of Others Say, never mixed: Creators (content the brand
     commissioned) and Community (posted by the public). Every count,
     tile and pattern on the page is about the view that is open.
   - Built for hundreds of profiles. Patterns are aggregated, so they
     stay one chart however many profiles there are. The profiles
     themselves are cards, filtered and searched, and drawn a page at a
     time with "Show more", so a long roster never renders at once.
   - No league table. Profiles sort by most recent, most posts or name,
     never best to worst, and a card only points out what a profile is
     good at. The full rating mix sits on the card, one vote per post.
   - No money. Nothing here shows spend, and paid appears only as the
     rating a post earned.
   - Ratings are organic and counted per post: a post's rating is the
     best one it earned on any platform, the same rule as everywhere else.

   Uses the Media Summary helpers in kpi-dashboard.js (msCard, msTile,
   msCqrBar, msEsc, msMonthKey, MS_C) so both pages read as one system.
   ===================================================================== */

const CR_PAGE = 24;          // profiles drawn per "Show more"
const CR_POSTS_PAGE = 6;     // posts drawn per "Show more" in a profile panel
const CR_MIN_PATTERN = 3;    // rated posts a group needs before its bar shows
const CR_TYPES_SHOWN = 6;    // content types listed before the rest fold into Other

const CR_VIEWS = {
  creators:  { label: 'Creators',  one: 'creator',        many: 'creators',  title: 'Creator',
               test: d => d.type === 'Others Say' && d.source !== 'community' },
  community: { label: 'Community', one: 'community page', many: 'community pages', title: 'Community',
               test: d => d.type === 'Others Say' && d.source === 'community' },
};

const CR_PLATFORMS = [
  { code: 'ig', label: 'Instagram', key: 'igOrganic', link: 'igLink' },
  { code: 'tt', label: 'TikTok',    key: 'ttOrganic', link: 'ttLink' },
  { code: 'fb', label: 'Facebook',  key: 'fbOrganic', link: 'fbLink' },
];

const CR = {
  view: 'creators', search: '', campaign: 'all', month: 'all',
  platform: 'all', sort: 'recent', shown: CR_PAGE,
};

const crGrade = (d) => typeof bestOrganicGrade === 'function' ? bestOrganicGrade(d) : null;
const crViews = (d) => CR_PLATFORMS.reduce((s, p) => {
  const o = d[p.key];
  return s + (o ? Number(o.views || o.videoViews || 0) : 0);
}, 0);
const crOn = (d, p) => !!(d[p.key] || d[p.link]);
const crPlural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const crMix = (posts) => {
  const t = { Good: 0, Average: 0, Poor: 0, none: 0 };
  posts.forEach(d => { const g = crGrade(d); if (g && t[g] !== undefined) t[g]++; else t.none++; });
  return t;
};
// A name as a JS string inside an HTML attribute: JSON first, then HTML.
const crArg = (s) => msEsc(JSON.stringify(String(s)));
const crRated = (mix) => mix.Good + mix.Average + mix.Poor;
const crGoodShare = (mix) => crRated(mix) ? Math.round(mix.Good / crRated(mix) * 100) : null;

// ---------------------------------------------------------------------
//  Data
// ---------------------------------------------------------------------

/** Every post in scope: the open view, campaign, month and platform. */
function crPosts(view) {
  const v = CR_VIEWS[view || CR.view];
  return (typeof ALL !== 'undefined' ? ALL : [])
    .filter(v.test)
    .filter(d => CR.campaign === 'all' || d.campaign === CR.campaign)
    .filter(d => CR.month === 'all' || d.month === CR.month)
    .filter(d => CR.platform === 'all' || crOn(d, CR_PLATFORMS.find(p => p.code === CR.platform)));
}

/** The same scope applied to Brand Say, for the comparison. */
function crBrandPosts() {
  return (typeof ALL !== 'undefined' ? ALL : [])
    .filter(d => d.type === 'Brand Say')
    .filter(d => CR.campaign === 'all' || d.campaign === CR.campaign)
    .filter(d => CR.month === 'all' || d.month === CR.month)
    .filter(d => CR.platform === 'all' || crOn(d, CR_PLATFORMS.find(p => p.code === CR.platform)));
}

/** One profile per handle, built from the posts in scope. */
function crProfiles(posts) {
  const map = {};
  posts.forEach(d => {
    const info = typeof extractCreatorInfo === 'function'
      ? extractCreatorInfo(d.creatorProfile, d.ttLink) : null;
    const name = (info && info.username) || d.creatorProfile;
    if (!name) return;
    (map[name] ||= { name, profileUrl: (info && info.profileUrl) || null, posts: [] }).posts.push(d);
  });

  const RANK = { Good: 0, Average: 1, Poor: 2 };
  return Object.values(map).map(p => {
    p.posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    p.mix = crMix(p.posts);
    p.views = p.posts.reduce((s, d) => s + crViews(d), 0);
    p.latest = p.posts[0].date || '';
    p.platforms = CR_PLATFORMS.filter(pl => p.posts.some(d => crOn(d, pl)));

    // Strongest platform: the one with the best share of Good among its
    // rated posts. Only said when there is a choice, a real lead and at
    // least two rated posts on each platform compared, so one lucky post
    // never decides it.
    if (p.platforms.length > 1) {
      const by = p.platforms.map(pl => {
        const g = p.posts.map(d => (d[pl.key] || {}).cqr).filter(c => RANK[c] !== undefined);
        return { pl, n: g.length, share: g.length ? g.filter(c => c === 'Good').length / g.length : 0 };
      }).filter(x => x.n >= 2).sort((a, b) => b.share - a.share);
      if (by.length > 1 && by[0].share > by[1].share && by[0].share > 0) p.strongest = by[0].pl.label;
    }

    // Best post: highest rating, then most views. Only a Good or Average
    // post is held up as an example.
    const best = [...p.posts]
      .filter(d => crGrade(d) === 'Good' || crGrade(d) === 'Average')
      .sort((a, b) => (RANK[crGrade(a)] - RANK[crGrade(b)]) || (crViews(b) - crViews(a)))[0];
    p.best = best || null;
    p.thumb = (best || p.posts.find(d => d.thumbnail) || {}).thumbnail || null;
    return p;
  });
}

function crSorted(list) {
  const q = CR.search.trim().toLowerCase();
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
  const by = {
    recent: (a, b) => String(b.latest).localeCompare(String(a.latest)) || a.name.localeCompare(b.name),
    posts:  (a, b) => b.posts.length - a.posts.length || a.name.localeCompare(b.name),
    name:   (a, b) => a.name.replace(/^@/, '').localeCompare(b.name.replace(/^@/, '')),
  }[CR.sort];
  return list.sort(by);
}

// ---------------------------------------------------------------------
//  State changes
// ---------------------------------------------------------------------
function setCreatorView(v) {
  if (v === CR.view) return;
  CR.view = v; CR.search = ''; CR.shown = CR_PAGE;
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduced) document.startViewTransition(renderCreatorTab);
  else renderCreatorTab();
}

// The highlight behind Creators | Community slides from where it was.
let crPillAt = null;
function crPlacePill() {
  const pill = document.getElementById('cr-view-pill');
  const on = document.querySelector('.cr-view.on');
  if (!pill || !on) return;
  const to = { left: on.offsetLeft, width: on.offsetWidth };
  pill.style.transition = 'none';
  const from = crPillAt || to;
  pill.style.left = from.left + 'px'; pill.style.width = from.width + 'px';
  pill.offsetHeight;
  pill.style.transition = '';
  pill.style.left = to.left + 'px'; pill.style.width = to.width + 'px';
  crPillAt = to;
}
function setCreatorFilter(key, v) { CR[key] = v; CR.shown = CR_PAGE; renderCreatorTab(); }
function setCreatorSort(v) { CR.sort = v; CR.shown = CR_PAGE; crRenderRoster(); }
function showMoreCreators() { CR.shown += CR_PAGE; crRenderRoster(); }

// Search redraws only the roster, so the input keeps focus and the
// patterns above do not flicker on every keystroke.
let crSearchTimer = null;
function setCreatorSearch(v) {
  CR.search = v; CR.shown = CR_PAGE;
  clearTimeout(crSearchTimer);
  crSearchTimer = setTimeout(crRenderRoster, 120);
}

// ---------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------
function renderCreatorTab() {
  const page = document.getElementById('page-creators');
  if (!page) return;
  const all = typeof ALL !== 'undefined' ? ALL : [];
  const os = all.filter(d => d.type === 'Others Say');
  if (!os.length) {
    page.innerHTML = `<div class="content"><div class="organic-empty">
      No creator or community content for ${typeof BRAND_NAME !== 'undefined' ? msEsc(BRAND_NAME) : 'this brand'} yet.
      It appears here once Others Say content is added.</div></div>`;
    return;
  }

  const v = CR_VIEWS[CR.view];
  const counts = Object.fromEntries(Object.keys(CR_VIEWS).map(k =>
    [k, crProfiles(all.filter(CR_VIEWS[k].test)).length]));

  // Options from everything Others Say, so a filter never strands itself.
  const campaigns = [...new Set(os.map(d => d.campaign).filter(Boolean))].sort();
  const months = [...new Set(os.map(d => d.month).filter(m => m && m !== 'Unknown'))]
    .sort((a, b) => msMonthKey(b) - msMonthKey(a));
  const sel = (key, opts) => `
    <select class="kfi-select" onchange="setCreatorFilter('${key}', this.value)">
      ${opts.map(([val, t]) => `<option value="${msEsc(val)}"${CR[key] === val ? ' selected' : ''}>${msEsc(t)}</option>`).join('')}
    </select>`;

  page.innerHTML = `
  <div class="content">
    <div class="cr-views" role="tablist">
      <span class="cr-view-pill" id="cr-view-pill" aria-hidden="true"></span>
      ${Object.entries(CR_VIEWS).map(([k, x]) => `
        <button role="tab" aria-selected="${CR.view === k}" class="cr-view ${CR.view === k ? 'on' : ''}"
          onclick="setCreatorView('${k}')">${x.label}<span class="cr-view-n">${counts[k]}</span></button>`).join('')}
    </div>

    <div class="cr-toolbar">
      ${sel('campaign', [['all', 'All campaigns'], ...campaigns.map(c => [c, c])])}
      ${sel('month', [['all', 'All months'], ...months.map(m => [m, m])])}
      ${sel('platform', [['all', 'All platforms'], ...CR_PLATFORMS.map(p => [p.code, p.label])])}
    </div>

    <div id="cr-summary"></div>

    <div class="ms-sec-h cr-roster-h">${v.label}</div>
    <div class="cr-toolbar">
      <input id="cr-search" class="search-input" placeholder="Search ${v.many}…"
             value="${msEsc(CR.search)}" oninput="setCreatorSearch(this.value)">
      <select class="kfi-select" onchange="setCreatorSort(this.value)">
        ${[['recent', 'Most recent'], ['posts', 'Most posts'], ['name', 'A to Z']]
          .map(([val, t]) => `<option value="${val}"${CR.sort === val ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <span class="cr-count" id="cr-count"></span>
    </div>
    <div id="cr-roster"></div>
  </div>`;

  if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn(page);
  crPlacePill();
  crRenderSummary();
  crRenderRoster();
}

/** Tiles and patterns: aggregates, so they stay one screen at any scale. */
function crRenderSummary() {
  const el = document.getElementById('cr-summary');
  if (!el) return;
  const v = CR_VIEWS[CR.view];
  const posts = crPosts();
  const profiles = crProfiles(posts);
  if (!posts.length) {
    el.innerHTML = `<div class="ms-card"><div class="ms-bar-empty">
      No ${v.label.toLowerCase()} content matches this selection. Widen a filter above.</div></div>`;
    return;
  }

  const mix = crMix(posts);
  const views = posts.reduce((s, d) => s + crViews(d), 0);
  const scopeAll = (typeof ALL !== 'undefined' ? ALL : [])
    .filter(d => CR.campaign === 'all' || d.campaign === CR.campaign)
    .filter(d => CR.month === 'all' || d.month === CR.month);
  const allViews = scopeAll.reduce((s, d) => s + crViews(d), 0);
  const repeat = profiles.filter(p => p.posts.length > 1).length;

  const tiles =
    msTile(v.label, String(profiles.length),
      repeat ? `${repeat} with more than one post` : 'one post each so far') +
    msTile('Posts', String(posts.length),
      `${(posts.length / Math.max(profiles.length, 1)).toFixed(1)} per ${v.one}`) +
    msTile('Share of organic views', `${msPct(views, allViews)}%`, `${fmtN(views)} views`) +
    msTile('Rated Good', crGoodShare(mix) === null ? '—' : `${crGoodShare(mix)}%`,
      `of ${crPlural(crRated(mix), 'rated post')}`);

  // Creators, Community and Brand Say side by side, in the same scope.
  const compare = [
    { label: 'Creators', posts: crPosts('creators') },
    { label: 'Community', posts: crPosts('community') },
    { label: 'Brand Say', posts: crBrandPosts() },
  ].filter(r => r.posts.length);
  const compareCard = compare.length > 1 ? msCard('Against the rest of the content', `
    <table class="ms-table ms-table-cut">
      <tbody>${compare.map(r => `
        <tr${r.label === v.label ? ' class="cr-row-on"' : ''}>
          <td class="ms-cut-k">${r.label}<div class="ms-cut-n">${crPlural(r.posts.length, 'post')}</div></td>
          <td class="ms-mixcell">${msCqrBar(crMix(r.posts), r.posts.length)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`, 'organic rating, one vote per post') : '';

  const before = typeof msMotionSnapshot === 'function' ? msMotionSnapshot(el) : null;
  el.innerHTML = `
    <div class="ms-tiles cols-4">${tiles}</div>
    ${crPatterns(posts, v, compareCard)}`;
  if (typeof msMotionPlay === 'function') msMotionPlay(el, before);
}

/** What works: the rating mix by length, platform and content type. */
function crPatterns(posts, v, lead) {
  const cut = (title, groups, ordered) => {
    let rows = groups.map(g => ({ ...g, mix: crMix(g.items) }))
      .filter(g => crRated(g.mix) >= CR_MIN_PATTERN);
    if (!ordered) rows.sort((a, b) => b.items.length - a.items.length);
    if (rows.length < 2) return '';
    return msCard(title, `
      <table class="ms-table ms-table-cut">
        <tbody>${rows.map(r => `
          <tr>
            <td class="ms-cut-k">${msEsc(r.label)}<div class="ms-cut-n">${crPlural(r.items.length, 'post')}</div></td>
            <td class="ms-mixcell">${msCqrBar(r.mix, r.items.length)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  };

  const bands = [
    { label: 'Under 15s', test: s => s > 0 && s < 15 },
    { label: '15 to 30s', test: s => s >= 15 && s < 30 },
    { label: '30 to 60s', test: s => s >= 30 && s < 60 },
    { label: '60s and over', test: s => s >= 60 },
  ];

  // Per platform the post's own rating there, not its best anywhere.
  const platGroups = CR_PLATFORMS.map(p => {
    const items = posts.filter(d => d[p.key]).map(d => ({ ...d, igOrganic: null, ttOrganic: null, fbOrganic: null, [p.key]: d[p.key], bestOrgCqr: null }));
    return { label: p.label, items };
  }).filter(g => g.items.length);

  // Content types grow with the roster, so the long tail folds into one row.
  const types = {};
  posts.forEach(d => { const t = d.contentType || 'Not classified'; (types[t] ||= []).push(d); });
  const typeRows = Object.entries(types).sort((a, b) => b[1].length - a[1].length);
  const typeGroups = typeRows.slice(0, CR_TYPES_SHOWN).map(([label, items]) => ({ label, items }));
  const rest = typeRows.slice(CR_TYPES_SHOWN).flatMap(([, items]) => items);
  if (rest.length) typeGroups.push({ label: 'Everything else', items: rest });

  const cards = [
    cut('Length', bands.map(b => ({ label: b.label, items: posts.filter(d => b.test(Number(d.duration) || 0)) })), true),
    cut('Platform', platGroups),
    cut('Content type', typeGroups, true),
  ].filter(Boolean);
  if (lead) cards.unshift(lead);
  if (!cards.length) return '';

  return `
    <div class="ms-sub-h">How ${v.title.toLowerCase()} content is doing</div>
    <div class="ms-note">Organic rating against the rest of the content, then by the shape of the post across
      every ${v.one}. Lessons for the next brief.</div>
    <div class="ms-grid cols-${Math.min(cards.length, 2)}">${cards.join('')}</div>`;
}

/** The profile cards, a page at a time. */
function crRenderRoster() {
  const el = document.getElementById('cr-roster');
  if (!el) return;
  const v = CR_VIEWS[CR.view];
  const all = crProfiles(crPosts());
  const list = crSorted(all);
  const shown = list.slice(0, CR.shown);

  const count = document.getElementById('cr-count');
  if (count) count.textContent = list.length === all.length
    ? crPlural(all.length, v.one, v.many)
    : `${list.length} of ${crPlural(all.length, v.one, v.many)}`;

  if (!list.length) {
    el.innerHTML = `<div class="ms-card"><div class="ms-bar-empty">${
      CR.search ? `No ${v.one} matches “${msEsc(CR.search)}”.` : `No ${v.many} in this selection.`}</div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="cr-cards">${shown.map(crCard).join('')}</div>
    ${list.length > shown.length ? `
      <div class="cr-more">
        <button class="cr-more-btn" onclick="showMoreCreators()">Show more</button>
        <span>Showing ${shown.length} of ${list.length}</span>
      </div>` : ''}`;
}

function crCard(p) {
  const n = p.posts.length;
  const initial = msEsc(p.name.replace(/^@/, '').charAt(0).toUpperCase() || '?');
  const highlight = [
    p.strongest ? `Strongest on ${p.strongest}` : '',
    p.best && crGrade(p.best) === 'Good' ? 'Best post rated Good' : '',
  ].filter(Boolean)[0] || '';
  return `
    <button class="cr-card" data-press onclick="openCreatorDetail(${crArg(p.name)}, this)">
      <div class="cr-card-top">
        <div class="cr-thumb">${initial}${p.thumb
          ? `<img src="${msEsc(p.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="cr-card-id">
          <div class="cr-card-name">${msEsc(p.name)}</div>
          <div class="cr-card-meta">${crPlural(n, 'post')} · ${p.platforms.map(pl => pl.label).join(', ') || 'No platform'}</div>
        </div>
      </div>
      ${crRated(p.mix) ? msCqrBar(p.mix, n) : `<div class="ms-bar-empty">Not rated yet</div>`}
      <div class="cr-card-foot">${
        n === 1 ? '<span class="cr-tag">1 post, not a pattern yet</span>'
          : highlight ? `<span class="cr-good">${highlight}</span>` : ''}
        ${p.latest ? `<span class="cr-date">Latest ${msEsc(p.latest)}</span>` : ''}
      </div>
    </button>`;
}

// ---------------------------------------------------------------------
//  Profile panel
// ---------------------------------------------------------------------
let crPanelShown = CR_POSTS_PAGE;

function openCreatorDetail(name, trigger) {
  crPanelShown = CR_POSTS_PAGE;
  // The arrow keys step through Creative Hub creatives while its panel is
  // open; this panel shares the same overlay, so switch that off.
  if (typeof panelFor !== 'undefined') panelFor = null;
  crRenderDetail(name);
  // Through the shared opener in dashboard.js, so this panel arrives the
  // same way the Creative Hub's does and picks up the same spring state.
  if (typeof showCreativePanel === 'function') showCreativePanel(trigger);
  else document.getElementById('creativeModalOverlay').style.display = 'flex';
}

function crShowMorePosts(name) {
  crPanelShown += CR_POSTS_PAGE;
  crRenderDetail(name);
}

function crRenderDetail(name) {
  const p = crProfiles(crPosts()).find(x => x.name === name);
  if (!p) return;
  const v = CR_VIEWS[CR.view];
  const share = crGoodShare(p.mix);

  const postBlocks = p.posts.slice(0, crPanelShown).map(a => {
    const platCols = CR_PLATFORMS.map(pl => {
      const o = a[pl.key];
      if (!o) return a[pl.link] ? `
        <div class="cr-plat-col cr-plat-empty">
          <div class="cr-plat-name">${pl.label}</div>
          <div class="organic-empty">No numbers yet</div>
        </div>` : '';
      const row = (label, val) => `
        <div class="organic-stat-row"><span class="organic-stat-label">${label}</span>
        <span class="organic-stat-val">${val}</span></div>`;
      return `
        <div class="cr-plat-col">
          <div class="cr-plat-name">${pl.label}</div>
          ${row('Views', fmtN(o.views || o.videoViews || 0))}
          ${row('Reach', o.reach ? fmtN(o.reach) : '—')}
          ${row(pl.code === 'fb' ? 'Reactions' : 'Likes', fmtN(o.likes || o.reactions || 0))}
          ${row('Comments', fmtN(o.comments || 0))}
          ${row('Shares', fmtN(o.shares || 0))}
          ${row('Avg watch', o.avgWatchTime ? o.avgWatchTime.toFixed(1) + 's' : '—')}
          <div style="margin-top:8px">
            <span class="kpi-pill ${cqrClass(o.cqr)}">${o.cqr || 'Not rated'}</span>
          </div>
        </div>`;
    }).join('');

    // Paid only as the rating it earned, never what was behind it.
    const paid = isGrade(a.cqr) ? `
      <div class="cr-paid-strip"><span class="cr-paid-label">Paid rating</span>
        <span class="kpi-pill ${cqrClass(a.cqr)}">${a.cqr}</span></div>` : '';

    return `
      <div class="cr-asset">
        <div class="cr-asset-head">
          <div>
            <div class="cr-asset-title">${msEsc(a.short || a.id)}</div>
            <div class="cr-asset-meta">${[a.date, a.campaign, a.contentType, a.duration ? Math.round(a.duration) + 's' : null]
              .filter(Boolean).map(msEsc).join(' · ')}</div>
          </div>
          ${a.creativeLink ? `<a class="view-btn" href="${msEsc(a.creativeLink)}" target="_blank" rel="noopener">View ↗</a>` : ''}
        </div>
        ${paid}
        <div class="cr-plat-grid">${platCols}</div>
        ${a.contentHook ? `<div class="cr-hook"><span class="brief-hook-label">Hook</span> ${msEsc(a.contentHook)}</div>` : ''}
      </div>`;
  }).join('');

  const more = p.posts.length > crPanelShown ? `
    <div class="cr-more">
      <button class="cr-more-btn" onclick="crShowMorePosts(${crArg(p.name)})">Show more posts</button>
      <span>Showing ${crPanelShown} of ${p.posts.length}</span>
    </div>` : '';

  document.getElementById('creativeModalContent').innerHTML = `
    <div class="cm-body">
      <div class="detail-header">
        <div>
          <div class="detail-title">${p.profileUrl
            ? `<a href="${msEsc(p.profileUrl)}" target="_blank" rel="noopener" class="creator-link">${msEsc(p.name)}</a>`
            : msEsc(p.name)}</div>
          <div class="detail-meta">${v.title} · ${crPlural(p.posts.length, 'post')} · ${p.platforms.map(pl => pl.label).join(', ')}</div>
        </div>
        <button class="close-btn" onclick="closeCreativeModal({target:{id:'creativeModalOverlay'}})">×</button>
      </div>
      <div class="detail-metrics" style="margin-bottom:16px">
        <div class="dm"><div class="dm-label">Organic views</div><div class="dm-val">${fmtN(p.views)}</div>
          <div class="cr-dm-sub">${fmtN(Math.round(p.views / p.posts.length))} per post</div></div>
        <div class="dm"><div class="dm-label">Rated Good</div><div class="dm-val">${share === null ? '—' : share + '%'}</div>
          <div class="cr-dm-sub">of ${crPlural(crRated(p.mix), 'rated post')}</div></div>
        <div class="dm"><div class="dm-label">Strongest on</div><div class="dm-val">${p.strongest || '—'}</div>
          <div class="cr-dm-sub">${p.strongest ? 'best share of Good' : p.platforms.length > 1 ? 'no clear lead yet' : 'one platform'}</div></div>
      </div>
      ${crRated(p.mix) ? `<div style="margin-bottom:20px">${msCqrBar(p.mix, p.posts.length)}</div>` : ''}
      ${postBlocks}
      ${more}
    </div>`;

  // The hook line is a panel-only field the list leaves out. Fetch it for
  // the posts on show and draw again once, if any were missing.
  const shown = p.posts.slice(0, crPanelShown).filter(a => !a._detail).map(a => a.id);
  if (shown.length && typeof ensureDetails === 'function') {
    ensureDetails(shown).then(() => {
      // Only redraw if the details actually landed. Redrawing regardless
      // asked again for the same posts, forever, and froze the page.
      if (shown.some(id => !(p.posts.find(a => a.id === id) || {})._detail)) return;
      const open = document.querySelector('#creativeModalContent .detail-title');
      if (open && open.textContent.trim() === p.name) crRenderDetail(name);
    }).catch(err => console.error('[creators] details failed', err));
  }
}

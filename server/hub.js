// =====================================================================
//  server/hub.js — the Creative Hub's filters, search, sort and tiles
//
//  These used to run in the browser over the brand's whole creative
//  list, which meant downloading and holding that list before the first
//  card could show. They run here now, over the payload creatives.js
//  already builds and caches, and the browser asks for one page at a
//  time (docs/scaling.md).
//
//  The rules are the ones dashboard.js had, moved rather than rewritten,
//  so a filter, a search or a tile reads the same as it did before.
// =====================================================================

const GRADES = new Set(['Good', 'Average', 'Poor']);
const isGrade = (v) => GRADES.has(v);
const RANK = { Good: 0, Average: 1, Poor: 2 };
const ORG_KEYS = ['igOrganic', 'fbOrganic', 'ttOrganic'];

// ---------------------------------------------------------------------
//  Platform view
//
//  With Meta or TikTok picked, a creative that ran on both shows that
//  platform's numbers, and one that never ran there drops out.
// ---------------------------------------------------------------------
const PAID_FIELDS = ['reach', 'hookRate', 'holdRate', 'spend', 'impressions', 'cqr', 'hookQual',
                     'holdQual', 'vtr', 'watchTime', 'adStatus', 'ret'];

function platformView(list, platform) {
  if (platform !== 'meta' && platform !== 'tiktok') return list;
  const key = platform === 'meta' ? '_meta' : '_tt';
  return list.filter(d => d.platform === platform || d.platform === 'both').map(d => {
    if (d.platform !== 'both' || !d[key]) return d;
    const out = { ...d };
    for (const f of PAID_FIELDS) out[f] = d[key][f];
    out.paidRatings = (d.paidRatings || []).filter(r => r.platform === platform);
    return out;
  });
}

// ---------------------------------------------------------------------
//  Search
//
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

/** A predicate for one search string, so the URL parsing happens once per search, not per creative. */
function searchMatcher(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return null;
  const looksLikeUrl = /^https?:\/\//i.test(q) || /\.(com|net|org|me)\//i.test(q);
  const qKey = postKey(q);
  const links = d => [d.igLink, d.fbLink, d.ttLink].filter(Boolean);
  if (qKey && qKey.length > 4) {
    return d => {
      const ls = links(d);
      if (ls.some(l => postKey(l) === qKey)) return true;
      if (ls.some(l => String(l).toLowerCase().includes(qKey))) return true;
      // A pasted link that matches no post is a miss, not a reason to fall
      // through to substring matching on the domain.
      if (looksLikeUrl) return false;
      return plain(d);
    };
  }
  // A URL with no identifiable post in it (".../reel/") would otherwise
  // substring-match every creative on that platform.
  if (looksLikeUrl) return () => false;
  return plain;

  function plain(d) {
    const fields = [d.id, d.short, d.creatorProfile, d.creatorHandle, d.campaign, ...links(d)];
    return fields.some(v => String(v || '').toLowerCase().includes(q));
  }
}

// ---------------------------------------------------------------------
//  Filters
// ---------------------------------------------------------------------
const acted = d => [d.actionStatus, d._meta && d._meta.actionStatus, d._tt && d._tt.actionStatus]
  .some(s => String(s || '').toLowerCase() === 'actioned');

const STATUS = {
  ACTIVE: d => d.adStatus === 'ACTIVE',
  STOPPED: d => d.adStatus === 'STOPPED',
  BOOSTED: d => d.isBoosted,
  NOT_BOOSTED: d => !d.isBoosted,
  VALIDATED_NOT_BOOSTED: d => d.isValidated && !d.isBoosted,
  FATIGUING: d => d.fatiguing && d.boostState === 'running',
  BOOST_ENDED: d => d.boostState === 'ended',
};
const SOURCE = {
  brand: d => d.type === 'Brand Say',
  creator_led: d => d.type === 'Brand Say' && d.creatorLed,
  creator: d => d.type === 'Others Say' && d.source !== 'community',
  community: d => d.source === 'community',
};

/** The query string's filters, with anything unknown dropped, so the cache key is stable. */
function normalise(q) {
  const s = v => (v === undefined || v === null ? '' : String(v)).trim();
  const f = v => (s(v) && s(v) !== 'all' ? s(v) : '');
  const sort = ['date', 'added', 'reach', 'spend', 'cqr'].includes(s(q.sort)) ? s(q.sort) : 'date';
  return {
    platform: ['meta', 'tiktok'].includes(s(q.platform)) ? s(q.platform) : 'both',
    q: s(q.q).toLowerCase().slice(0, 300),
    type: f(q.type), month: f(q.month), campaign: f(q.campaign), contentType: f(q.contentType),
    action: f(q.action), status: f(q.status), source: f(q.source), origin: f(q.origin),
    validation: f(q.validation),
    sort, dir: s(q.dir) === 'asc' ? 'asc' : 'desc',
  };
}

function cacheKey(f) {
  return JSON.stringify(f);
}

function applyFilters(list, f, ix) {
  const tests = [];
  if (f.type) tests.push(d => d.type === f.type);
  if (f.month) tests.push(d => d.month === f.month);
  if (f.campaign) tests.push(d => d.campaign === f.campaign);
  if (f.contentType) tests.push(d => d.contentType === f.contentType);
  if (f.action === 'actioned') tests.push(acted);
  // The slim list carries whether a recommendation exists, not its text.
  if (f.action === 'not_actioned') tests.push(d => d.hasRec && !acted(d));
  if (STATUS[f.status]) tests.push(STATUS[f.status]);
  if (SOURCE[f.source]) tests.push(SOURCE[f.source]);
  if (f.origin === 'original') tests.push(d => !d.isRepurposed);
  if (f.origin === 'repurposed') tests.push(d => d.isRepurposed);
  if (f.origin === 'has_repurposed') tests.push(d => ix.repurposes.has(d.id));
  if (f.validation === 'validated') tests.push(d => d.isValidated);
  if (f.validation === 'not_validated') tests.push(d => !d.isValidated);
  const m = searchMatcher(f.q);
  if (m) tests.push(m);
  return tests.length ? list.filter(d => tests.every(t => t(d))) : list.slice();
}

// ---------------------------------------------------------------------
//  Sort
//
//  Hook and hold are not sortable: both are paid-only, so they ranked
//  every unboosted creative as a zero. Blank dates sort last in either
//  direction rather than jumping to the top.
// ---------------------------------------------------------------------
function sortList(list, sort, dir) {
  const asc = dir === 'asc';
  const ts = v => {
    if (!v) return asc ? Infinity : -Infinity;
    const t = Date.parse(v);
    return Number.isNaN(t) ? (asc ? Infinity : -Infinity) : t;
  };
  const CQR = { Good: 0, Average: 1, Poor: 2, Invalid: 3 };
  const val = {
    reach: d => d.reach,
    spend: d => d.spend,
    // Better grades rank higher, so descending puts Good first.
    cqr: d => -(CQR[d.cqr] ?? 4),
    date: d => ts(d.date),
    added: d => ts(d.addedAt),
  }[sort] || (d => ts(d.date));
  // Decorate once rather than parsing dates on every comparison.
  const keyed = list.map((d, i) => ({ d, k: val(d) || 0, i }));
  keyed.sort((a, b) => {
    const diff = asc ? a.k - b.k : b.k - a.k;
    // Infinity - Infinity is NaN; equal keys keep the build's order.
    return (diff || 0) || a.i - b.i;
  });
  return keyed.map(x => x.d);
}

// ---------------------------------------------------------------------
//  The summary tiles
//
//  Every tile answers "what needs me", not "how much do we have", for
//  the creatives the filters leave. The named tiles keep their five, so
//  the drawer under them opens without another request.
// ---------------------------------------------------------------------

/** The best organic grade this creative earned, across its platforms. */
function bestOrganicGrade(d) {
  let best = null;
  for (const k of ORG_KEYS) {
    const g = (d[k] || {}).cqr;
    if (isGrade(g) && (best === null || RANK[g] < RANK[best])) best = g;
  }
  if (best) return best;
  return isGrade(d.bestOrgCqr) ? d.bestOrgCqr : null;
}

/**
 * The rating to judge a creative on, and where it came from. Paid first:
 * once there is spend behind a post its organic numbers include paid
 * delivery. With no spend the organic rating is all there is.
 */
function ratedBy(d) {
  if (isGrade(d.cqr)) return { d, grade: d.cqr, src: 'paid' };
  const o = bestOrganicGrade(d);
  return o ? { d, grade: o, src: 'organic' } : null;
}

function summarize(data, now = new Date()) {
  const s = {
    total: data.length, brandSay: 0, othersSay: 0, running: 0, ended: 0, never: 0,
    orgViews: 0, paidViews: 0, readyToBoost: 0, fatiguing: 0,
  };
  const rated = [];
  for (const d of data) {
    if (d.type === 'Brand Say') s.brandSay++;
    if (d.type === 'Others Say') s.othersSay++;
    if (d.boostState === 'running') s.running++;
    if (d.boostState === 'ended') s.ended++;
    if (d.boostState === 'never') s.never++;
    if (d.igOrganic) s.orgViews += d.igOrganic.views || 0;
    if (d.fbOrganic) s.orgViews += d.fbOrganic.videoViews || 0;
    if (d.ttOrganic) s.orgViews += d.ttOrganic.views || 0;
    s.paidViews += d.paidViews || 0;
    if (d.needsBoostWarning) s.readyToBoost++;
    if (d.fatiguing && d.boostState === 'running') s.fatiguing++;
    const r = ratedBy(d);
    if (r) rated.push(r);
  }

  const rk = r => RANK[r.grade];
  const newest = (a, b) => String(b.d.date || '').localeCompare(String(a.d.date || ''));
  // "This month" is the current calendar month by publish date.
  const thisMonth = now.toISOString().slice(0, 7);
  // The two lists never share a creative: the top list is Average or
  // better, the weak list is Poor only. Ranking everything instead put an
  // Average creative on both tiles when only two were running.
  const monthRated = rated.filter(r => (r.d.date || '').startsWith(thisMonth));
  const top = monthRated
    .filter(r => r.grade !== 'Poor')
    .sort((a, b) => rk(a) - rk(b) || (b.d.reach || 0) - (a.d.reach || 0))
    .slice(0, 5);
  // Poor only, most recent first, deliberately not by lifetime spend.
  // What is running on paid money comes first; with nothing boosted the
  // tile falls back to organic ratings.
  const live = rated.filter(r => r.src === 'paid' && r.d.boostState === 'running');
  const weakIsLive = live.length > 0;
  const weak = (weakIsLive ? live : rated.filter(r => r.src === 'organic'))
    .filter(r => r.grade === 'Poor')
    .sort(newest)
    .slice(0, 5);

  s.weakIsLive = weakIsLive;
  // For the empty tiles: "nothing rated yet" and "nothing rated Poor" are
  // different news.
  s.rated = rated.length;
  s.monthRated = monthRated.length;
  // The creative itself rides along, so a row in the drawer opens without
  // waiting on another request.
  s.top = top.map(r => ({ id: r.d.id, grade: r.grade, src: r.src }));
  s.weak = weak.map(r => ({ id: r.d.id, grade: r.grade, src: r.src }));
  s.items = [...top, ...weak].map(r => r.d);
  return s;
}

// ---------------------------------------------------------------------
//  Per-build index
//
//  Worked out once per payload build and reused by every request until
//  the next build: the slim list, a lookup by id, lineage, and the
//  filter dropdowns' options. Query results are kept too, so scrolling
//  through one filter's pages filters and sorts once.
// ---------------------------------------------------------------------
const MAX_QUERIES = 64;

function buildIndex(slim) {
  const byId = new Map(slim.map(d => [d.id, d]));
  const repurposes = new Map();
  for (const d of slim) {
    if (!d.isRepurposed || !d.extractedOrigId) continue;
    if (!repurposes.has(d.extractedOrigId)) repurposes.set(d.extractedOrigId, []);
    repurposes.get(d.extractedOrigId).push(d);
  }
  const uniq = (f) => [...new Set(slim.map(f).filter(Boolean))].sort();
  return {
    slim, byId, repurposes,
    options: {
      months: uniq(d => d.month),
      campaigns: uniq(d => d.campaign),
      contentTypes: uniq(d => d.contentType),
    },
    views: new Map(),      // platform -> list in that platform's numbers
    queries: new Map(),    // cache key -> { list, summary }
  };
}

function viewOf(ix, platform) {
  if (!ix.views.has(platform)) ix.views.set(platform, platformView(ix.slim, platform));
  return ix.views.get(platform);
}

/** Filtered and sorted list for one query, and its summary when asked for. */
function run(ix, f, withSummary) {
  const key = cacheKey(f);
  let hit = ix.queries.get(key);
  if (!hit) {
    // Sort order does not change what the tiles count, so filtered sets
    // that differ only in sort share their summary.
    const list = sortList(applyFilters(viewOf(ix, f.platform), f, ix), f.sort, f.dir);
    hit = { list, summary: null };
    if (ix.queries.size >= MAX_QUERIES) ix.queries.delete(ix.queries.keys().next().value);
    ix.queries.set(key, hit);
  } else {
    // Most recently used goes to the back, so the oldest is what goes.
    ix.queries.delete(key);
    ix.queries.set(key, hit);
  }
  if (withSummary && !hit.summary) {
    const sumKey = cacheKey({ ...f, sort: '', dir: '' });
    const twin = [...ix.queries.values()].find(x => x.summary && x.sumKey === sumKey);
    hit.summary = twin ? twin.summary : summarize(hit.list);
    hit.sumKey = sumKey;
  }
  return hit;
}

module.exports = {
  normalise, buildIndex, run, viewOf, summarize, bestOrganicGrade, ratedBy,
  platformView, searchMatcher, postKey, applyFilters, sortList,
};

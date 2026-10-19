// =====================================================================
//  creatives.js — builds the dashboard payload straight from Postgres
//
//  Replaces sheetsCompat.js. The database does the aggregation and the
//  scoring; this file only shapes the result and adds the few things
//  that are genuinely presentation concerns (display labels, string
//  parsing, "is it stale right now").
//
//  Response:
//    { brand: {id, name}, creatives: [...], account: [...], campaigns: [...] }
// =====================================================================
const { query } = require('./db');
// The card shows how far through the validation window a new post is, so
// it needs the same figure the rating uses. Imported rather than repeated,
// because two copies of a window would drift and the card would then
// disagree with the panel about when a post becomes readable.
const { MIN_HOURS } = require('./organic-validation');
const SR = require('./server/static-rating');

// Slides for photos and carousels. Separate and tolerant, so a database
// without migration 022 keeps its dashboard and simply shows no slides.
async function slidesFor(brandId) {
  try {
    const { rows } = await query(
      `select creative_id, slides, slide_count from creatives
        where brand_id = $1 and (slides is not null or slide_count is not null)`, [brandId]);
    return Object.fromEntries(rows.map(r => [r.creative_id, r]));
  } catch (e) {
    if (e.code === '42703') return {};
    throw e;
  }
}

const num = v => (v === null || v === undefined ? 0 : Number(v));
const r1  = v => Math.round(num(v) * 10) / 10;

// ---------------------------------------------------------------------
//  Display label. Presentation, so it stays in JS.
// ---------------------------------------------------------------------
function shortName(id) {
  const m = String(id).match(/Video(\d+)_(BrandSay|OthersSay)/);
  if (m) return `Video${m[1]} ${m[2] === 'BrandSay' ? 'Brand Say' : 'Others Say'}`;
  const parts = String(id).split('_');
  return parts.length >= 4 ? `${parts[1]} · ${parts[2]} · ${parts[3]}` : id;
}

// The "original creative" field holds a free-text name with an optional
// URL glued on. Parsing that is a display concern, not data.
function parseOriginal(raw) {
  const out = { originalName: raw || '', originalUrl: '', extractedOrigId: null };
  if (!raw) return out;
  const m = raw.match(/(https?:\/\/[^\s_]+)/);
  if (m) out.originalUrl = m[1];
  if (raw.includes('http')) out.originalName = raw.split('_http')[0].replace(/_/g, ' ');
  out.extractedOrigId = raw.split('_http')[0] || null;
  return out;
}

function monthLabel(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${dt.getUTCFullYear()}`;
}

// One platform's metrics, in the shape the render layer expects for
// _meta / _tt. Returns null when the creative never ran on it.
function paidBlock(row, platform) {
  if (!row) return null;
  const hook = r1(row.hook_rate);
  return {
    id: row.creative_id,
    platform,
    spend: Math.round(num(row.spend)),
    reach: num(row.reach),
    impressions: num(row.impressions),
    hookRate: hook,
    holdRate: r1(row.hold_rate),
    hookQual: row.hook_q || '',
    holdQual: row.hold_q || '',
    vtr: r1(row.vtr),
    watchTime: r1(row.avg_watch_time),
    cqr: row.cqr || '',
    adStatus: row.is_active ? 'ACTIVE' : 'STOPPED',
    duration: row.duration_s === null ? null : Number(row.duration_s),
    // w25..w100 are already percentages, averaged in SQL. No divisor,
    // no reconstruction — this is what killed the Video Plays hack.
    ret: [100, hook, r1(row.w25), r1(row.w50), r1(row.w75), r1(row.w100)],
    recommendation: row.recommendation || '',
    // Structured fields from the recommendation. Null on rows written before
    // the structured schema, so the renderer falls back to the text blob.
    rec: row.verdict || row.action ? {
      verdict: row.verdict || '',
      working: row.working || '',
      notWorking: row.not_working || '',
      action: row.action || '',
      actionType: row.action_type || '',
      priority: row.priority || '',
      confidence: row.confidence || '',
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
    } : null,
    actionStatus: row.action_status || '',
    actionBy: row.actioned_by || '',
    actionDate: row.action_date ? new Date(row.action_date).toISOString().slice(0, 10) : '',
    agency: row.agency || ''
  };
}

// Views and the run's end date per creative, which the summary bar needs
// and the lifetime views do not carry. Optional: a brand with no paid
// history, or a database without migration 011, simply gets nothing.
async function paidExtras(brandId) {
  const out = { views: {}, window: {} };
  try {
    const { rows } = await query(
      `select creative_id, sum(video_plays) as video_plays, max(date) as last_day
         from (
           select creative_id, video_plays, date from v_paid_meta_scored where brand_id = $1
           union all
           select creative_id, video_plays, date from v_paid_tiktok_scored where brand_id = $1
         ) x
        where creative_id is not null
        group by creative_id`, [brandId]);
    for (const r of rows) {
      out.views[r.creative_id] = Number(r.video_plays) || 0;
      out.window[r.creative_id] = { last_day: r.last_day };
    }
  } catch (err) { if (err.code !== '42P01') throw err; }

  // Fatigue: the rating of its first week against its last week. Only
  // meaningful once a creative has run a fortnight, which the view's own
  // dates let us check.
  try {
    const { rows } = await query(
      `select creative_id, platform, window_name, cqr, from_date, to_date, impressions
         from v_paid_windowed
        where brand_id = $1 and window_name in ('first_7','last_7','lifetime')`, [brandId]);
    const byId = {};
    for (const r of rows) (((byId[r.creative_id] ||= {})[r.platform] ||= {}))[r.window_name] = r;
    const RANK = { Good: 0, Average: 1, Poor: 2 };
    for (const [id, plats] of Object.entries(byId)) {
      let faded = false, from = null, to = null, checked = false;
      // Which platform faded, not just that one did. The card has to say
      // "fatiguing on TikTok", and this loop already knows.
      const fadedOn = [];
      for (const [plat, w] of Object.entries(plats)) {
        const life = w.lifetime, first = w.first_7, last = w.last_7;
        if (!life || !first || !last) continue;
        const runDays = Math.round((new Date(life.to_date) - new Date(life.from_date)) / 86400000) + 1;
        if (runDays < 14) continue;                       // no two windows to compare
        if (Number(last.impressions) < 1000) continue;    // too thin to read
        if (RANK[first.cqr] === undefined || RANK[last.cqr] === undefined) continue;
        checked = true;
        if (RANK[last.cqr] > RANK[first.cqr]) {
          faded = true; from = first.cqr; to = last.cqr;
          fadedOn.push(plat);
        }
      }
      out.window[id] = { ...(out.window[id] || {}), faded, fadedFrom: from, fadedTo: to, fadedOn, checked };
    }
  } catch (err) { if (err.code !== '42P01') throw err; }
  return out;
}

// Each creative's Brainsuite score, for the badge on its card: the latest
// finished test, else the latest attempt (so "Scoring" shows while it runs).
// About 20 bytes a creative; the full summary loads only when the Brainsuite
// section is opened. Optional: without migration 012 there is simply nothing.
async function brainsuiteScores(brandId) {
  try {
    const { rows } = await query(
      `select distinct on (j.creative_id) j.creative_id, j.status, r.total_score, r.total_rating
         from brainsuite_jobs j left join brainsuite_results r on r.job_id = j.id
        where j.brand_id = $1 and j.kind = 'creative' and j.creative_id is not null
        order by j.creative_id, (j.status = 'succeeded') desc, j.created_at desc`, [brandId]);
    return Object.fromEntries(rows.map(r => [r.creative_id, r]));
  } catch (err) {
    if (err.code === '42P01') return {};
    throw err;
  }
}

async function buildPayload(brandId) {
  const [extras, bsBy, staticBands, followersBy, slidesBy] = await Promise.all([
    paidExtras(brandId), brainsuiteScores(brandId),
    SR.loadBands(query, brandId), SR.loadFollowers(query, brandId), slidesFor(brandId),
  ]);
  const [brandR, contentR, metaR, ttR, organicR, bestR, boostR, accountR, campR] =
    await Promise.all([
      query(`select brand_id, name from brands where brand_id = $1`, [brandId]),

      query(`select creative_id, date, campaign, type, source, creator_led, is_repurposed,
                    original_creative_id, content_hook, seg1, seg2, seg3, seg4, segments,
                    format, product_role, format_note,
                    content_type, duration_s, creator_profile, creator_handle,
                    ig_handle, tt_handle, fb_handle, created_at,
                    ig_link, fb_link, tt_link, thumbnail_url
               from creatives where brand_id = $1
              order by date desc nulls last, created_at desc`, [brandId]),

      query(`select * from v_paid_meta_creative where brand_id = $1
              and creative_id is not null`, [brandId]),

      query(`select * from v_paid_tiktok_creative where brand_id = $1
              and creative_id is not null`, [brandId]),

      query(`select o.creative_id, o.platform, o.views, o.reach, o.likes,
                    o.comments, o.shares, o.saves, o.total_interactions,
                    o.avg_watch_time, o.time_posted, s.cqr,
                    s.engagement_rate, s.retention_rate
               from organic_perf o
               join creatives c on c.creative_id = o.creative_id
               left join v_organic_scored s
                 on s.creative_id = o.creative_id and s.platform = o.platform
              where c.brand_id = $1`, [brandId]),

      query(`select creative_id, best_cqr, is_validated
               from v_creative_organic_best where brand_id = $1`, [brandId]),

      query(`select creative_id, is_boosted from v_boost_status
              where brand_id = $1`, [brandId]),

      query(`select month, act_spend, act_reach, act_impressions,
                    act_frequency, act_engagement_rate, act_cpm,
                    kpi_spend, kpi_reach, kpi_impressions, kpi_frequency
               from account_monthly where brand_id = $1 order by month`, [brandId]),

      // Campaigns come from their own table now, so a campaign can be created
      // before any creative uses it. Union with what creatives already carry so
      // nothing that predates the table drops out of the dropdowns.
      query(`select name as campaign from campaigns
              where brand_id = $1 and is_active = true
             union
             select distinct campaign from creatives
              where brand_id = $1 and campaign is not null and campaign <> ''
             order by campaign`, [brandId])
    ]);

  const metaBy  = Object.fromEntries(metaR.rows.map(r => [r.creative_id, r]));
  const ttBy    = Object.fromEntries(ttR.rows.map(r => [r.creative_id, r]));
  const bestBy  = Object.fromEntries(bestR.rows.map(r => [r.creative_id, r]));
  const boostBy = Object.fromEntries(boostR.rows.map(r => [r.creative_id, r.is_boosted]));

  // Photos and carousels are rated on engagement, not on the video rule
  // the view applies, which would leave every one of them unrated.
  const contentById = Object.fromEntries(contentR.rows.map(c => [c.creative_id, c]));
  const organicBy = {};
  organicR.rows.forEach(o => {
    const cr = contentById[o.creative_id];
    let cqr = o.cqr || '';
    if (cr && SR.isStatic(cr.content_type)) {
      const r = SR.rateStatic({
        o, type: cr.type, plat: o.platform, brandId, bands: staticBands,
        followers: (followersBy[o.creative_id] || {})[o.platform],
        storedCqr: o.cqr, postedAt: o.time_posted, contentType: cr.content_type,
      });
      cqr = r.cqr || '';
    }
    (organicBy[o.creative_id] ||= {})[o.platform] = {
      views: num(o.views), reach: num(o.reach), likes: num(o.likes),
      // buildOrganicHTML() renders the Facebook box with videoViews /
      // reactions. Same numbers, FB's own naming — aliased here so the
      // render layer needs no edit.
      videoViews: num(o.views), reactions: num(o.likes),
      comments: num(o.comments), shares: num(o.shares), saves: num(o.saves),
      totalInteractions: num(o.total_interactions),
      avgWatchTime: num(o.avg_watch_time),
      engagementRate: o.engagement_rate === null ? null : Number(o.engagement_rate),
      retentionRate: o.retention_rate === null ? null : Number(o.retention_rate),
      cqr,
      timePosted: o.time_posted
    };
  });

  const now = Date.now();

  const creatives = contentR.rows.map(c => {
    const id = c.creative_id;
    const m  = paidBlock(metaBy[id], 'meta');
    const t  = paidBlock(ttBy[id], 'tiktok');
    const org = organicBy[id] || {};
    const isStatic = SR.isStatic(c.content_type);
    const sl = slidesBy[id] || {};
    // A static's best organic grade comes from the engagement rating above,
    // since the view only knows the video rule.
    let best = bestBy[id] || {};
    if (isStatic) {
      const RANKS = { Good: 0, Average: 1, Poor: 2 };
      const grades = Object.values(org).map(x => x.cqr).filter(g => RANKS[g] !== undefined)
        .sort((a, b) => RANKS[a] - RANKS[b]);
      best = { best_cqr: grades[0] || null, is_validated: grades[0] === 'Good' };
    }

    // Combined view across platforms, mirroring the old addPaid() rollup
    const both = [m, t].filter(Boolean);
    const platform = both.length > 1 ? 'both' : (both[0] ? both[0].platform : 'both');
    const avg = f => both.length ? both.reduce((s, x) => s + x[f], 0) / both.length : 0;
    const cqrRank = { Good: 0, Average: 1, Poor: 2 };
    // The paid rating is built on video watch rates (hook and hold), so a
    // photo or carousel is not given one: it would read Poor for having
    // no video, which says nothing about the post.
    const bestPaidCqr = isStatic ? 'Invalid' : (both
      .map(x => x.cqr)
      .sort((a, b) => (cqrRank[a] ?? 9) - (cqrRank[b] ?? 9))[0] || 'Invalid');

    const isBoosted = !!boostBy[id];

    // Needs "now", so it is computed per request rather than in SQL.
    let needsBoostWarning = false;
    if (best.is_validated && !isBoosted && c.date) {
      needsBoostWarning = (now - new Date(c.date).getTime()) / 3600000 > 48;
    }

    return {
      id,
      short: shortName(id),
      type: c.type,
      // Others Say splits into briefed creator content and posts by the
      // public. Null on Brand Say.
      source: c.source || null,
      // Brand Say content fronted by a creator.
      creatorLed: c.creator_led === true,
      campaign: c.campaign || '',
      month: monthLabel(c.date),
      date: c.date ? new Date(c.date).toISOString().slice(0, 10) : '',
      // When the creative was added to the system, as opposed to when the
      // post went live. Drives the "recently added" sort.
      addedAt: c.created_at ? new Date(c.created_at).toISOString() : '',
      platform,

      // combined paid metrics
      spend: both.reduce((s, x) => s + x.spend, 0),
      reach: both.reduce((s, x) => Math.max(s, x.reach), 0),
      impressions: both.reduce((s, x) => s + x.impressions, 0),
      hookRate: r1(avg('hookRate')),
      holdRate: both.length ? Math.max(...both.map(x => x.holdRate)) : 0,
      hookQual: (m || t || {}).hookQual || '',
      holdQual: (m || t || {}).holdQual || '',
      vtr: r1(avg('vtr')),
      watchTime: r1(avg('watchTime')),
      cqr: bestPaidCqr,
      adStatus: both.some(x => x.adStatus === 'ACTIVE') ? 'ACTIVE'
              : (both.length ? 'STOPPED' : 'NOT_BOOSTED'),
      duration: c.duration_s === null ? (m || t || {}).duration ?? null : Number(c.duration_s),
      ret: (m || t || {}).ret || [100, 0, 0, 0, 0, 0],

      _meta: m,
      _tt: t,

      // Paid video views, so the summary can compare like with like
      // against organic views rather than against impressions.
      paidViews: extras.views[id] || 0,

      // Three states, not two. A creative that ran and was switched off
      // is not the same as one that never had spend behind it.
      boostState: !isBoosted ? 'never'
                : (both.some(x => x.adStatus === 'ACTIVE') ? 'running' : 'ended'),
      boostEnded: (extras.window[id] || {}).last_day
        ? new Date(extras.window[id].last_day).toISOString().slice(0, 10) : null,

      // Rated worse in its last week than its first, and still running.
      fatiguing: !!(extras.window[id] || {}).faded,
      fatigueFrom: (extras.window[id] || {}).fadedFrom || null,
      fatigueTo: (extras.window[id] || {}).fadedTo || null,
      fatigueOn: (extras.window[id] || {}).fadedOn || [],
      // Ran long enough, with enough last-week delivery, for the first and
      // last weeks to be compared at all. The summary's wear-out pattern
      // needs the denominator, not only the creatives that slipped.
      fatigueChecked: !!(extras.window[id] || {}).checked,

      // The same three facts per platform rather than collapsed across
      // both. A creative running on Meta and stopped on TikTok reads as
      // simply "running" otherwise, which is not what is happening.
      paidBy: {
        meta:   m ? { adStatus: m.adStatus || null, cqr: isStatic ? 'Not Rated' : (m.cqr || null), spend: m.spend || 0 } : null,
        tiktok: t ? { adStatus: t.adStatus || null, cqr: isStatic ? 'Not Rated' : (t.cqr || null), spend: t.spend || 0 } : null,
      },

      // content
      contentHook: c.content_hook || '',
      // Older creatives still carry quartile text; new ones do not. Kept so
      // existing rows keep rendering rather than losing their brief.
      segments: [c.seg1, c.seg2, c.seg3, c.seg4].filter(Boolean),
      // Fixed-interval descriptions: [{ t: seconds, d: text }]. Time-indexed so
      // it can be read against the retention curve.
      timeline: Array.isArray(c.segments) ? c.segments : [],
      // Format classification from the Gemini analysis, shown in the brief.
      format: c.format || '',
      productRole: c.product_role || '',
      formatNote: c.format_note || '',
      contentType: c.content_type || '',
      // Photos and carousels: no runtime, no retention, rated on engagement.
      isStatic,
      slides: Array.isArray(sl.slides) ? sl.slides : [],
      slideCount: sl.slide_count === null || sl.slide_count === undefined
        ? (Array.isArray(sl.slides) ? sl.slides.length : null) : Number(sl.slide_count),
      creativeLink: c.ig_link || c.tt_link || c.fb_link || '',
      igLink: c.ig_link || '', fbLink: c.fb_link || '', ttLink: c.tt_link || '',
      creatorProfile: c.creator_profile || null,
      // The account that actually posted it, and its handle per platform.
      // creatorProfile is who the post is filed under, which a handle-
      // matching job outside the app sets and can get wrong: a creator's
      // TikTok posted from the brand's own account chained every such
      // creator into one. Grouping goes by these instead.
      creatorHandle: c.creator_handle || null,
      handles: { ig: c.ig_handle || null, tt: c.tt_handle || null, fb: c.fb_handle || null },
      thumbnail: c.thumbnail_url || null,
      isRepurposed: !!c.is_repurposed,
      ...parseOriginal(c.original_creative_id),

      // Brainsuite: null when the creative has never been sent.
      bsStatus: bsBy[id] ? bsBy[id].status : null,
      bsScore: bsBy[id] && bsBy[id].total_score !== null ? Number(bsBy[id].total_score) : null,
      bsRating: bsBy[id] ? bsBy[id].total_rating || null : null,

      // organic
      igOrganic: org.ig || null,
      fbOrganic: org.fb || null,
      ttOrganic: org.tt || null,

      // derived — from the database, not guessed in JS
      isValidated: !!best.is_validated,
      bestOrgCqr: best.best_cqr || null,
      isBoosted,
      needsBoostWarning,

      // actions (combined view takes meta first, then tiktok)
      recommendation: (m || t || {}).recommendation || '',
      rec:            (m || t || {}).rec || null,
      actionStatus:   (m || t || {}).actionStatus || '',
      actionBy:       (m || t || {}).actionBy || '',
      actionDate:     (m || t || {}).actionDate || '',
      agency:         (m || t || {}).agency || ''
    };
  });

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  return {
    brand: brandR.rows.length
      ? { id: brandR.rows[0].brand_id, name: brandR.rows[0].name }
      : { id: brandId, name: brandId },
    creatives,
    account: accountR.rows.map(a => {
      const d = new Date(a.month);
      return {
        month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        actSpend: num(a.act_spend), actReach: num(a.act_reach),
        actImpressions: num(a.act_impressions), actFrequency: num(a.act_frequency),
        actEngagement: num(a.act_engagement_rate), actCpm: num(a.act_cpm),
        kpiSpend: num(a.kpi_spend), kpiReach: num(a.kpi_reach),
        kpiImpressions: num(a.kpi_impressions), kpiFrequency: num(a.kpi_frequency)
      };
    }),
    campaigns: campR.rows.map(r => r.campaign),
    // How long a post is left alone before its organic numbers are read.
    validationHours: MIN_HOURS,
  };
}

// ---------------------------------------------------------------------
//  Serving it
//
//  The browser no longer holds a brand's creative list. The Creative Hub
//  asks for one filtered, sorted page at a time (server/hub.js), and the
//  scene timeline, brief and recommendation text, which only the creative
//  panel reads, are fetched when a creative is opened.
//
//  A built payload is reused for a while per brand, so the pages, the
//  tiles and the details opened from them come from one build rather than
//  nine queries each. Writes made through the app clear it at once. Past
//  CACHE_MS the next request still gets the last build straight away
//  while a fresh one is made behind it, so nobody waits on a rebuild for
//  data that only n8n has touched. Past STALE_MS it is too old to show,
//  and the request waits for the new build.
// ---------------------------------------------------------------------
const HUB = require('./server/hub');

const CACHE_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;
const cache = new Map();   // brandId -> { at, promise, value? }
// Bumped by every invalidation, so a background rebuild that started
// before a write cannot put pre-write data back in the cache.
const generation = new Map();
let generationAll = 0;
const genOf = (brandId) => `${generationAll}:${generation.get(brandId) || 0}`;

// ---------------------------------------------------------------------
//  How long builds take
//
//  Each build records its size and time per brand, so the logs show the
//  trend well before anyone feels it. A build past either threshold logs
//  a warning: with paging in place the browser no longer feels a large
//  list, but the build itself still grows with the brand, and past this
//  point it is worth moving the card fields into their own table
//  (docs/scaling.md).
// ---------------------------------------------------------------------
const WARN_CREATIVES = Number(process.env.PAYLOAD_WARN_CREATIVES || 3000);
const WARN_BUILD_MS = Number(process.env.PAYLOAD_WARN_BUILD_MS || 1000);
const stats = new Map();   // brandId -> { creatives, buildMs, bytes, at }

function noteBuild(brandId, creatives, buildMs) {
  stats.set(brandId, { creatives, buildMs, bytes: null, at: new Date().toISOString() });
  const line = `[payload] brand=${brandId} creatives=${creatives} build=${buildMs}ms`;
  if (creatives >= WARN_CREATIVES || buildMs >= WARN_BUILD_MS) {
    console.warn(`${line} WARN past the threshold (${WARN_CREATIVES} creatives or ${WARN_BUILD_MS}ms); time to keep the card fields in their own table, see docs/scaling.md`);
  } else {
    console.log(line);
  }
}

/** Record the size of a response, so the stats show what one page or the library costs. */
function notePayloadSent(brandId, bytes) {
  const st = stats.get(brandId);
  if (st) st.bytes = bytes;
}

/** The latest build's figures for every brand built since the server started. */
function payloadStats() {
  return [...stats.entries()].map(([brand, s]) => ({ brand, ...s,
    warn: s.creatives >= WARN_CREATIVES || s.buildMs >= WARN_BUILD_MS }))
    .sort((a, b) => b.creatives - a.creatives);
}

function startBuild(brandId) {
  const started = Date.now();
  const promise = buildPayload(brandId);
  const entry = { at: Date.now(), promise, gen: genOf(brandId) };
  promise.then(p => {
    entry.value = p;
    noteBuild(brandId, p.creatives.length, Date.now() - started);
  }).catch(() => {});
  return entry;
}

function getPayload(brandId) {
  const hit = cache.get(brandId);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < CACHE_MS) return hit.promise;
  if (hit && hit.value && age < STALE_MS) {
    // Serve the last build and refresh behind it, once.
    if (!hit.refreshing) {
      hit.refreshing = true;
      const next = startBuild(brandId);
      next.promise.then(() => {
        if (next.gen === genOf(brandId) && cache.get(brandId) === hit) cache.set(brandId, next);
      }, err => {
        hit.refreshing = false;
        console.error('[payload] background rebuild failed, keeping the last build:', err.message);
      });
    }
    return hit.promise;
  }
  const entry = startBuild(brandId);
  cache.set(brandId, entry);
  // A failed build is not kept, so the next request tries again.
  entry.promise.catch(() => { if (cache.get(brandId) === entry) cache.delete(brandId); });
  return entry.promise;
}

/** Drop the cached payload for one brand, or for every brand. */
function invalidatePayload(brandId) {
  if (brandId) {
    cache.delete(brandId);
    generation.set(brandId, (generation.get(brandId) || 0) + 1);
  } else {
    cache.clear();
    generationAll++;
  }
}

// Read only by the creative panel.
const DETAIL_KEYS = ['timeline', 'segments', 'contentHook', 'formatNote', 'format', 'productRole',
                     'recommendation', 'rec', 'slides'];
const PAID_DETAIL_KEYS = ['recommendation', 'rec'];

function slimCreative(c) {
  const out = { ...c };
  // The "not actioned" filter needs to know a recommendation exists, not
  // what it says.
  out.hasRec = !!(c.recommendation || (c._meta && c._meta.recommendation) || (c._tt && c._tt.recommendation));
  for (const k of DETAIL_KEYS) delete out[k];
  for (const p of ['_meta', '_tt']) {
    if (!out[p]) continue;
    out[p] = { ...out[p] };
    for (const k of PAID_DETAIL_KEYS) delete out[p][k];
  }
  return out;
}

function detailOf(c) {
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
  const out = pick(c, DETAIL_KEYS);
  for (const p of ['_meta', '_tt']) if (c[p]) out[p] = pick(c[p], PAID_DETAIL_KEYS);
  return out;
}

// One index per build: the slim list, lookups and cached queries.
const indexes = new WeakMap();
async function getIndex(brandId) {
  const p = await getPayload(brandId);
  let ix = indexes.get(p);
  if (!ix) {
    ix = HUB.buildIndex(p.creatives.map(slimCreative));
    ix.byIdFull = new Map(p.creatives.map(c => [c.id, c]));
    indexes.set(p, ix);
  }
  return { p, ix };
}

/**
 * Everything the page needs except the creatives: the brand, the Media
 * Summary's account numbers, campaigns, and the Creative Hub's dropdown
 * options and size.
 */
async function pageMeta(brandId) {
  const { p, ix } = await getIndex(brandId);
  const { creatives, ...rest } = p;
  return { ...rest, total: creatives.length, options: ix.options };
}

/**
 * The slim list of every creative, for the pages that still work out
 * their figures in the browser (Media Summary and Creators). Loaded only
 * when one of those pages is opened.
 */
async function libraryPayload(brandId) {
  const { ix } = await getIndex(brandId);
  return ix.slim;
}

/** The dashboard payload without the panel-only fields. Kept for anything still calling it. */
async function listPayload(brandId) {
  const { p, ix } = await getIndex(brandId);
  return { ...p, creatives: ix.slim };
}

const PAGE_MAX = 200;

/**
 * One page of the Creative Hub.
 *
 *   { total, offset, items, nextOffset, summary? }
 *
 * `total` is how many creatives the filters leave; `summary` is the tiles
 * for that set, sent with the first page only. `ids` instead of filters
 * returns those creatives, for one opened from somewhere other than the
 * grid.
 */
async function hubPage(brandId, q) {
  const { ix } = await getIndex(brandId);
  const f = HUB.normalise(q);

  if (q.ids) {
    const want = String(q.ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, PAGE_MAX);
    const view = new Map(HUB.viewOf(ix, f.platform).map(d => [d.id, d]));
    return { items: want.map(id => view.get(id) || ix.byId.get(id)).filter(Boolean) };
  }

  const withSummary = q.summary === '1' || q.summary === 'true';
  const hit = HUB.run(ix, f, withSummary);
  const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
  const limitRaw = q.limit === undefined ? 48 : Math.floor(Number(q.limit));
  const limit = Math.min(PAGE_MAX, Math.max(0, Number.isFinite(limitRaw) ? limitRaw : 48));
  const items = hit.list.slice(offset, offset + limit);
  const out = {
    total: hit.list.length,
    offset,
    items,
    nextOffset: offset + items.length < hit.list.length ? offset + items.length : null,
  };
  if (withSummary) {
    const { items: tileItems, ...summary } = hit.summary;
    out.summary = summary;
    // The tiles' named creatives, so a row in the drawer opens at once.
    out.summaryItems = tileItems;
  }
  return out;
}

/** Every creative id for the brand, newest first, for the add form's "original" picker. */
async function creativeIds(brandId) {
  const { ix } = await getIndex(brandId);
  return ix.slim.map(d => d.id);
}

/**
 * Panel-only fields for the given creatives, keyed by id, with each one's
 * lineage: the creative it was repurposed from, or the ones repurposed
 * from it, as slim records. Unknown ids are left out.
 */
async function creativeDetails(brandId, ids) {
  const { ix } = await getIndex(brandId);
  const out = {};
  for (const id of ids) {
    const c = ix.byIdFull.get(id);
    if (!c) continue;
    const d = detailOf(c);
    const own = ix.byId.get(id);
    d.lineage = {
      origin: own && own.isRepurposed && own.extractedOrigId ? ix.byId.get(own.extractedOrigId) || null : null,
      repurposes: ix.repurposes.get(id) || [],
    };
    out[id] = d;
  }
  return out;
}

module.exports = { buildPayload, listPayload, libraryPayload, pageMeta, hubPage, creativeIds,
                   creativeDetails, invalidatePayload, slimCreative, detailOf,
                   notePayloadSent, payloadStats };

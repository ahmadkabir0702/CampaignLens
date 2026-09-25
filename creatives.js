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

async function buildPayload(brandId) {
  const [brandR, contentR, metaR, ttR, organicR, bestR, boostR, accountR, campR] =
    await Promise.all([
      query(`select brand_id, name from brands where brand_id = $1`, [brandId]),

      query(`select creative_id, date, campaign, type, is_repurposed,
                    original_creative_id, content_hook, seg1, seg2, seg3, seg4, segments,
                    format, product_role, format_note,
                    content_type, duration_s, creator_profile, created_at,
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

  const organicBy = {};
  organicR.rows.forEach(o => {
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
      cqr: o.cqr || '',
      timePosted: o.time_posted
    };
  });

  const now = Date.now();

  const creatives = contentR.rows.map(c => {
    const id = c.creative_id;
    const m  = paidBlock(metaBy[id], 'meta');
    const t  = paidBlock(ttBy[id], 'tiktok');
    const org = organicBy[id] || {};
    const best = bestBy[id] || {};

    // Combined view across platforms, mirroring the old addPaid() rollup
    const both = [m, t].filter(Boolean);
    const platform = both.length > 1 ? 'both' : (both[0] ? both[0].platform : 'both');
    const avg = f => both.length ? both.reduce((s, x) => s + x[f], 0) / both.length : 0;
    const cqrRank = { Good: 0, Average: 1, Poor: 2 };
    const bestPaidCqr = both
      .map(x => x.cqr)
      .sort((a, b) => (cqrRank[a] ?? 9) - (cqrRank[b] ?? 9))[0] || 'Invalid';

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
      creativeLink: c.ig_link || c.tt_link || c.fb_link || '',
      igLink: c.ig_link || '', fbLink: c.fb_link || '', ttLink: c.tt_link || '',
      creatorProfile: c.creator_profile || null,
      thumbnail: c.thumbnail_url || null,
      isRepurposed: !!c.is_repurposed,
      ...parseOriginal(c.original_creative_id),

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
    campaigns: campR.rows.map(r => r.campaign)
  };
}

module.exports = { buildPayload };

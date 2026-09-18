/**
 * Ask Lens - schema adapter
 *
 * Written against the real Campaign Lens schema, verified 2026-09-18.
 *
 * Prerequisite: the view `creative_metrics_unified` must exist. It
 * merges paid_meta and paid_tiktok into one shape and converts TikTok
 * spend from USD to LKR via fx_rates. Without it nothing here works,
 * and without the fx conversion TikTok spend reads ~300x too low.
 *
 * Three things differ from a naive schema and are handled below:
 *   1. Platform lives on the METRICS row, not the creative. One
 *      creative can run on both Meta and TikTok.
 *   2. Origin is a boolean (is_repurposed), not a text column.
 *   3. TikTok paid has no engagements, so engagement rate uses
 *      engageable_impressions as its denominator, not impressions.
 */

const schema = {
  // ---- Tables -------------------------------------------------
  tables: {
    creatives: 'creatives',
    metrics: 'creative_metrics_unified',   // the view, not a base table
    campaigns: 'campaigns',
    brands: 'brands',
    organic: 'organic_perf',
  },

  // ---- creatives columns --------------------------------------
  creative: {
    id: 'creative_id',
    brand: 'brand_id',
    name: 'content_hook',
    format: 'format',
    productRole: 'product_role',
    isRepurposed: 'is_repurposed',         // boolean
    parentId: 'original_creative_id',
    campaign: 'campaign',
    publishedAt: 'date',
    contentType: 'content_type',
    durationS: 'duration_s',
    igLink: 'ig_link',
    fbLink: 'fb_link',
    ttLink: 'tt_link',
    thumbnailUrl: null,                    // not built yet
  },

  // ---- creative_metrics_unified columns -----------------------
  metric: {
    creativeId: 'creative_id',
    brand: 'brand_id',
    date: 'date',
    platform: 'platform',                  // platform lives HERE
    impressions: 'impressions',
    reach: 'reach',
    clicks: 'clicks',
    spend: 'spend_lkr',                    // already converted to LKR
    engagements: 'engagements',
    engageableImpressions: 'engageable_impressions',
    videoViews: 'video_plays',
    videoCompletions: 'video_completions',
  },

  // ---- Derived SQL expressions --------------------------------
  // `m` is the metrics view alias, `c` the creatives alias.
  derived: {
    ctr:             'CASE WHEN SUM(m.impressions) > 0 THEN SUM(m.clicks)::numeric / SUM(m.impressions) ELSE NULL END',
    cpm:             'CASE WHEN SUM(m.impressions) > 0 THEN SUM(m.spend_lkr) * 1000.0 / SUM(m.impressions) ELSE NULL END',
    cpc:             'CASE WHEN SUM(m.clicks) > 0 THEN SUM(m.spend_lkr)::numeric / SUM(m.clicks) ELSE NULL END',
    // Denominator counts only impressions where engagement data exists,
    // otherwise Meta's engagements get divided by Meta + TikTok impressions.
    engagement_rate: 'CASE WHEN SUM(m.engageable_impressions) > 0 THEN SUM(m.engagements)::numeric / SUM(m.engageable_impressions) ELSE NULL END',
    vtr:             'CASE WHEN SUM(m.video_plays) > 0 THEN SUM(m.video_completions)::numeric / SUM(m.video_plays) ELSE NULL END',
    impressions:     'SUM(m.impressions)',
    reach:           'SUM(m.reach)',
    clicks:          'SUM(m.clicks)',
    spend:           'SUM(m.spend_lkr)',
    engagements:     'SUM(m.engagements)',
    video_views:     'SUM(m.video_plays)',
  },

  // Expressions used when grouping by creative.
  creativeExpr: {
    // A creative can run on several platforms, so this is a list.
    platforms: "array_agg(distinct m.platform)",
    origin: "CASE WHEN c.is_repurposed THEN 'repurposed' ELSE 'original' END",
    permalink: "coalesce(c.tt_link, c.ig_link, c.fb_link)",
  },

  rankableMetrics: [
    'ctr', 'cpm', 'cpc', 'engagement_rate', 'vtr',
    'impressions', 'reach', 'clicks', 'spend', 'engagements', 'video_views',
  ],

  lowerIsBetter: ['cpm', 'cpc'],

  // Metrics with no data on a given platform. The model is told this
  // so it says "not available" instead of showing a blank.
  metricGaps: {
    tiktok: ['engagement_rate', 'engagements'],
  },

  metricDisplay: {
    ctr:             { label: 'CTR',             type: 'percent', decimals: 2 },
    engagement_rate: { label: 'Engagement rate', type: 'percent', decimals: 2 },
    vtr:             { label: 'VTR',             type: 'percent', decimals: 1 },
    cpm:             { label: 'CPM',             type: 'currency', decimals: 0 },
    cpc:             { label: 'CPC',             type: 'currency', decimals: 2 },
    spend:           { label: 'Spend',           type: 'currency', decimals: 0 },
    impressions:     { label: 'Impressions',     type: 'count' },
    reach:           { label: 'Reach',           type: 'count' },
    clicks:          { label: 'Clicks',          type: 'count' },
    engagements:     { label: 'Engagements',     type: 'count' },
    video_views:     { label: 'Video views',     type: 'count' },
  },

  currency: 'LKR',

  // ---- Volume floor -------------------------------------------
  // TUNE absoluteMin once you know what a normal creative delivers.
  volumeFloor: {
    absoluteMin: 5000,
    relativeShare: 0.02,
  },

  // ---- Brands, from the brands table --------------------------
  brands: [
    'dove', 'knorr', 'lifebuoy', 'lux', 'pears',
    'ponds', 'sunsilk', 'surfexcel', 'vaseline',
  ],

  brandLabels: {
    dove: 'Dove',
    knorr: 'Knorr',
    lifebuoy: 'Lifebuoy',
    lux: 'Lux',
    pears: 'Pears',
    ponds: 'Ponds',
    sunsilk: 'Sunsilk',
    surfexcel: 'Surf Excel',
    vaseline: 'Vaseline',
  },

  // Paid runs on Meta and TikTok only. The Facebook and Instagram
  // split exists on the organic side.
  platforms: ['meta', 'tiktok'],
  organicPlatforms: ['facebook', 'instagram', 'tiktok'],

  platformLabels: {
    meta: 'Meta',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    instagram: 'Instagram',
  },

  // ---- Model + limits -----------------------------------------
  model: 'claude-haiku-4-5',
  maxTokens: 600,
  historyTurnsVerbatim: 3,
  historyTurnsCompressed: 5,
  sessionTurnCap: 12,

  rateLimit: { perHour: 30, perDay: 200 },

  snapshotRanges: [7, 30],
};

module.exports = schema;

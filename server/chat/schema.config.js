/**
 * Ask Lens - schema adapter (v2, reads the dashboard's own views)
 *
 * The chat reads the SAME per-creative views the Creative Hub reads, so a
 * number in the chat is always the number on the card. Nothing here
 * re-derives a metric the dashboard already computes.
 *
 * Metric hierarchy, in priority order. This is what "best performing"
 * means and the order the model reaches for when a question is vague:
 *
 *   1. CQR          creative quality rating: Good / Average / Poor / Invalid
 *   2. hook_rate    percent who stayed past the hook
 *   3. hold_rate    percent retained through the body
 *   4. engagement_rate  organic; paid engagement is Meta only until TikTok
 *                       engagement columns are populated
 *   5. reach, video_views
 *
 * CTR and VTR exist but are vanity here. They are only surfaced when a
 * user explicitly asks for them by name.
 */

const schema = {
  tables: {
    creatives: 'creatives',
    paidMeta: 'v_paid_meta_creative',       // per-creative, lifetime, Meta
    paidTiktok: 'v_paid_tiktok_creative',   // per-creative, lifetime, TikTok
    organicScored: 'v_organic_scored',      // per-creative per-platform organic + CQR
    organicBest: 'v_creative_organic_best', // best organic CQR per creative
    organicRaw: 'organic_perf',
    paidDaily: 'creative_metrics_unified',  // raw daily rows, for time series only
    accountMonthly: 'account_monthly',      // brand-level monthly totals
    recommendations: 'recommendations',     // existing Claude Insights verdicts
    brands: 'brands',
  },

  creative: {
    id: 'creative_id',
    brand: 'brand_id',
    hook: 'content_hook',
    format: 'format',
    productRole: 'product_role',
    type: 'type',                            // BrandSay / OthersSay etc.
    campaign: 'campaign',
    isRepurposed: 'is_repurposed',
    parentId: 'original_creative_id',
    publishedAt: 'date',
    durationS: 'duration_s',
    igLink: 'ig_link', fbLink: 'fb_link', ttLink: 'tt_link',
  },

  // Columns on the two paid views, as read by creatives.js. Values are
  // already percentages (34.2 not 0.342) except spend/reach/impressions.
  paidView: {
    creativeId: 'creative_id',
    brand: 'brand_id',
    spend: 'spend',
    reach: 'reach',
    impressions: 'impressions',
    hookRate: 'hook_rate',
    holdRate: 'hold_rate',
    hookQ: 'hook_q',
    holdQ: 'hold_q',
    vtr: 'vtr',
    avgWatchTime: 'avg_watch_time',
    cqr: 'cqr',
    isActive: 'is_active',
    durationS: 'duration_s',
    w25: 'w25', w50: 'w50', w75: 'w75', w100: 'w100',
    verdict: 'verdict',
    working: 'working',
    notWorking: 'not_working',
    action: 'action',
    priority: 'priority',
  },

  organicView: {
    creativeId: 'creative_id',
    platform: 'platform',
    cqr: 'cqr',
    engagementRate: 'engagement_rate',
    retentionRate: 'retention_rate',
  },

  organicRawCols: {
    creativeId: 'creative_id',
    platform: 'platform',
    views: 'views',
    reach: 'reach',
    likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves',
    totalInteractions: 'total_interactions',
  },

  // How Meta and TikTok rows for the same creative combine. Mirrors the
  // rollup in creatives.js so the chat never disagrees with the Hub.
  merge: {
    cqr: 'best',          // Good beats Average beats Poor
    hookRate: 'avg',
    holdRate: 'max',
    reach: 'max',
    spend: 'sum',
    impressions: 'sum',
    vtr: 'avg',
    avgWatchTime: 'avg',
  },

  cqrRank: { Good: 0, Average: 1, Poor: 2, Invalid: 3 },

  // Priority order. First is the default for vague questions.
  metricHierarchy: ['cqr', 'hook_rate', 'hold_rate', 'engagement_rate', 'reach', 'video_views'],

  // Never volunteered. Only shown when the user names them.
  vanityMetrics: ['ctr', 'vtr', 'cpm', 'cpc'],

  rankableMetrics: [
    'cqr', 'hook_rate', 'hold_rate', 'engagement_rate',
    'reach', 'video_views', 'spend', 'impressions', 'avg_watch_time',
    'vtr', 'ctr',
  ],

  metricDisplay: {
    cqr:             { label: 'CQR',             type: 'cqr' },
    hook_rate:       { label: 'Hook rate',       type: 'pct100', decimals: 1 },
    hold_rate:       { label: 'Hold rate',       type: 'pct100', decimals: 1 },
    engagement_rate: { label: 'Engagement rate', type: 'pct100', decimals: 2 },
    retention_rate:  { label: 'Retention',       type: 'pct100', decimals: 1 },
    vtr:             { label: 'VTR',             type: 'pct100', decimals: 1 },
    ctr:             { label: 'CTR',             type: 'pct100', decimals: 2 },
    reach:           { label: 'Reach',           type: 'count' },
    video_views:     { label: 'Video views',     type: 'count' },
    impressions:     { label: 'Impressions',     type: 'count' },
    spend:           { label: 'Spend',           type: 'currency', decimals: 0 },
    avg_watch_time:  { label: 'Avg watch time',  type: 'seconds', decimals: 1 },
  },

  currency: 'LKR',

  // Rankings ignore creatives with fewer impressions than this. A Good
  // CQR on 300 impressions is not a signal.
  volumeFloor: { absoluteMin: 5000, relativeShare: 0.02 },

  brands: ['dove', 'knorr', 'lifebuoy', 'lux', 'pears', 'ponds', 'sunsilk', 'surfexcel', 'vaseline'],
  brandLabels: {
    dove: 'Dove', knorr: 'Knorr', lifebuoy: 'Lifebuoy', lux: 'Lux', pears: 'Pears',
    ponds: 'Ponds', sunsilk: 'Sunsilk', surfexcel: 'Surf Excel', vaseline: 'Vaseline',
  },

  platforms: ['meta', 'tiktok'],
  organicPlatforms: ['facebook', 'instagram', 'tiktok'],
  platformLabels: { meta: 'Meta', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram' },

  model: 'claude-haiku-4-5',
  maxTokens: 600,
  historyTurnsVerbatim: 3,
  historyTurnsCompressed: 5,
  sessionTurnCap: 12,
  rateLimit: { perHour: 30, perDay: 200 },

  // Lifetime per creative, like the Creative Hub. One snapshot per brand.
  snapshotRanges: [0],
};

module.exports = schema;

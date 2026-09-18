/**
 * Ask Lens - schema adapter (v3)
 *
 * Reads the dashboard's own views so every number matches the Creative Hub.
 * Column names below are verified against the live schema, 2026-09-19.
 *
 * Metric hierarchy: CQR, then hook rate, then hold rate, then engagement
 * rate, then reach and video views. CTR/VTR/CPM/CPC are vanity: only on
 * explicit request.
 */

const schema = {
  tables: {
    creatives: 'creatives',
    paidMeta: 'v_paid_meta_creative',
    paidTiktok: 'v_paid_tiktok_creative',
    organicScored: 'v_organic_scored',
    organicBest: 'v_creative_organic_best',
    boostStatus: 'v_boost_status',
    organicRaw: 'organic_perf',
    paidDaily: 'creative_metrics_unified',
    accountMonthly: 'account_monthly',
    thresholds: 'cqr_thresholds',
    creators: 'creators',
    brands: 'brands',
  },

  creative: {
    id: 'creative_id', brand: 'brand_id', hook: 'content_hook', format: 'format',
    productRole: 'product_role', type: 'type', campaign: 'campaign',
    isRepurposed: 'is_repurposed', parentId: 'original_creative_id',
    publishedAt: 'date', durationS: 'duration_s', creatorId: 'creator_id',
    igLink: 'ig_link', fbLink: 'fb_link', ttLink: 'tt_link',
  },

  // v_paid_meta_creative / v_paid_tiktok_creative. Rates are 0-100 already.
  // spend is already in LKR (spend_raw + currency hold the original).
  paidView: {
    creativeId: 'creative_id', brand: 'brand_id', spend: 'spend', reach: 'reach',
    impressions: 'impressions', hookRate: 'hook_rate', holdRate: 'hold_rate',
    hookQ: 'hook_q', holdQ: 'hold_q', vtr: 'vtr', avgWatchTime: 'avg_watch_time',
    cqr: 'cqr', isActive: 'is_active', durationS: 'duration_s',
    w25: 'w25', w50: 'w50', w75: 'w75', w100: 'w100',
    verdict: 'verdict', working: 'working', notWorking: 'not_working',
    action: 'action', actionType: 'action_type', priority: 'priority',
    confidence: 'confidence', actionStatus: 'action_status',
  },

  organicView: {
    creativeId: 'creative_id', brand: 'brand_id', platform: 'platform', type: 'type',
    cqr: 'cqr', engagementRate: 'engagement_rate', retentionRate: 'retention_rate',
    avgWatchTime: 'avg_watch_time',
  },
  organicRawCols: {
    creativeId: 'creative_id', platform: 'platform', views: 'views', reach: 'reach',
    likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves',
    totalInteractions: 'total_interactions',
  },
  organicBest: { creativeId: 'creative_id', brand: 'brand_id', bestCqr: 'best_cqr', isValidated: 'is_validated', bestRank: 'best_rank' },
  boost: { creativeId: 'creative_id', brand: 'brand_id', onMeta: 'on_meta_paid', onTiktok: 'on_tt_paid', isBoosted: 'is_boosted' },
  thresholds: { brand: 'brand_id', platform: 'platform', metric: 'metric', minDur: 'min_duration', maxDur: 'max_duration', poorLt: 'poor_lt', goodGte: 'good_gte' },
  creator: { id: 'id', name: 'name', isActive: 'is_active' },

  merge: { cqr: 'best', hookRate: 'avg', holdRate: 'max', reach: 'max', spend: 'sum', impressions: 'sum' },
  cqrRank: { Good: 0, Average: 1, Poor: 2, Invalid: 3 },

  metricHierarchy: ['cqr', 'hook_rate', 'hold_rate', 'engagement_rate', 'reach', 'video_views'],
  vanityMetrics: ['ctr', 'vtr', 'cpm', 'cpc'],
  rankableMetrics: ['cqr', 'hook_rate', 'hold_rate', 'engagement_rate', 'reach', 'video_views', 'spend', 'impressions', 'avg_watch_time', 'vtr', 'ctr'],

  metricDisplay: {
    cqr: { label: 'CQR', type: 'cqr' },
    hook_rate: { label: 'Hook rate', type: 'pct', decimals: 1 },
    hold_rate: { label: 'Hold rate', type: 'pct', decimals: 1 },
    engagement_rate: { label: 'Engagement rate', type: 'pct', decimals: 2 },
    retention_rate: { label: 'Retention', type: 'pct', decimals: 1 },
    vtr: { label: 'VTR', type: 'pct', decimals: 1 },
    ctr: { label: 'CTR', type: 'pct', decimals: 2 },
    reach: { label: 'Reach', type: 'count' },
    video_views: { label: 'Video views', type: 'count' },
    impressions: { label: 'Impressions', type: 'count' },
    spend: { label: 'Spend', type: 'currency' },
    avg_watch_time: { label: 'Avg watch', type: 'seconds', decimals: 1 },
  },
  currency: 'LKR',

  // Flat floor. Lifetime impressions below this are not a signal.
  volumeFloor: { absoluteMin: 10000, relativeShare: 0 },

  // Table caps for very large brands.
  tableCap: { maxRows: 60, topBottom: 10 },

  // Data older than this many days shows a staleness note in the panel.
  staleAfterDays: 2,

  brands: ['dove', 'knorr', 'lifebuoy', 'lux', 'pears', 'ponds', 'sunsilk', 'surfexcel', 'vaseline'],
  brandLabels: { dove: 'Dove', knorr: 'Knorr', lifebuoy: 'Lifebuoy', lux: 'Lux', pears: 'Pears', ponds: 'Ponds', sunsilk: 'Sunsilk', surfexcel: 'Surf Excel', vaseline: 'Vaseline' },
  platforms: ['meta', 'tiktok'],
  organicPlatforms: ['facebook', 'instagram', 'tiktok'],
  platformLabels: { meta: 'Meta', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram' },

  model: 'claude-haiku-4-5',
  maxTokens: 700,
  historyTurnsVerbatim: 3,
  historyTurnsCompressed: 5,
  sessionTurnCap: 12,
  rateLimit: { perHour: 30, perDay: 200 },
  snapshotRanges: [0],
};

module.exports = schema;

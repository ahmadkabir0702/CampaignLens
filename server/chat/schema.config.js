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
    // Added October 2026. The assistant could not see any of these, so
    // "what was this creative's Pre-test Score", "which creatives are fatiguing"
    // and "has this rating moved" had no answer at all.
    brainsuiteJobs: 'brainsuite_jobs',
    brainsuiteResults: 'brainsuite_results',
    paidWindowed: 'v_paid_windowed',
    cqrHistory: 'cqr_history',
  },

  // brainsuite_jobs joined to brainsuite_results. One row per scored
  // creative; status matters because a job can be queued or failed and
  // then there is no score to talk about.
  brainsuite: {
    jobId: 'id', creativeId: 'creative_id', brand: 'brand_id', kind: 'kind',
    status: 'status', assetName: 'asset_name', createdAt: 'created_at',
    score: 'total_score', rating: 'total_rating', summary: 'summary',
  },

  // v_paid_windowed. One row per creative per platform per window, so a
  // creative's first week can be compared against its last.
  windowed: {
    creativeId: 'creative_id', brand: 'brand_id', platform: 'platform',
    windowName: 'window_name', fromDate: 'from_date', toDate: 'to_date',
    days: 'days', impressions: 'impressions', spend: 'spend',
    isActive: 'is_active', isCurrent: 'is_current',
    hookRate: 'hook_rate', holdRate: 'hold_rate', cqr: 'cqr',
  },

  // cqr_history. cqr is the windowed rating, which is the one that moves;
  // cqr_lifetime is what the rest of the app was showing at the time.
  cqrHistory: {
    creativeId: 'creative_id', brand: 'brand_id', channel: 'channel',
    platform: 'platform', cqr: 'cqr', cqrLifetime: 'cqr_lifetime',
  },

  creative: {
    id: 'creative_id', brand: 'brand_id', hook: 'content_hook', format: 'format',
    productRole: 'product_role', type: 'type', source: 'source', creatorLed: 'creator_led', campaign: 'campaign',
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

  // ---------------------------------------------------------------
  //  Grades and states are different things in the same column.
  //
  //  Good, Average and Poor are RATINGS. Everything else the column can
  //  hold is a STATE: a reason there is no rating yet. They arrive
  //  through cqr the same way, which is why this file used to treat the
  //  states as a fourth rating called Invalid.
  //
  //  That was not a gap, it was a wrong answer. A creative posted
  //  yesterday reported to a client as "Invalid", and a boosted post
  //  whose organic rating is withheld on purpose, because paid delivery
  //  contaminates the organic numbers, reported the same way.
  //
  //  Ranked only on the grades. A state has no place in an ordering,
  //  since it is not better or worse than anything, it is absent.
  // ---------------------------------------------------------------
  cqrGrades: ['Good', 'Average', 'Poor'],
  cqrRank: { Good: 0, Average: 1, Poor: 2 },

  // What each state means, in the words the assistant should use. It
  // reads these rather than inventing a gloss for a bare label.
  cqrStates: {
    'Boosted':       'spend went behind this post before there was enough organic data to rate it, so the paid rating is the one that applies',
    'Too Early':     'posted too recently to rate',
    'Counts Hidden': 'the platform is not returning the counts needed to rate it',
    'No Views':      'no views have come back yet',
    'No Duration':   'the video length is missing, so retention cannot be worked out',
    'No Watch Time': 'no watch time has come back yet',
    'No Threshold':  'no benchmark band covers this brand, platform and duration',
    'Invalid':       'could not be rated',
    'Invalid Data':  'the video length or the hook and hold numbers are missing, so it cannot be rated',
    'Low Delivery':  'it has had fewer than 10,000 paid impressions, which is too few to rate',
    'No Reach':      'no reach or views have come back yet for this photo or carousel',
    'No Followers':  'no follower count came back for this creator, which a photo or carousel is rated on',
    'Not Rated':     'photos and carousels have no paid rating, because the paid rating is built on video watch rates',
  },

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

  // Scale settings. Built for up to 1,000 creatives per brand per year.
  scale: {
    windowDays: 365,        // the chat analyses a rolling year; older creatives stay searchable
    recentDays: 90,         // used to check whether a finding still holds lately
    newDays: 30,            // "just published", always named individually
    creativeLines: 150,     // how many creatives the chat can name without a lookup
    tokenBudget: 12000,     // hard ceiling on a brand's data, whatever the archive size
  },

  // Table caps for very large brands.
  tableCap: { maxRows: 60, topBottom: 10 },

  // Data older than this many days shows a staleness note in the panel.
  staleAfterDays: 2,

  // Every brand Ask Lens will answer about. assertBrand throws on anything
  // absent here and routes.js refuses to pick it, so a brand missing from
  // this list is not merely unanswered, it is rejected. The six added in
  // October were rejected for exactly that reason.
  //
  // This wants to read the brands table rather than be a list someone has
  // to remember to edit. Left as a list for now because prewarm walks it
  // at boot, before a query is cheap to make.
  brands: [
    'cif', 'closeup', 'dove', 'knorr', 'lifebuoy', 'lux', 'pears', 'ponds',
    'rexona', 'signal', 'sunlight', 'sunsilk', 'surfexcel', 'vaseline', 'viva',
  ],
  brandLabels: {
    cif: 'Cif', closeup: 'Closeup', dove: 'Dove', knorr: 'Knorr',
    lifebuoy: 'Lifebuoy', lux: 'Lux', pears: 'Pears', ponds: 'Ponds',
    rexona: 'Rexona', signal: 'Signal', sunlight: 'Sunlight', sunsilk: 'Sunsilk',
    surfexcel: 'Surf Excel', vaseline: 'Vaseline', viva: 'Viva',
  },
  platforms: ['meta', 'tiktok'],
  organicPlatforms: ['facebook', 'instagram', 'tiktok'],
  platformLabels: {
    meta: 'Meta', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram',
    // Benchmark rows name the platform and the type together.
    meta_paid_bs: 'Meta paid, Brand Say', meta_paid_os: 'Meta paid, Others Say',
    tt_paid_bs: 'TikTok paid, Brand Say', tt_paid_os: 'TikTok paid, Others Say',
    ig_organic: 'Instagram organic, Brand Say', fb_organic: 'Facebook organic, Brand Say',
    tt_organic: 'TikTok organic, Brand Say',
  },

  model: 'claude-haiku-4-5',            // quick lookups
  // Analytical questions (why, what works, what should we do) go to Sonnet.
  // Override with ASK_LENS_ANALYSIS_MODEL if needed.
  analysisModel: process.env.ASK_LENS_ANALYSIS_MODEL || 'claude-sonnet-5',
  analysisMaxTokens: 1400,
  maxTokens: 700,
  historyTurnsVerbatim: 3,
  historyTurnsCompressed: 5,
  sessionTurnCap: 12,
  rateLimit: { perHour: 30, perDay: 200 },
  snapshotRanges: [0],
};

module.exports = schema;

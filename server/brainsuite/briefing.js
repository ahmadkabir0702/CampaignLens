/**
 * The briefing Brainsuite needs to start a job, and the values it accepts.
 *
 * Lists copied from the ACE Social Media Video (Meta & TikTok) OpenAPI
 * reference (ACE_VIDEO_SMV_PRO_UNILEVER_V2). Brainsuite rejects anything
 * outside them with a 422, after the upload, so everything is checked here
 * before a job is announced.
 */

const CHANNELS = {
  tiktok: 'TikTok',
  instagram_reel: 'Instagram Reel',
  instagram_story: 'Instagram Story',
  instagram_feed: 'Instagram Feed',
  facebook_reel: 'Facebook Reel',
  facebook_story: 'Facebook Story',
  facebook_feed: 'Facebook Feed',
  // YouTube is a separate app with its own endpoints (client.js picks it).
  youtube: 'YouTube',
  youtube_shorts: 'YouTube Shorts',
};

const isYouTubeChannel = c => c === 'youtube' || c === 'youtube_shorts';

const BUSINESS_GROUPS = [
  'Beauty & Wellbeing', 'Personal Care', 'Home Care', 'Nutrition', 'Ice Cream',
  'Food Solutions (UFS)', 'Upro',
];

const CATEGORIES = [
  'Air Wellness', 'Colour Cosmetics', 'Deodorants', 'Dishwash', 'Dove Masterbrand', 'Dressings',
  'Fabric Cleaning', 'Fabric Enhancers', 'Face Cleaner', 'Face Moisturizer', 'Floor Cleaner',
  'Functional Nutrition', 'Hair Care', 'Healthy Snacking', 'Home & Hygiene', 'Ice Cream', 'Lip Care',
  'Oral Care', 'Scratch Cooking Aids', 'Skin Care', 'Skin Cleansing', 'Tea, Coffee, RTD', 'Toilet Cleaner',
];

// Brainsuite has no Sinhala. English and Tamil are the two that fit Sri Lanka.
const LANGUAGES = { 'en-US': 'English', 'ta-IN': 'Tamil' };

const MARKET = process.env.BRAINSUITE_MARKET || 'Sri Lanka';

// Where the worker analysed the creative -> the closest Brainsuite placement.
// Every job is scored for all seven placements anyway; this one is the
// headline score.
function channelForPlatform(platform) {
  if (platform === 'tiktok') return 'tiktok';
  if (platform === 'facebook') return 'facebook_reel';
  return 'instagram_reel';
}

function contentOriginFor(type) {
  return type === 'Others Say' ? 'Creator' : 'Brand';
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function wordCount(s) {
  return clean(s, 2000).split(' ').filter(Boolean).length;
}

/**
 * Build and check a briefing. Throws an Error with a message fit to show a
 * user when something is missing or not on Brainsuite's lists.
 */
function buildBriefing({ channel, projectName, assetName, brandName, businessGroup, category,
                         contentType, language, keyMessage, ctaOverlay }) {
  if (!CHANNELS[channel]) throw new Error('Choose a placement.');
  if (!BUSINESS_GROUPS.includes(businessGroup) || !CATEGORIES.includes(category)) {
    throw new Error('This brand is not set up for pre-testing yet: it needs a business group and category.');
  }
  const lang = LANGUAGES[language] ? language : 'en-US';
  const input = {
    channel,
    projectName: clean(projectName, 120) || 'Campaign Lens',
    whichCompany: 'Unilever',
    market: MARKET,
    businessGroup,
    category,
    assetName: clean(assetName, 120) || 'asset',
    assetStage: 'finalVersion',
    assetOrigin: 'Local (BU)',
    contentOrigin: contentOriginFor(contentType),
    assetLanguage: lang,
    brandNames: [clean(brandName, 80) || 'Brand'],
  };
  // The YouTube app requires this: does the video use YouTube's own
  // call-to-action overlay (the clickable button over the ad)?
  if (isYouTubeChannel(channel)) {
    if (ctaOverlay !== 'yes' && ctaOverlay !== 'no') {
      throw new Error('Say whether the video uses YouTube\'s call-to-action overlay.');
    }
    input.platformCTAOverlay = ctaOverlay === 'yes' ? 'overlayPresent' : 'overlayAbsent';
  }
  const msg = clean(keyMessage, 600);
  if (msg) {
    if (wordCount(msg) > 50) throw new Error('Keep the key message to 50 words or fewer.');
    input.intendedMessages = [msg];
    input.intendedMessagesLanguage = 'en-US';
  }
  return input;
}

module.exports = {
  CHANNELS, BUSINESS_GROUPS, CATEGORIES, LANGUAGES, isYouTubeChannel,
  channelForPlatform, contentOriginFor, buildBriefing,
};

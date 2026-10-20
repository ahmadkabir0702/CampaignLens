/**
 * Rating for photo and carousel posts.
 *
 * A video is rated on retention (Brand Say) or interaction per view
 * (Others Say). A static has no watch time, and on Instagram no public
 * views either, so neither rule can run: every static would read
 * "No Duration" or "No Views" forever. This is the rule for them instead,
 * used by the dashboard payload and the organic panel alike, so the two
 * never disagree.
 *
 *   Brand Say   engagement (likes + comments + shares + saves) per reach,
 *               or per view where the platform gives views and no reach
 *   Others Say  (likes + 2 x comments) per view where there are views
 *               (TikTok photo posts have them), otherwise per follower
 *
 * Graded against static_thresholds (migration 022). Statics are only ever
 * compared with other statics.
 */
const STATIC_TYPES = new Set(['Photo', 'Carousel']);
const isStatic = (contentType) => STATIC_TYPES.has(String(contentType || ''));

const MIN_HOURS = 24;

const n = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));

/** The figure a static is rated on, and what it was divided by. */
function staticSignal(o, type, followers) {
  if (!o) return { value: null, basis: null, missing: 'no numbers' };
  if (o.likes === null || o.likes === undefined) return { value: null, basis: null, missing: 'counts hidden' };
  const likes = Number(o.likes) || 0;
  const comments = n(o.comments) || 0;

  if (type === 'Others Say') {
    const views = n(o.views);
    const fol = n(followers !== undefined ? followers : o.followers);
    const num = likes + 2 * comments;
    if (views) return { value: (num / views) * 100, basis: 'views', den: views };
    if (fol) return { value: (num / fol) * 100, basis: 'followers', den: fol };
    return { value: null, basis: null, missing: 'no followers' };
  }

  const total = n(o.total_interactions);
  const eng = total && total > 0 ? total
    : likes + comments + (n(o.shares) || 0) + (n(o.saves) || 0);
  const reach = n(o.reach), views = n(o.views);
  if (reach) return { value: (eng / reach) * 100, basis: 'reach', den: reach };
  if (views) return { value: (eng / views) * 100, basis: 'views', den: views };
  return { value: null, basis: null, missing: 'no reach' };
}

/**
 * Brand row first, then global. Within each, a row for this exact format
 * (Photo or Carousel) wins over one that covers both (content_type null).
 */
function pickBand(rows, brandId, plat, type, basis, contentType) {
  const list = (rows || []).filter((r) => r.platform === plat && r.creative_type === type && r.basis === basis
    && (!r.content_type || r.content_type === contentType));
  const exact = (r) => !!r.content_type && r.content_type === contentType;
  return list.find((r) => r.brand_id && r.brand_id === brandId && exact(r))
    || list.find((r) => r.brand_id && r.brand_id === brandId && !r.content_type)
    || list.find((r) => !r.brand_id && exact(r))
    || list.find((r) => !r.brand_id && !r.content_type)
    || null;
}

function gradeOf(value, band) {
  if (value === null || value === undefined || !band) return null;
  if (value >= Number(band.good_gte)) return 'Good';
  if (value < Number(band.poor_lt)) return 'Poor';
  return 'Average';
}

const STATE_LABEL = {
  'too early': 'Too Early',
  'counts hidden': 'Counts Hidden',
  'no reach': 'No Reach',
  'no followers': 'No Followers',
  'no threshold': 'No Threshold',
  'no numbers': null,
};

/**
 * The value for the rating column of a static: a grade, or the state that
 * explains why there is none, in the same words videos use.
 * storedCqr is what the database view said. A boosted static is rated like
 * any other: its organic numbers stop updating once it is boosted, so they
 * are from before the spend (migration 034).
 */
function rateStatic({ o, type, followers, plat, brandId, bands, storedCqr, postedAt, contentType }) {
  const posted = postedAt || (o && o.time_posted);
  if (posted && (Date.now() - new Date(posted).getTime()) / 3600000 < MIN_HOURS) {
    const s = staticSignal(o, type, followers);
    return { cqr: 'Too Early', grade: null, signal: s, band: null };
  }
  const s = staticSignal(o, type, followers);
  if (s.value === null) return { cqr: STATE_LABEL[s.missing] || null, grade: null, signal: s, band: null };
  const band = pickBand(bands, brandId, plat, type, s.basis, contentType);
  if (!band) return { cqr: 'No Threshold', grade: null, signal: s, band: null };
  const grade = gradeOf(s.value, band);
  return { cqr: grade, grade, signal: s, band };
}

/**
 * static_thresholds rows, or none if the migration has not been run.
 * select * so it reads content_type after migration 023 and still works
 * before it.
 */
async function loadBands(query, brandId) {
  try {
    const { rows } = await query(
      `select * from static_thresholds where brand_id is null or brand_id = $1`, [brandId]);
    return rows;
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

/** Follower counts per creative and platform; none if the column is missing. */
async function loadFollowers(query, brandId) {
  try {
    const { rows } = await query(
      `select o.creative_id, o.platform, o.followers
         from organic_perf o join creatives c on c.creative_id = o.creative_id
        where c.brand_id = $1 and o.followers is not null`, [brandId]);
    const out = {};
    for (const r of rows) (out[r.creative_id] ||= {})[r.platform] = Number(r.followers);
    return out;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return {};
    throw e;
  }
}

module.exports = { isStatic, staticSignal, pickBand, gradeOf, rateStatic, loadBands, loadFollowers, MIN_HOURS };

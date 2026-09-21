/**
 * content-check.js — are the links on one creative the same video?
 *
 * A creative can carry an Instagram, a TikTok and a Facebook link. They are
 * meant to be the same video on different platforms, and two things depend
 * on that being true:
 *   - Gemini analyses only ONE of them (Instagram, else TikTok, else
 *     Facebook). If another link is a different video, the creative's hook,
 *     segments and format describe a video that link's stats do not belong to.
 *   - Creator matching treats handles on one creative as the same person.
 *     A wrong link would merge two different creators.
 *
 * So each link is scraped once and compared against the one Gemini analyses.
 *
 *   Duration is the main test. The same video uploaded to two platforms
 *   comes out within about a second of the same length; two different
 *   videos almost never do.
 *
 *   Caption is the second. Creators often reuse a caption but also shorten
 *   it, translate it, or change hashtags per platform, so it is only used
 *   to decide when duration is missing, and to add context to a warning.
 *
 * Verdict for the creative:
 *   single     one link, nothing to compare
 *   same       every link matches the analysed one
 *   different  at least one link is clearly a different video
 *   unknown    could not tell (no duration, captions inconclusive)
 *   unchecked  could not run (no API key, or a link failed to load)
 */

const KEY = process.env.SCRAPECREATORS_API_KEY || null;

const ENDPOINT = {
  ig: 'https://api.scrapecreators.com/v1/instagram/post',
  tt: 'https://api.scrapecreators.com/v2/tiktok/video',
  fb: 'https://api.scrapecreators.com/v1/facebook/post',
};
const LABEL = { ig: 'Instagram', tt: 'TikTok', fb: 'Facebook' };

// Gemini analyses the first of these that exists. Must match routes.js,
// which queues `ig || tt || fb` as the media to analyse.
const ANALYSED_ORDER = ['ig', 'tt', 'fb'];

// Same length if within a second, or 5 percent for long videos, whichever
// is larger. Platforms re-encode and can shave a frame or two.
const DURATION_TOLERANCE_S = 1.0;
const DURATION_TOLERANCE_PCT = 0.05;

// Captions: share of the shorter caption's words also found in the longer.
const CAPTION_MATCH = 0.6;
const CAPTION_MIN_WORDS = 3;
// Cross-posts normally go up within a day or two of each other.
const POSTED_WITHIN_H = 72;

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Pull duration, caption, post time and handle out of each platform's shape. */
function extract(platform, body) {
  if (platform === 'ig') {
    const m = body && body.data && body.data.xdt_shortcode_media;
    if (!m) return null;
    const edges = (m.edge_media_to_caption && m.edge_media_to_caption.edges) || [];
    return {
      duration: num(m.video_duration),                        // seconds
      caption: (edges[0] && edges[0].node && edges[0].node.text) || '',
      postedAt: m.taken_at_timestamp ? m.taken_at_timestamp * 1000 : null,
      handle: m.owner && m.owner.username ? String(m.owner.username).toLowerCase() : null,
    };
  }
  if (platform === 'tt') {
    const d = body && body.aweme_detail;
    if (!d) return null;
    // video.duration is milliseconds. Do NOT use music.duration: that is the
    // length of the sound, which is often longer or shorter than the video.
    const ms = num(d.video && d.video.duration);
    return {
      duration: ms === null ? null : ms / 1000,
      caption: d.desc || '',
      postedAt: d.create_time ? d.create_time * 1000 : null,
      handle: d.author && d.author.unique_id ? String(d.author.unique_id).toLowerCase() : null,
    };
  }
  if (platform === 'fb') {
    if (!body || (!body.post_id && !body.url)) return null;
    return {
      duration: num(body.video && body.video.length_in_second),  // seconds
      caption: body.description || '',
      postedAt: body.creation_time ? Date.parse(body.creation_time) : null,
      handle: body.author && body.author.handle ? String(body.author.handle).toLowerCase() : null,
    };
  }
  return null;
}

async function fetchMeta(platform, url) {
  const u = `${ENDPOINT[platform]}?url=${encodeURIComponent(url)}`;
  const res = await fetch(u, {
    headers: { 'x-api-key': KEY },
    signal: AbortSignal.timeout(20000),
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !body || body.success === false) {
    throw new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
  }
  const meta = extract(platform, body);
  if (!meta) throw new Error('no post data in response');
  return meta;
}

// Words for caption comparison. Keeps letters in every script, including
// Sinhala and Tamil vowel signs, digits and hashtags. Links and mentions are
// dropped because they vary per platform for no reason.
function words(text) {
  const clean = String(text || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.]+/g, ' ');
  const tokens = clean.match(/[\p{L}\p{M}\p{N}#_]+/gu) || [];
  return new Set(tokens.filter(t => t.startsWith('#') ? t.length > 1 : t.length >= 3));
}

/** Share of the shorter caption's words present in the other. null if too short to judge. */
function captionScore(a, b) {
  const A = words(a), B = words(b);
  if (A.size < CAPTION_MIN_WORDS || B.size < CAPTION_MIN_WORDS) return null;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

function durationsMatch(a, b) {
  if (a === null || b === null) return null;
  const tol = Math.max(DURATION_TOLERANCE_S, DURATION_TOLERANCE_PCT * Math.max(a, b));
  return Math.abs(a - b) <= tol;
}

const fmtS = s => (s >= 90 ? `${Math.round(s / 60 * 10) / 10} min` : `${Math.round(s * 10) / 10} s`);

/** Compare one link against the analysed one. */
function comparePair(ref, other) {
  const dur = durationsMatch(ref.meta.duration, other.meta.duration);
  const cap = captionScore(ref.meta.caption, other.meta.caption);
  const capMatch = cap !== null && cap >= CAPTION_MATCH;

  if (dur === true) return { verdict: 'same', dur, cap };
  if (dur === false) {
    let msg = `${LABEL[ref.platform]} is ${fmtS(ref.meta.duration)} but ${LABEL[other.platform]} is `
            + `${fmtS(other.meta.duration)}, so these look like different videos.`;
    if (capMatch) msg += ' Their captions match, so this may be a different edit of the same content.';
    return { verdict: 'different', dur, cap, msg };
  }

  // No duration on one side: fall back to caption plus posting time.
  const t1 = ref.meta.postedAt, t2 = other.meta.postedAt;
  const close = t1 && t2 ? Math.abs(t1 - t2) <= POSTED_WITHIN_H * 3600 * 1000 : false;
  if (capMatch && close) return { verdict: 'same', dur, cap };
  return {
    verdict: 'unknown', dur, cap,
    msg: `Could not confirm ${LABEL[other.platform]} is the same video as ${LABEL[ref.platform]}.`,
  };
}

/**
 * links: { ig, tt, fb } normalised URLs (only the ones in use).
 * Returns { verdict, analysed, links: {platform: {duration, handle} | {error}}, pairs, warning }
 * Never throws: a failure to check must never stop a creative being added.
 */
async function checkContent(links) {
  const present = ANALYSED_ORDER.filter(p => links[p]);
  if (present.length < 2) return { verdict: 'single', analysed: present[0] || null, links: {}, pairs: [] };
  if (!KEY) return { verdict: 'unchecked', analysed: present[0], links: {}, pairs: [],
                     note: 'SCRAPECREATORS_API_KEY is not set on the server, so links were not compared.' };

  const results = await Promise.all(present.map(async p => {
    try { return { platform: p, meta: await fetchMeta(p, links[p]) }; }
    catch (e) { return { platform: p, error: e.message }; }
  }));

  const out = { analysed: present[0], links: {}, pairs: [] };
  for (const r of results) {
    out.links[r.platform] = r.error
      ? { error: r.error }
      : { duration: r.meta.duration, handle: r.meta.handle };
  }

  const ref = results[0];
  if (ref.error) {
    return { ...out, verdict: 'unchecked',
             note: `Could not load the ${LABEL[ref.platform]} post to compare against: ${ref.error}` };
  }

  let anyDifferent = false, anyUnknown = false, anyFailed = false;
  const messages = [];
  for (const other of results.slice(1)) {
    if (other.error) { anyFailed = true; continue; }
    const c = comparePair(ref, other);
    out.pairs.push({ with: other.platform, verdict: c.verdict,
                     durationMatch: c.dur, captionScore: c.cap === null ? null : Math.round(c.cap * 100) / 100 });
    if (c.verdict === 'different') { anyDifferent = true; messages.push(c.msg); }
    if (c.verdict === 'unknown') anyUnknown = true;
  }

  out.verdict = anyDifferent ? 'different' : (anyUnknown || anyFailed) ? 'unknown' : 'same';
  if (anyDifferent) out.warning = messages.join(' ');
  else if (anyFailed) out.note = 'One of the links could not be loaded to compare. It may be private or deleted.';
  return out;
}

module.exports = { checkContent, _test: { captionScore, durationsMatch, extract, comparePair } };

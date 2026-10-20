// =====================================================================
//  organic-validation.js — what an organic post is actually telling you
//
//  The Creative Hub used to show one thing for an organic post: CQR.
//  "Good" on its own does not tell a planner why it is good, whether it
//  is good by this brand's standards, which platform earned it, or
//  whether anything about the content explains it. This builds all of
//  that from data already in the database:
//
//    1. Why it got that rating — retention and engagement judged
//       separately against the same thresholds that produced the CQR,
//       because Good-on-retention / weak-on-engagement is a different
//       proposition from the reverse.
//    2. Where it sits against the brand's own organic this quarter.
//    3. A recommendation per platform, not one for the post, because a
//       post that works on TikTok and not on Instagram is two decisions.
//    4. Velocity from organic_perf_history — is it still climbing.
//    5. What it has in common with past paid winners, using the tags.
//
//  Honest about gaps: too little delivery, too new to judge, and a
//  platform that returned no data are reported as such, never as weak.
//
//  Nothing here invents a number. Every figure is read; every verdict
//  comes from a threshold row or a comparison against real posts.
// =====================================================================
const { query } = require('./db');
const V = require('./server/chat/vocab');
const SR = require('./server/static-rating');

/**
 * Run a query, and if Postgres reports a column that does not exist,
 * run it again without that column.
 *
 * A migration that has not been applied yet should cost the panel one
 * feature, not take it down. The chat side does the same thing for the
 * same reason, after a missed migration took it offline for every brand.
 */
const warnedColumns = new Set();
async function queryTolerant(sql, params) {
  try {
    return await query(sql, params);
  } catch (err) {
    const m = err && err.code === '42703' && /column (?:\w+\.)?"?([a-z0-9_]+)"? does not exist/i.exec(err.message || '');
    if (!m) throw err;
    const col = m[1];
    if (!warnedColumns.has(col)) {
      console.warn(`[organic-validation] ${col} is missing, continuing without it. Run the pending migration.`);
      warnedColumns.add(col);
    }
    const stripped = sql
      .split('\n')
      .map((line) => line.replace(new RegExp(`\\s*[a-z]+\\.${col}\\s*(?:as\\s+\\w+)?\\s*,`, 'gi'), ' ')
                         .replace(new RegExp(`,\\s*[a-z]+\\.${col}\\s*(?:as\\s+\\w+)?\\s*$`, 'gi'), ''))
      .join('\n');
    if (stripped === sql) throw err;
    return queryTolerant(stripped, params);
  }
}

// A post below this many views has not been delivered enough to judge.
// Organic reach is granted by the algorithm, so the floor is far lower
// than the 10,000 paid-impression floor.
const VIEW_FLOOR = 1000;
// Before this many hours a post is still being distributed.
const MIN_HOURS = 24;
// The window "this quarter" means when placing a post against its peers.
const STANDING_DAYS = 90;
// Fewest peers needed before a standing is worth stating.
const STANDING_MIN = 8;
// Fewest creatives on each side before a tag comparison is worth stating.
const TAG_MIN = 2;

/**
 * How the organic rating is actually decided.
 *
 * Read from cqr_organic_label(), which is the only thing that produces a
 * CQR. The panel mirrors it exactly rather than inventing a parallel
 * judgement, because two different answers to "is this good" is worse
 * than one imperfect one.
 *
 * There are not two halves. Each type is rated on ONE signal:
 *
 *   Brand Say    retention = avg_watch_time / duration * 100
 *                graded against thr(brand, <plat>_organic, 'retention_rate', dur)
 *                engagement plays no part at all
 *
 *   Others Say   interaction = (likes + 2 * comments) / views * 100
 *                graded against cqr_os_benchmarks for that platform
 *                retention plays no part, and is never reported anyway
 *
 * Two traps worth naming. The Others Say figure is NOT
 * v_organic_scored.engagement_rate: that column weights shares and saves
 * as well and is stored as a ratio, so it is a different number from the
 * one the rating uses. And Others Say reads its thresholds from
 * cqr_os_benchmarks, not from cqr_thresholds, so the _os rows in
 * cqr_thresholds do not drive the CQR.
 */
const isOthersSay = (type) => type === 'Others Say';

// The signal the rating is based on, computed the way the function does.
function ratingSignal(o, type, durationS) {
  if (isOthersSay(type)) {
    const views = num(o.views);
    if (!views) return null;
    if (o.likes === null || o.likes === undefined) return null;
    return ((Number(o.likes) + 2 * (num(o.comments) || 0)) / views) * 100;
  }
  const dur = Number(durationS);
  if (!isFinite(dur) || dur === 0) return null;
  if (o.avg_watch_time === null || o.avg_watch_time === undefined) return null;
  return (Number(o.avg_watch_time) / dur) * 100;
}

// Internal only. signalName picks which wording set describes the grade;
// it is never sent to the browser. signalNote described the formula in
// words and was rendered in the panel, so it is gone rather than merely
// unused: the comment block at the top of this file is where the method
// is documented, for people reading the source.
const signalName = (type, isStatic) => (isStatic ? 'Engagement' : isOthersSay(type) ? 'Interaction' : 'Retention');

/**
 * Every value cqr_organic_label can return that is not a grade, and what
 * it means in words. These used to be rendered as if they were ratings,
 * producing lines like "Rated No Watch Time on engagement".
 */
const CQR_STATES = {
  'boosted':        'Spend went behind this post before there was enough organic data to rate it.',
  'too early':      `Posted less than ${MIN_HOURS} hours ago, so it is still being distributed.`,
  'counts hidden':  'The account has hidden its like counts, so there is nothing to rate.',
  'no views':       'No views have come back for this post.',
  'no duration':    'The video length is missing, so retention cannot be worked out.',
  'no watch time':  'No average watch time came back, which is what the rating is based on.',
  'no threshold':   'No benchmark is set for this platform, so there is nothing to rate against.',
  'no reach':       'No reach or views have come back for this post, which is what a photo or carousel is rated on.',
  'no followers':   'No follower count came back for this account, which is what a photo or carousel is rated on.',
};
const stateOf = (cqr) => CQR_STATES[String(cqr || '').toLowerCase()] ? String(cqr) : null;
const gradeOnly = (cqr) => (S_RANK[cqr] === undefined ? null : cqr);
const isBoostedState = (cqr) => String(cqr || '').toLowerCase() === 'boosted';

const PLATFORM = {
  ig: { label: 'Instagram', linkField: 'ig_link' },
  fb: { label: 'Facebook',  linkField: 'fb_link' },
  tt: { label: 'TikTok',    linkField: 'tt_link' },
};

const num = (v) => (v === null || v === undefined ? null : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const pct = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

// Threshold rows encode Brand Say / Others Say in the platform string.
function platformKey(plat, type) {
  return `${plat}_${type === 'Others Say' ? 'os' : 'organic'}`;
}

// ---------------------------------------------------------------------
//  Threshold lookup. Mirrors the thr() SQL function, in JS, so one read
//  covers every platform and metric this post needs. A band runs from its
//  min up to, not including, its max, as thr() reads it. Brand-specific
//  rows win over globals; metric names are matched by prefix so
//  'retention' and 'retention_rate' both resolve.
// ---------------------------------------------------------------------
function pickThreshold(rows, platKey, metricPrefix, durationS) {
  const d = Number(durationS);
  const candidates = rows.filter((r) =>
    r.platform === platKey &&
    String(r.metric || '').toLowerCase().startsWith(metricPrefix) &&
    (r.min_duration === null || !isFinite(d) || d >= Number(r.min_duration)) &&
    (r.max_duration === null || !isFinite(d) || d < Number(r.max_duration)));
  if (!candidates.length) return null;
  // Brand rows first, then the narrowest duration band.
  candidates.sort((a, b) => {
    const brand = (a.brand_id ? 0 : 1) - (b.brand_id ? 0 : 1);
    if (brand) return brand;
    const span = (x) => (x.max_duration === null ? 1e9 : Number(x.max_duration)) -
                        (x.min_duration === null ? 0 : Number(x.min_duration));
    return span(a) - span(b);
  });
  return candidates[0];
}

function grade(rate, th) {
  if (rate === null || rate === undefined || !th) return null;
  const v = Number(rate);
  const poorLt = th.poor_lt === null ? null : Number(th.poor_lt);
  const goodGte = th.good_gte === null ? null : Number(th.good_gte);
  if (goodGte !== null && v >= goodGte) return 'Good';
  if (poorLt !== null && v < poorLt) return 'Poor';
  return 'Average';
}

// ---------------------------------------------------------------------
//  1. Why it got that rating
// ---------------------------------------------------------------------
const S_RANK = { Good: 0, Average: 1, Poor: 2 };

// v_organic_scored used to return 'Boosted' in the cqr column for a creator
// post with spend behind it. Since migration 034 it rates the post on its
// organic numbers, which stop updating once it is boosted, so they are from
// before the spend. Whether a post is boosted comes from v_boost_status.

// How the rating reads, in words. One signal, not two halves.
/**
 * What the rating means, in terms of what the audience did.
 *
 * These describe behaviour, not arithmetic. The metric a rating is built
 * from, the weights inside it and the thresholds it is graded against are
 * the product's own method and are never stated in the UI or sent to the
 * browser. See the note on buildValidation for why hiding them in the
 * render layer would not have been enough.
 */
const SIGNAL_WORDS = {
  Retention: {
    Good: 'people watch most of it before dropping off',
    Average: 'people watch some of it, then leave part way',
    Poor: 'people drop off early',
  },
  Interaction: {
    Good: 'people do something after watching, not just scroll past',
    Average: 'some people respond to it, but not many',
    Poor: 'almost nobody responds to it',
  },
  Engagement: {
    Good: 'people stop on it and respond, rather than scroll past',
    Average: 'some people respond to it, but not many',
    Poor: 'almost nobody who saw it responded',
  },
};

function reasonFor({ rated, state, signal, band, signalName, type, boosted }) {
  // Boosted is not a verdict with a footnote, it is a different question.
  //
  // This used to read "Rated Average: some people respond to it, but not
  // many. Spend went behind this post, so its numbers are organic and
  // paid together." A confident grade, then a sentence explaining that
  // the numbers behind the grade are contaminated. Once there is spend
  // the organic rating is history, so it is worded as history.
  if ((boosted && rated) || String(state || '').toLowerCase() === 'boosted') {
    const words = rated ? ((SIGNAL_WORDS[signalName] || {})[rated] || '') : '';
    return rated
      ? `Rated ${rated} on its organic numbers from before the boost${words ? `: ${words}` : ''}. From here it is a paid read.`
      : 'Spend went behind this post before there was enough organic data to rate it. From here it is a paid read.';
  }

  if (!rated) {
    return state
      ? CQR_STATES[state.toLowerCase()]
      : 'There is not yet enough of the right data back from this platform to rate it.';
  }
  const words = (SIGNAL_WORDS[signalName] || {})[rated] || '';
  const stateLine = state ? ` ${CQR_STATES[state.toLowerCase()]}` : '';
  return `Rated ${rated}${words ? `: ${words}` : ''}.${stateLine}`;
}

// ---------------------------------------------------------------------
//  2. Where it sits against the brand's own organic
// ---------------------------------------------------------------------
/**
 * Where it sits against the brand's own posts.
 *
 * This is a different question from the rating, and the two can disagree
 * honestly: the rating is against a fixed threshold, the standing is
 * against your own output. A post read "Good" and "among your weakest"
 * at the same time, which looks like a contradiction until you know
 * that. The wording now says which comparison it is making.
 */
function standingWords(percentile) {
  if (percentile === null) return null;
  if (percentile >= 90) return 'ahead of almost all your own organic posts this quarter';
  if (percentile >= 70) return 'ahead of most of your own organic posts this quarter';
  if (percentile >= 40) return 'about level with your own organic posts this quarter';
  if (percentile >= 20) return 'behind most of your own organic posts this quarter';
  return 'behind almost all your own organic posts this quarter';
}

// ---------------------------------------------------------------------
//  Dimensions
//
//  What the panel shows in place of the rating method.
//
//  Four of them, as ranks against the brand's own posts rather than as
//  values against a threshold. A rank says how good without saying what
//  good is, and four of them together mean the one the rating is built
//  from is no longer identifiable: showing a single labelled metric
//  pointed straight at the method.
//
//  Every dimension except reach is a rate rather than a count, because a
//  count is mostly a function of how many people saw it. Ranking raw
//  likes would rank distribution twice and tell you nothing about the
//  creative.
//
//  No composite score is produced from these on purpose. Publishing a
//  composite alongside its parts makes the weights solvable from thirty
//  creatives and a spreadsheet, which would hand back the method these
//  replaced. The grade stays the single verdict.
// ---------------------------------------------------------------------
const rate = (num, den) => {
  const n = Number(num), d = Number(den);
  if (!isFinite(n) || !isFinite(d) || d <= 0) return null;
  return (n / d) * 100;
};
const anyOf = (o, ...fields) => {
  for (const f of fields) {
    const v = o ? o[f] : null;
    if (v !== null && v !== undefined) return Number(v);
  }
  return null;
};
const engagementsOf = (o) => {
  if (!o) return null;
  // A hidden like count arrives as 0, which is not a count of zero.
  if (o.likes === null || o.likes === undefined) return null;
  const t = anyOf(o, 'total_interactions');
  if (t !== null && t > 0) return t;
  return ['likes', 'comments', 'shares', 'saves']
    .reduce((s, f) => s + (Number(o[f]) || 0), 0);
};

const DIMENSIONS = [
  {
    key: 'reach',
    // Labelled for whichever figure the platform actually returns, rather
    // than calling views reach and hoping nobody checks.
    label: (plat, reports) => (reports(plat, 'reach') ? 'Reach' : 'Views'),
    value: (o, dur, plat, reports) =>
      reports(plat, 'reach') ? anyOf(o, 'reach') : anyOf(o, 'views'),
  },
  {
    key: 'engagement',
    label: () => 'Engagement',
    // Per view; per person reached when there are no views (a photo).
    value: (o) => rate(engagementsOf(o), anyOf(o, 'views', 'reach')),
  },
  {
    key: 'watch',
    label: () => 'Watch-through',
    // Instagram and Facebook never return watch time on organic posts, so
    // this one drops out rather than showing an empty bar on every post.
    value: (o, dur) => {
      const w = anyOf(o, 'avg_watch_time');
      return (w === null || !dur) ? null : rate(w, dur);
    },
  },
  {
    key: 'spread',
    label: () => 'Saves and shares',
    value: (o) => {
      if (!o) return null;
      const s = anyOf(o, 'shares'), sv = anyOf(o, 'saves');
      if (s === null && sv === null) return null;
      return rate((s || 0) + (sv || 0), anyOf(o, 'views', 'reach'));
    },
  },
];

const BAND_WORD = (pct) => (pct >= 70 ? 'strong' : pct >= 40 ? 'steady' : 'weak');

const n0 = (v) => Number(v || 0).toLocaleString('en-US');
/** "no comments" rather than "0 comments", which reads as a missing value. */
const countWord = (v, one, many) => {
  const n = Number(v || 0);
  return n === 0 ? `no ${many}` : `${n0(n)} ${n === 1 ? one : many}`;
};

/**
 * What each dimension looked like, in counts rather than in the rate the
 * rank was computed from. The rank says where it sits; this says what
 * actually happened, which is the half a percentile cannot carry.
 */
function countPhrase(key, o, dur, platLabel) {
  switch (key) {
    case 'reach': {
      const v = anyOf(o, 'views');
      const r = anyOf(o, 'reach');
      // Duration belongs with watch-through, not with distribution: "on a
      // 95 second cut" attached to a reach figure implies the length had
      // something to do with how far it travelled.
      const views = v === null ? null : `${n0(v)} views`;
      const reach = r === null ? null : `${n0(r)} reached`;
      return [reach, views].filter(Boolean).join(' from ');
    }
    case 'engagement':
      return [countWord(anyOf(o, 'likes'), 'like', 'likes'),
              countWord(anyOf(o, 'comments'), 'comment', 'comments')].join(', ');
    case 'watch': {
      const w = anyOf(o, 'avg_watch_time');
      if (w === null || !dur) return null;
      return `watched for ${Math.round(w)} seconds of ${Math.round(dur)} on average`;
    }
    case 'spread':
      return [countWord(anyOf(o, 'shares'), 'share', 'shares'),
              countWord(anyOf(o, 'saves'), 'save', 'saves')].join(', ');
    default: return null;
  }
}

const STANDING_PHRASE = (pct, platLabel) =>
  pct >= 70 ? `ahead of most of your ${platLabel} posts this quarter`
: pct >= 40 ? `about level with your ${platLabel} posts this quarter`
            : `behind most of your ${platLabel} posts this quarter`;

/**
 * The two statements that replaced the rating sentence.
 *
 * Built from the strongest and weakest dimension, so they are specific to
 * this post rather than a restatement of the grade. Both carry counts,
 * because "some people respond to it, but not many" is the shape of
 * sentence this is meant to stop producing.
 */
function workingPair(dims, o, dur, platLabel) {
  if (dims.length < 2) return { working: null, notWorking: null };
  const sorted = [...dims].sort((a, b) => b.percentile - a.percentile);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const line = (d) => {
    const phrase = countPhrase(d.key, o, dur, platLabel);
    if (!phrase) return null;
    return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}, ${STANDING_PHRASE(d.percentile, platLabel)}.`;
  };
  return { working: line(top), notWorking: line(bottom) };
}

/** Each dimension as a rank, dropping the ones this platform cannot report. */
function dimensionsFor(o, dur, plat, peers, reports) {
  const out = [];
  for (const d of DIMENSIONS) {
    const mine = d.value(o, dur, plat, reports);
    if (mine === null) continue;
    const peerVals = peers
      .map((p) => d.value(p, p.duration_s, plat, reports))
      .filter((v) => v !== null);
    const { percentile, peers: n } = placeAmong(mine, peerVals);
    if (percentile === null) continue;
    out.push({ key: d.key, label: d.label(plat, reports), percentile, peers: n });
  }
  return out;
}

/** "Strong reach, weak engagement." from the best and worst ranks. */
function dimensionSummary(dims) {
  if (dims.length < 2) return null;
  const sorted = [...dims].sort((a, b) => b.percentile - a.percentile);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  // Nothing separates them, so naming a best and a worst would invent a
  // contrast the numbers do not support.
  if (top.percentile - bottom.percentile < 20) {
    return `${BAND_WORD(top.percentile)} across the board`.replace(/^./, (ch) => ch.toUpperCase()) + '.';
  }
  const word = (d) => `${BAND_WORD(d.percentile)} ${d.label.toLowerCase()}`;
  return `${word(top)}, ${word(bottom)}.`.replace(/^./, (ch) => ch.toUpperCase());
}

function placeAmong(value, peers) {
  const vals = peers.filter((v) => v !== null && v !== undefined && isFinite(v)).map(Number);
  if (value === null || value === undefined || vals.length < STANDING_MIN) {
    return { percentile: null, peers: vals.length };
  }
  const below = vals.filter((v) => v < Number(value)).length;
  return { percentile: Math.round((below / vals.length) * 100), peers: vals.length };
}

// ---------------------------------------------------------------------
//  3. Recommendation, per platform
// ---------------------------------------------------------------------
function recommendFor({ platLabel, rated, state, standing, delivered, tooNew, missing, boosted }) {
  if (missing) {
    return { action: 'no_data', confidence: 'none',
      text: `No ${platLabel} numbers have come back for this post, so there is nothing to judge yet. That is not the same as a weak post.` };
  }
  // Already running. The rating still shows, but the decision is made.
  if (boosted || String(state || '').toLowerCase() === 'boosted') {
    return { action: 'already_boosted', confidence: rated ? 'medium' : 'none',
      text: rated
        ? `Already running on ${platLabel}. The organic rating of ${rated} is what it earned before the spend; judge it from here on its paid performance.`
        : `Already running on ${platLabel}. Judge it on its paid performance.` };
  }
  if (tooNew) {
    return { action: 'wait', confidence: 'none',
      text: `Under ${MIN_HOURS} hours old on ${platLabel}. Distribution is still running, so leave it and read it again tomorrow.` };
  }
  if (!delivered) {
    return { action: 'wait', confidence: 'none',
      text: `Too little delivery on ${platLabel} to judge yet. Wait rather than act on this.` };
  }
  if (!rated) {
    return { action: 'no_grade', confidence: 'none',
      text: state
        ? `${CQR_STATES[state.toLowerCase()]} Nothing to act on for ${platLabel} yet.`
        : `No benchmark is set for ${platLabel}, so this cannot be rated. Adding one will make the rating appear on its own.` };
  }

  const strong = standing && standing.percentile !== null && standing.percentile >= 70;
  const weak = standing && standing.percentile !== null && standing.percentile < 30;

  if (rated === 'Good') {
    return { action: 'boost', confidence: strong ? 'high' : 'medium',
      text: `Boost on ${platLabel}.${strong ? ' It is one of your stronger organic posts this quarter, so it has earned the spend.' : ' It cleared the bar organically.'}` };
  }
  if (rated === 'Poor') {
    return { action: 'hold', confidence: weak ? 'high' : 'medium',
      text: `Do not put spend behind this on ${platLabel}. It did not earn attention organically, and paid reach will not fix that.` };
  }
  return { action: 'hold', confidence: 'low',
    text: `Middling on ${platLabel}.${strong ? ' It still sits in the stronger half of your organic this quarter, so it is a reasonable second choice.' : ' Not weak, but not a case for spend ahead of a stronger post either.'}` };
}

// ---------------------------------------------------------------------
//  4. Velocity, from the history table
// ---------------------------------------------------------------------
async function velocityFor(creativeId) {
  try {
    const { rows } = await query(
      `select platform, captured_at, views, total_interactions
         from organic_perf_history
        where creative_id = $1
        order by platform, captured_at`, [creativeId]);
    const byPlat = {};
    for (const r of rows) (byPlat[r.platform] ||= []).push(r);
    const out = {};
    for (const [plat, pts] of Object.entries(byPlat)) {
      if (pts.length < 2) { out[plat] = { points: pts.length, text: null }; continue; }
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const gained = num(last.views) - num(prev.views);
      const hours = (new Date(last.captured_at) - new Date(prev.captured_at)) / 3600000;
      const share = num(last.views) ? gained / num(last.views) : 0;
      out[plat] = {
        points: pts.length,
        since: pts[0].captured_at,
        gained_views: gained,
        hours_between: r1(hours),
        still_climbing: share >= 0.02,
        text: share >= 0.02
          ? `Still picking up views — it added ${gained.toLocaleString()} in the last ${Math.max(1, Math.round(hours))} hours, so the rating may yet improve.`
          : `Views have flattened, so this rating is close to final.`,
      };
    }
    return out;
  } catch (err) {
    // Migration 006 not run yet. History is an addition, not a dependency.
    if (err.code === '42P01') return {};
    throw err;
  }
}

// ---------------------------------------------------------------------
//  5. What it has in common with past paid winners
//
//  For each element this post carries, compare the brand's paid
//  creative-platform pairs that share it against those that do not, on
//  the share rated Good. Same gate as the nightly element analysis: at
//  least two distinct creatives on each side and a real gap, otherwise
//  it is noise dressed as a reason.
// ---------------------------------------------------------------------
function winnerMatches(creative, paidUnits) {
  if (!paidUnits.length) return { matches: [], supports: 0, against: 0, basis: 0 };
  const valueOf = (c, f) => (f === 'length_bucket' ? V.lengthBucket(c.duration_s) : c[f]);
  const distinct = (us) => new Set(us.map((u) => u.id)).size;
  const goodRate = (us) => (us.length ? (us.filter((u) => u.cqr === 'Good').length / us.length) * 100 : 0);
  const matches = [];

  for (const el of V.ELEMENTS) {
    const mine = valueOf(creative, el.field);
    if (mine === null || mine === undefined || mine === '') continue;
    if (el.kind === 'bool' && mine !== true) continue;   // only "has it" is an element

    const known = paidUnits.filter((u) => {
      const v = valueOf(u, el.field);
      return v !== null && v !== undefined && v !== '';
    });
    const withU = known.filter((u) => valueOf(u, el.field) === mine);
    const withoutU = known.filter((u) => valueOf(u, el.field) !== mine);
    const nW = distinct(withU), nO = distinct(withoutU);
    if (nW < TAG_MIN || nO < TAG_MIN) continue;

    const gW = goodRate(withU), gO = goodRate(withoutU);
    const diff = gW - gO;
    if (Math.abs(diff) < 10) continue;                   // no real difference

    matches.push({
      key: el.kind === 'bool' ? el.field : `${el.field}=${mine}`,
      label: V.elementLabel(el, mine),
      timing: el.timing,
      helps: diff > 0,
      with: { creatives: nW, goodRate: Math.round(gW) },
      without: { creatives: nO, goodRate: Math.round(gO) },
      strength: Math.abs(diff),
      early: Math.min(nW, nO) < 5,
    });
  }
  matches.sort((a, b) => b.strength - a.strength);
  return {
    matches,
    supports: matches.filter((m) => m.helps).length,
    against: matches.filter((m) => !m.helps).length,
    basis: distinct(paidUnits),
  };
}

function matchSentence(m) {
  const when = m.timing === 'opening' ? 'in the opening' : 'across the video';
  return m.helps
    ? `${m.label} — ${when}, your paid creatives with this are rated Good more often than those without.${m.early ? ' Early sign, small groups.' : ''}`
    : `${m.label} — ${when}, your paid creatives with this are rated Good less often than those without.${m.early ? ' Early sign, small groups.' : ''}`;
}

// ---------------------------------------------------------------------
//  Facebook reaction breakdown
//
//  The only sentiment signal the official APIs give without reading
//  anyone's comments. A like and an angry both count as one reaction in
//  the totals, so a post can look engaged while the engagement is people
//  objecting to it. Wow is left out of both sides: it reads as surprise,
//  which is not a verdict either way.
// ---------------------------------------------------------------------
const REACTIONS = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];
const REACTION_LABEL = { like: 'Like', love: 'Love', haha: 'Haha', wow: 'Wow', sad: 'Sad', angry: 'Angry' };
// Below this many reactions the split is noise, not a mood.
const REACTION_MIN = 50;

function reactionRead(o) {
  const counts = {};
  let total = 0;
  for (const r of REACTIONS) {
    const v = o[`reaction_${r}`];
    if (v === null || v === undefined) continue;
    counts[r] = Number(v);
    total += Number(v);
  }
  if (!Object.keys(counts).length) return null;

  const positive = (counts.like || 0) + (counts.love || 0) + (counts.haha || 0);
  const negative = (counts.sad || 0) + (counts.angry || 0);
  const negShare = total ? (negative / total) * 100 : 0;
  const warm = (counts.love || 0) + (counts.haha || 0);

  let verdict;
  if (total < REACTION_MIN) {
    verdict = `Only ${total.toLocaleString()} reactions so far, too few to read a mood from.`;
  } else if (negShare >= 10) {
    verdict = `${Math.round(negShare)}% of reactions are sad or angry. That is high enough to read the post before putting spend behind it, because those reactions count towards engagement exactly like a like does.`;
  } else if (warm / total >= 0.25) {
    verdict = `Reactions skew warm rather than polite: ${Math.round((warm / total) * 100)}% are love or haha rather than a plain like. People felt something.`;
  } else {
    verdict = 'Reactions are almost all plain likes, so there is no strong feeling either way.';
  }

  return {
    counts,
    total,
    rows: REACTIONS.filter((r) => counts[r] !== undefined)
      .map((r) => ({ key: r, label: REACTION_LABEL[r], count: counts[r],
                     share: total ? Math.round((counts[r] / total) * 100) : 0 })),
    positive, negative,
    negative_share: Math.round(negShare * 10) / 10,
    enough: total >= REACTION_MIN,
    verdict,
  };
}

// ---------------------------------------------------------------------
//  The build
// ---------------------------------------------------------------------
async function buildValidation(brandId, creativeId) {
  // The peer query needs this creative's type, so that one read comes
  // first and the rest run together behind it.
  const typeR = await query(
    `select type, content_type from creatives where creative_id = $1 and brand_id = $2`,
    [creativeId, brandId]);
  if (!typeR.rows.length) return null;
  const creativeType = typeR.rows[0].type;

  const creativeIsStatic = SR.isStatic(typeR.rows[0].content_type);

  const [creativeR, organicR, thresholdR, osBenchR, peerR, staticBands, paidR, boostR] = await Promise.all([
    queryTolerant(
      `select c.creative_id, c.brand_id, c.type, c.content_type, c.campaign, c.date, c.duration_s,
              c.ig_link, c.fb_link, c.tt_link,
              c.format, c.product_role, c.content_intent, c.narrative_structure,
              c.hook_device, c.hook_subject, c.hook_pace, c.language, c.talent,
              c.production_style, c.aspect_ratio,
              c.opens_with_face, c.opens_with_product, c.logo_first_3s,
              c.has_text_overlay, c.captions, c.voiceover, c.music, c.cta
         from creatives c
        where c.creative_id = $1 and c.brand_id = $2`, [creativeId, brandId]),

    queryTolerant(
      `select o.platform, o.views, o.reach, o.likes, o.comments, o.shares, o.saves,
              o.total_interactions, o.avg_watch_time, o.time_posted, o.followers,
              o.reaction_like, o.reaction_love, o.reaction_haha,
              o.reaction_wow, o.reaction_sad, o.reaction_angry,
              s.cqr, s.engagement_rate, s.retention_rate
         from organic_perf o
         left join v_organic_scored s
           on s.creative_id = o.creative_id and s.platform = o.platform
        where o.creative_id = $1`, [creativeId]),

    query(
      `select brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte
         from cqr_thresholds
        where brand_id = $1 or brand_id is null`, [brandId]),

    // Others Say is rated against its own table, not cqr_thresholds.
    // A missing table is survivable: the panel then says no benchmark.
    // select * so this reads brand_id after migration 028 and still works
    // before it.
    query(`select * from cqr_os_benchmarks`)
      .catch(() => ({ rows: [] })),

    // The brand's own organic, same window, for the standing. Like for
    // like on type as well as platform: the two types are rated on
    // different signals, so a mixed pool produces a meaningless
    // percentile. The raw counts come too, because the standing is
    // computed from the same signal the rating uses, not from the view.
    // Statics are compared only with statics, and videos only with videos.
    queryTolerant(
      `select o.platform, o.views, o.reach, o.likes, o.comments, o.shares, o.saves,
              o.total_interactions, o.avg_watch_time, c.duration_s, o.followers
         from organic_perf o
         join creatives c on c.creative_id = o.creative_id
        where c.brand_id = $1
          and c.creative_id <> $2
          and c.type is not distinct from $4
          and (coalesce(c.content_type, 'Video') in ('Photo', 'Carousel')) = $5
          and (c.date is null or c.date >= current_date - ($3)::int)`,
      [brandId, creativeId, STANDING_DAYS, creativeType, creativeIsStatic]),

    SR.loadBands(query, brandId),

    // Paid creative-platform pairs with their tags, for the winners match.
    query(
      `select c.creative_id as id, c.duration_s, c.format, c.product_role,
              c.content_intent, c.narrative_structure, c.hook_device, c.hook_subject,
              c.hook_pace, c.language, c.talent, c.production_style, c.aspect_ratio,
              c.opens_with_face, c.opens_with_product, c.logo_first_3s,
              c.has_text_overlay, c.captions, c.voiceover, c.music, c.cta, c.type,
              v.cqr, v.impressions
         from v_paid_meta_creative v
         join creatives c on c.creative_id = v.creative_id
        where v.brand_id = $1 and v.creative_id is not null and v.impressions >= 10000
       union all
       select c.creative_id as id, c.duration_s, c.format, c.product_role,
              c.content_intent, c.narrative_structure, c.hook_device, c.hook_subject,
              c.hook_pace, c.language, c.talent, c.production_style, c.aspect_ratio,
              c.opens_with_face, c.opens_with_product, c.logo_first_3s,
              c.has_text_overlay, c.captions, c.voiceover, c.music, c.cta, c.type,
              v.cqr, v.impressions
         from v_paid_tiktok_creative v
         join creatives c on c.creative_id = v.creative_id
        where v.brand_id = $1 and v.creative_id is not null and v.impressions >= 10000`,
      [brandId]),

    // Whether spend is behind this post. Its organic numbers stop updating
    // once it is, so the organic rating stands for the period before.
    queryTolerant(
      `select is_boosted from v_boost_status where creative_id = $1`, [creativeId]),
  ]);

  if (!creativeR.rows.length) return null;
  const c = creativeR.rows[0];
  const isBoosted = !!(boostR.rows[0] && boostR.rows[0].is_boosted) || organicR.rows.some((r) => isBoostedState(r.cqr));
  const velocity = await velocityFor(creativeId);

  const posted = organicR.rows.map((r) => r.time_posted).filter(Boolean).sort()[0] || c.date;
  const hoursSince = posted ? (Date.now() - new Date(posted).getTime()) / 3600000 : null;

  const orgBy = Object.fromEntries(organicR.rows.map((r) => [r.platform, r]));
  const peersBy = {};
  for (const p of peerR.rows) (peersBy[p.platform] ||= []).push(p);

  // Does this platform report each metric for this brand at all? Answered
  // from the brand's own other posts rather than assumed, so the panel
  // adjusts on its own if a platform starts or stops returning something.
  // Instagram and Facebook never return watch time on organic posts, so
  // there is nothing to apologise for; saying so on every post is noise.
  const reports = (plat, field) =>
    (peersBy[plat] || []).some((p) => p[field] !== null && p[field] !== undefined);

  // Which platforms this post is expected on: a link was captured, or a
  // row came back. A link with no row is the honest "no data" case.
  const expected = Object.keys(PLATFORM).filter((p) => c[PLATFORM[p].linkField] || orgBy[p]);

  // The brand's own creator bar where it has one (migration 028), else the
  // bar shared by all brands. Mirrors cqr_organic_label.
  const osBench = {};
  for (const r of osBenchR.rows || []) {
    if (r.brand_id && r.brand_id !== brandId) continue;
    const cur = osBench[r.platform];
    if (!cur || (r.brand_id && !cur.brand_id)) osBench[r.platform] = r;
  }

  const platforms = expected.map((plat) => {
    const meta = PLATFORM[plat];
    const o = orgBy[plat];

    if (!o) {
      return {
        platform: plat, label: meta.label, missing: true, cqr: null, rated: null,
        recommendation: recommendFor({ platLabel: meta.label, missing: true }),
      };
    }

    // The one signal the rating is based on, and the band it is read
    // against. Which of the two it is, and where the band comes from,
    // depends on type, exactly as cqr_organic_label does it. Photos and
    // carousels use the engagement rule in static-rating.js instead.
    const st = creativeIsStatic
      ? SR.rateStatic({ o, type: c.type, plat, brandId, bands: staticBands, storedCqr: o.cqr, postedAt: o.time_posted, contentType: c.content_type })
      : null;
    const signal = st ? (st.signal ? st.signal.value : null) : ratingSignal(o, c.type, c.duration_s);
    const band = st ? (st.band ? { poor_lt: num(st.band.poor_lt), good_gte: num(st.band.good_gte), source: 'static' } : null)
      : isOthersSay(c.type)
      ? (osBench[plat]
          ? { poor_lt: num(osBench[plat].poor_below), good_gte: num(osBench[plat].good_from),
              source: osBench[plat].brand_id ? 'os-brand' : 'os' }
          : null)
      : (() => {
          const th = pickThreshold(thresholdR.rows, platformKey(plat, c.type), 'retention', c.duration_s);
          return th ? { poor_lt: num(th.poor_lt), good_gte: num(th.good_gte), source: th.brand_id ? 'brand' : 'global' } : null;
        })();

    // Always a rating, even when the stored label is a state like
    // Boosted. The rule is the same one, so the answer agrees with
    // every other CQR in the app rather than being a second opinion.
    const rated = grade(signal, band);
    const state = st ? (st.grade ? null : stateOf(st.cqr)) : stateOf(o.cqr);
    // A static has no views to judge delivery by on most platforms: reach
    // stands in, and a per-follower read needs only the follower count.
    // With nothing to rate on at all, the state says why; delivery is
    // not the question then.
    const delivered = st
      ? (!st.signal || st.signal.value === null || st.signal.basis === 'followers' ? true
         : Number(st.signal.den) >= VIEW_FLOOR)
      : num(o.views) !== null && num(o.views) >= VIEW_FLOOR;
    const tooNew = hoursSince !== null && hoursSince < MIN_HOURS;
    const peers = peersBy[plat] || [];

    const standing = placeAmong(signal, peers.map((p) => (st
      ? SR.staticSignal(p, c.type, p.followers).value
      : ratingSignal(p, c.type, p.duration_s))));
    standing.words = standingWords(standing.percentile);

    // What the panel shows in place of the method: four ranks, a one-line
    // read of them, and the two statements built from the best and worst.
    const dims = dimensionsFor(o, c.duration_s, plat, peers, reports);
    const pair = workingPair(dims, o, c.duration_s, meta.label);

    return {
      platform: plat,
      label: meta.label,
      missing: false,
      // The rating, always present when it can be worked out at all.
      cqr: rated,
      // And the state alongside it, never instead of it.
      state,
      state_note: state ? CQR_STATES[state.toLowerCase()] : null,
      // Who a creator post was compared with. Says which group, never the
      // numbers, which stay off the page.
      rated_against: band && band.source === 'os-brand'
        ? `Compared with this brand's other creator posts on ${meta.label}.`
        : band && band.source === 'os'
          ? `Compared with creator posts across all brands on ${meta.label}, until this brand has five of its own there.`
          : null,
      boosted: isBoosted,
      views: num(o.views),
      reach: num(o.reach),
      likes: num(o.likes),
      comments: num(o.comments),
      shares: num(o.shares),
      saves: num(o.saves),
      interactions: num(o.total_interactions),
      avg_watch_time: r1(o.avg_watch_time),
      reactions: reactionRead(o),
      time_posted: o.time_posted,
      // The grade and where it places, and nothing else.
      //
      // This used to carry name ("Interaction"), note (the formula in
      // words), value (the computed figure) and band (the good and poor
      // thresholds). All four were rendered in the panel under "How it is
      // judged", which published the rating method and the brand's own
      // benchmarks to anyone with a login.
      //
      // Removing them from the renderer alone would not have been enough.
      // The panel is fed by this endpoint, so the thresholds sat in the
      // JSON whatever the page chose to draw, one devtools tab away. They
      // are dropped here instead, which is the only place that settles it.
      //
      // signal, band and signalName are still computed above: the grade
      // and the percentile are derived from them. They just stop here.
      signal: {
        grade: rated,
        percentile: standing.percentile,
      },
      // Each dimension as a rank against the brand's own posts, the
      // one-line read of them, and the two statements. Empty when there
      // are too few comparable posts to place anything against, which the
      // panel says rather than inventing a rank.
      dimensions: dims,
      dimension_summary: dimensionSummary(dims),
      working: pair.working,
      not_working: pair.notWorking,
      peer_count: peers.length,
      reason: reasonFor({ rated, state, signal, band, signalName: signalName(c.type, !!st), type: c.type, boosted: isBoosted }),
      standing,
      velocity: velocity[plat] || null,
      delivered, too_new: tooNew,
      recommendation: recommendFor({
        platLabel: meta.label, rated, state, standing, delivered, tooNew, missing: false, boosted: isBoosted,
      }),
    };
  });

  // Where the platforms disagree, say so once, at the top. A single
  // verdict for the post would be the wrong unit of decision.
  const judged = platforms.filter((p) => !p.missing && p.delivered && !p.too_new && gradeOnly(p.cqr));
  const grades = [...new Set(judged.map((p) => p.cqr))];
  let split = null;
  if (judged.length > 1 && grades.length > 1) {
    const best = judged.filter((p) => p.cqr === 'Good').map((p) => p.label);
    const worst = judged.filter((p) => p.cqr === 'Poor').map((p) => p.label);
    if (best.length && worst.length) {
      split = `This is two decisions, not one: ${best.join(' and ')} earned the spend, ${worst.join(' and ')} did not.`;
    } else {
      split = `It did not land the same way on every platform — ${judged.map((p) => `${p.label} ${p.cqr}`).join(', ')} — so treat each platform on its own.`;
    }
  }

  const winners = winnerMatches(c, paidR.rows);

  const flags = [];
  // The per-platform line below already names them, so this would repeat it.
  if (!organicR.rows.length && !platforms.length) {
    flags.push('No organic numbers have come back for this post yet.');
  }
  // Plain words. Why the numbers are missing is a pipeline matter, and a
  // planner reading this card only needs to know not to read it as weak.
  const missingPlats = platforms.filter((p) => p.missing).map((p) => p.label);
  if (missingPlats.length) {
    flags.push(`No numbers yet for ${missingPlats.join(' and ')}. Nothing here says the post did badly, only that it has not been measured.`);
  }
  if (hoursSince !== null && hoursSince < MIN_HOURS) flags.push(`Posted ${Math.max(1, Math.round(hoursSince))} hours ago. Organic distribution is still running.`);
  // The floor still decides whether a rating counts; it just no longer
  // announces itself with the number. "656 views is below the 1,000-view
  // floor" tells people how to game it and reads like a system message.
  for (const p of platforms) if (!p.missing && !p.delivered) flags.push(`${p.label}: ${creativeIsStatic ? 'too few people reached' : 'too few views'} so far for the rating to mean much. Give it time rather than acting on it.`);

  return {
    creative_id: c.creative_id,
    type: c.type,
    content_type: c.content_type || 'Video',
    is_static: creativeIsStatic,
    campaign: c.campaign || '',
    duration_s: c.duration_s === null ? null : Number(c.duration_s),
    posted_at: posted || null,
    hours_since_post: hoursSince === null ? null : Math.round(hoursSince),
    platforms,
    split,
    winners: {
      ...winners,
      sentences: winners.matches.slice(0, 5).map(matchSentence),
      verdict: !winners.matches.length
        ? (winners.basis < TAG_MIN * 2
            ? 'Not enough paid history on this brand yet to say what its winners have in common.'
            : 'Nothing in this post stands out either way against your paid winners.')
        : winners.supports > winners.against
          ? 'What this post is made of has tended to work on paid for this brand.'
          : winners.against > winners.supports
            ? 'What this post is made of has tended to underperform on paid for this brand.'
            : 'This post carries elements that have gone both ways on paid.',
    },
    flags,
    thresholds_found: thresholdR.rows.length,
  };
}

module.exports = { buildValidation, VIEW_FLOOR, MIN_HOURS };

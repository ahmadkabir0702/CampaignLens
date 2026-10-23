// =====================================================================
//  One paid rating for a creative that ran on Meta and TikTok.
//
//  Each platform is graded against its own bars (their hook rates are
//  defined differently: 3-second views on Meta, 2-second on TikTok), then
//  the grades are combined weighted by impressions:
//
//      Good = 3, Average = 2, Poor = 1
//      score = sum(grade x impressions) / sum(impressions)
//      Good from 2.5, Average from 1.5, Poor below
//
//  So a platform that carried most of the delivery decides most of the
//  rating, and a creative that was Poor where most of the money went is
//  no longer shown as Good because it did well on the smaller platform.
//  Before this, the better of the two grades was shown.
//
//  A platform without a grade (Low Delivery, Invalid) does not count. With
//  no graded platform the state of the first one is returned unchanged.
//
//  Used by the Creative Hub (creatives.js) and Ask Lens (snapshot.js), so
//  both show the same rating.
// =====================================================================
const SCORE = { Good: 3, Average: 2, Poor: 1 };

function combineGrades(items) {
  const list = (items || []).filter(Boolean);
  const graded = list.filter((x) => SCORE[x.cqr] && Number(x.impressions) > 0);
  if (!graded.length) {
    const any = list.find((x) => SCORE[x.cqr]);
    if (any) return any.cqr;
    const state = list.map((x) => x.cqr).find(Boolean);
    return state || null;
  }
  if (graded.length === 1) return graded[0].cqr;
  const total = graded.reduce((s, x) => s + Number(x.impressions), 0);
  const score = graded.reduce((s, x) => s + SCORE[x.cqr] * Number(x.impressions), 0) / total;
  return score >= 2.5 ? 'Good' : score >= 1.5 ? 'Average' : 'Poor';
}

/** A rate across platforms, weighted by impressions (falls back to a plain mean). */
function weightedRate(items, field) {
  const list = (items || []).filter((x) => x && x[field] !== null && x[field] !== undefined && !isNaN(Number(x[field])));
  if (!list.length) return 0;
  const total = list.reduce((s, x) => s + (Number(x.impressions) || 0), 0);
  if (!total) return list.reduce((s, x) => s + Number(x[field]), 0) / list.length;
  return list.reduce((s, x) => s + Number(x[field]) * (Number(x.impressions) || 0), 0) / total;
}

module.exports = { combineGrades, weightedRate };

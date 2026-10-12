/**
 * Turns a Brainsuite result (about 570 KB) into what Campaign Lens keeps
 * (about 8 KB): total, categories, every placement's scores and the KPI
 * checklist with Brainsuite's own pass marks. No media: image and video
 * links expire an hour after the result is fetched, so mediaFrom() pulls
 * them out fresh whenever a report is opened.
 */

const TIPS = require('./tips');

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const round = (v, dp = 0) => (v === null ? null : Number(v.toFixed(dp)));

function firstLeg(result) {
  const legs = result && result.output && result.output.legResults;
  return Array.isArray(legs) && legs.length ? legs[0] : null;
}

// "Additional Metrics (unweighted)" -> { name: 'Additional Metrics', unweighted: true }
function categoryName(raw) {
  const s = String(raw || '');
  const unweighted = /\(unweighted\)/i.test(s);
  return { name: s.replace(/\s*\(unweighted\)\s*/i, '').trim(), unweighted };
}

// The pass marks, reduced to what the UI draws.
function normOf(n) {
  if (!n || !n.type) return { type: 'undefined' };
  const out = { type: n.type };
  if (n.thresholds) {
    for (const k of ['low', 'high', 'veryLow', 'veryHigh', 'tooLow', 'tooHigh']) {
      if (typeof n.thresholds[k] === 'number') out[k] = n.thresholds[k];
    }
  }
  if (typeof n.threshold === 'number') out.threshold = n.threshold;
  if (typeof n.highPositive === 'boolean') out.highPositive = n.highPositive;
  return out;
}

// One label per KPI that reads the same on a card, in a list and in Ask Lens.
function display(score, rating, norm) {
  if (rating === 'notAvailable' || score === null) return 'N/A';
  if (norm.type === 'binary' || norm.type === 'trafficBinary') {
    // Scene Pace is binary but its score is a rate, worth showing.
    if (score > 1.0001 || (score > 0 && score < 1 && norm.threshold && norm.threshold < 1)) {
      return `${round(score, 2)}`;
    }
    return rating === 'positive' ? 'Yes' : 'No';
  }
  return score > 0 && score < 1 ? `${round(score, 2)}` : `${Math.round(score)}`;
}

function summarise(result, channel) {
  const leg = firstLeg(result);
  if (!leg) throw new Error('Brainsuite result has no leg results');

  const placementsRaw = leg.placements || {};
  const mine = placementsRaw[channel] || null;
  const es = (mine && mine.executiveSummary) || leg.executiveSummary || {};

  const categories = (es.categories || []).map(c => ({
    ...categoryName(c.name),
    score: round(num(c.score)),
    rating: c.rating || 'notAvailable',
  }));

  const placements = {};
  for (const [p, v] of Object.entries(placementsRaw)) {
    const pes = (v && v.executiveSummary) || {};
    const cats = {};
    for (const c of pes.categories || []) cats[categoryName(c.name).name] = round(num(c.score));
    placements[p] = { total: round(num(pes.totalScore)), rating: pes.totalRating || 'notAvailable', categories: cats };
  }

  const order = categories.map(c => c.name);
  const kpis = [];
  for (const [id, k] of Object.entries(leg.kpis || {})) {
    const p = k.placements && k.placements[channel];
    const score = num(p ? p.score : k.score);
    const rating = (p ? p.rating : k.rating) || 'notAvailable';
    const norm = normOf(p ? p.norm : null);
    const cat = categoryName((k.categories || [])[0]).name;
    kpis.push({
      id, name: k.name || id, category: cat,
      score: score === null ? null : round(score, score > 0 && score < 10 ? 2 : 1),
      display: display(score, rating, norm),
      rating, norm,
      weighted: !(p && p.weight === 0),
      tip: (rating === 'negative' || rating === 'medium' || rating === 'negativeTooLow' || rating === 'negativeTooHigh' || rating === 'veryNegative')
        ? (TIPS[id] || null) : null,
    });
  }
  kpis.sort((a, b) => {
    const ca = order.indexOf(a.category), cb = order.indexOf(b.category);
    return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb) || a.name.localeCompare(b.name);
  });

  return {
    version: 1,
    channel,
    total: { score: round(num(es.totalScore)), rating: es.totalRating || 'notAvailable' },
    categories,
    placements,
    kpis,
  };
}

// Fresh media links from a Brainsuite result. Valid for one hour.
const STILLS = [
  ['brandAvailableFirstNSeconds', 'Brand, first seconds'],
  ['productAvailableFirstNSeconds', 'Pack shot, first seconds'],
  ['brandAttentionLastScene', 'Brand, last scene'],
  ['productAttentionLastScene', 'Pack shot, last scene'],
];

function mediaFrom(result) {
  const leg = firstLeg(result);
  if (!leg) return { montage: null, stills: [], heatmovie: null };
  const kpis = leg.kpis || {};
  const imageOf = id => ((kpis[id] && kpis[id].visualizations) || []).find(v => v && v.type === 'image' && v.url);
  const stills = [];
  for (const [id, label] of STILLS) {
    const v = imageOf(id);
    if (v) stills.push({ id, label, url: v.url });
  }
  const hm = ((kpis.heatmovie && kpis.heatmovie.visualizations) || []).find(v => v && v.type === 'movie' && v.url);
  const montage = leg.visualizations && leg.visualizations.sceneMontage && leg.visualizations.sceneMontage.url;
  return { montage: montage || null, stills, heatmovie: hm ? hm.url : null };
}

module.exports = { summarise, mediaFrom };

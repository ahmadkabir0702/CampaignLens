/**
 * Sound and Funnel fit: the two checks Campaign Lens adds on top of the
 * Pre-test Score. Pure functions, no database, so they can be tested and
 * re-run whenever an input arrives (the Pre-test Score lands about five
 * minutes after the video analysis).
 *
 * Inputs
 *   a          the video analysis (Gemini fields, plus product_screen_pct)
 *   loud       ffmpeg loudness: { integrated, truePeak, series: [[t, M]] } or null
 *   bs         the Pre-test Score summary (brainsuite_results.summary) or null
 *   meta       { brand, duration, isStatic }
 *   objective  for a pre-test, the objective chosen at upload, or null
 *
 * Every check returns { id, name, value, target, score, result, weight, fix }.
 * score is 1 (pass), 0.5 (partly), 0 (miss) or null (not applicable).
 * Colours everywhere: green 70 and above, amber 50 to 69, red below 50.
 * All thresholds live in this file.
 */
const TIPS = require('../brainsuite/tips');

const GREEN = 70, AMBER = 50;
const rag = s => (s == null ? null : s >= GREEN ? 'green' : s >= AMBER ? 'amber' : 'red');
const SOUND_WORD = { green: 'Good', amber: 'Average', red: 'Weak' };
const FIT_WORD = { green: 'Strong fit', amber: 'Fair fit', red: 'Weak fit' };

function check(id, name, value, target, score, weight, fix) {
  const result = score == null ? 'na' : score >= 1 ? 'pass' : score > 0 ? 'partial' : 'fail';
  return { id, name, value, target, score, result, weight, fix: result === 'partial' || result === 'fail' ? fix : '' };
}

function weighted(checks) {
  let n = 0, d = 0;
  for (const c of checks) if (c.score != null) { n += c.score * c.weight; d += c.weight; }
  return d ? Math.round((100 * n) / d) : null;
}

// ── Brand name heard in speech ───────────────────────────────────────────────
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// ── Sound ────────────────────────────────────────────────────────────────────
/**
 * Voice against music, from the analysis's per-window audio labels:
 * loudness while someone speaks against loudness while only music plays.
 * A voice mixed under loud music leaves the two about level.
 */
function voiceLift(a, loud) {
  const attrs = Array.isArray(a.timeline_attrs) ? a.timeline_attrs : [];
  if (!attrs.length || !loud || !loud.series || !loud.series.length) return null;
  const sorted = attrs.map(x => ({ ...x, t: Number(x.t) })).filter(x => Number.isFinite(x.t)).sort((x, y) => x.t - y.t);
  const step = sorted.length > 1 ? (sorted[1].t - sorted[0].t) || 2 : 2;
  const kindAt = t => {
    for (let i = sorted.length - 1; i >= 0; i--) if (t >= sorted[i].t) return t < sorted[i].t + step ? sorted[i].audio : null;
    return null;
  };
  const speech = [], music = [];
  for (const [t, m] of loud.series) {
    if (m <= -60) continue;
    const k = kindAt(t);
    if (k === 'speech' || k === 'both') speech.push(m);
    else if (k === 'music') music.push(m);
  }
  const med = xs => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  if (speech.length < 5) return null;
  if (music.length < 5) return { onlyVoice: true };
  return { lift: Math.round((med(speech) - med(music)) * 10) / 10 };
}

function kpiScore(bs, id) {
  if (!bs || !Array.isArray(bs.kpis)) return null;
  const k = bs.kpis.find(x => x.id === id);
  if (!k) return null;
  const r = k.rating;
  if (r === 'positive' || r === 'veryPositive') return 1;
  if (r === 'medium') return 0.5;
  if (r === 'negative' || r === 'veryNegative' || r === 'negativeTooLow' || r === 'negativeTooHigh') return 0;
  return null;
}

function scoreSound({ a = {}, loud = null, bs = null, meta = {} }) {
  if (meta.isStatic) return null;
  const checks = [];
  const hasAudio = !!(loud && loud.integrated != null && loud.integrated > -70);
  if (!hasAudio) {
    return { score: null, rag: null, word: 'No sound', checks: [], loudness: null,
      note: 'This video has no sound track, so the sound checks do not apply.' };
  }
  const I = loud.integrated;
  checks.push(check('loudness', 'Loudness close to platform level', `${I.toFixed(1)} LUFS`, '-16 to -12 LUFS',
    I >= -16 && I <= -12 ? 1 : I >= -19 && I <= -10 ? 0.5 : 0, 2,
    I < -16 ? 'Raise the overall level to about -14 LUFS so it is not quieter than the ads around it.'
            : 'Bring the overall level down to about -14 LUFS; platforms turn louder ads down and it can distort.'));
  if (loud.truePeak != null) {
    const tp = loud.truePeak;
    checks.push(check('peak', 'No clipping', `${tp.toFixed(1)} dBTP`, '-1 dBTP or lower',
      tp <= -1 ? 1 : tp <= 0 ? 0.5 : 0, 1, 'Lower the loudest peaks to -1 dBTP so the sound does not crack on phone speakers.'));
  }
  if (a.voiceover) {
    const v = voiceLift(a, loud);
    if (!a.music) {
      checks.push(check('voice_clear', 'Voice clear over the music', 'no music', 'a voice that stands out', 1, 2, ''));
    } else if (v && v.onlyVoice) {
      checks.push(check('voice_clear', 'Voice clear over the music', 'music only under the voice', 'a voice that stands out', null, 2, ''));
    } else if (v) {
      checks.push(check('voice_clear', 'Voice clear over the music', `${v.lift >= 0 ? '+' : ''}${v.lift} LU`, '+4 LU or more',
        v.lift >= 4 ? 1 : v.lift >= 2 ? 0.5 : 0, 2, 'Lower the music under the voice so every word is clear.'));
    }
    const said = Number(a.brand_spoken_first_s);
    const known = a.brand_spoken_first_s !== undefined && a.brand_spoken_first_s !== null;
    if (known) {
      checks.push(check('brand_said', 'Brand named in the sound',
        said >= 0 ? `first at ${Math.round(said)}s` : 'not said', 'the first 5 seconds',
        said >= 0 && said <= 5 ? 1 : said > 5 ? 0.5 : 0, 2,
        'Say the brand name early in the voiceover, ideally within the first 5 seconds.'));
    }
    checks.push(soundOffCheck(kpiScore(bs, 'idealAudioSetting'), a));
  }
  const score = weighted(checks);
  return {
    score, rag: rag(score), word: score == null ? 'Not scored' : SOUND_WORD[rag(score)], checks,
    loudness: { integrated: I, truePeak: loud.truePeak, range: loud.range,
      // Down-sampled to one point a second for the chart.
      series: loud.series.filter((_, i) => i % 10 === 0).map(([t, m]) => [Math.round(t), m]) },
  };
}

// The scored check when there is one, else the analysis' own reading.
function soundOffCheck(bsOff, a) {
  const off = bsOff != null ? bsOff : (a.captions ? 1 : a.has_text_overlay ? 0.5 : 0);
  return check('sound_off', 'Works with the sound off',
    bsOff != null ? (bsOff >= 1 ? 'yes' : bsOff > 0 ? 'partly' : 'no') : a.captions ? 'captions' : a.has_text_overlay ? 'some on-screen text' : 'no captions',
    'captions for the key lines', off, 2, 'Add captions or on-screen text for the key lines; most feed video is watched muted.');
}

/**
 * The Sound score again once the scored checks are in. Loudness, clipping,
 * voice and brand do not change (they came from the file, which is gone by
 * now); only "works with the sound off" can, because the scored check takes
 * over from the analysis. Returns the same object when nothing changes.
 */
function refreshSound(sound, bs, a = {}) {
  if (!sound || !Array.isArray(sound.checks)) return sound;
  const bsOff = kpiScore(bs, 'idealAudioSetting');
  const i = sound.checks.findIndex(c => c.id === 'sound_off');
  if (bsOff == null || i < 0) return sound;
  const checks = sound.checks.slice();
  checks[i] = soundOffCheck(bsOff, a);
  const score = weighted(checks);
  return { ...sound, checks, score, rag: rag(score), word: score == null ? 'Not scored' : SOUND_WORD[rag(score)] };
}

// ── Funnel fit ───────────────────────────────────────────────────────────────
const SIG = {
  brand_early: { name: 'Brand in the first seconds', kpi: 'brandAvailableFirstNSeconds',
    fb: a => (typeof a.logo_first_3s === 'boolean' ? (a.logo_first_3s ? 1 : 0) : null),
    fix: 'Show the brand in the first 3 seconds; most people scroll on before the end.' },
  brand_attention: { name: 'Attention on the brand', kpi: 'brandAttention', fb: () => null,
    fix: 'Make the brand a focal point and keep it visible more often.' },
  brand_end: { name: 'Ends on the brand', kpi: 'brandAttentionLastScene', fb: () => null,
    fix: 'End on a clear logo and pack shot.' },
  product_early: { name: 'Product in the first seconds', kpi: 'productAvailableFirstNSeconds',
    fb: a => (typeof a.opens_with_product === 'boolean' ? (a.opens_with_product ? 1 : 0) : null),
    fix: 'Bring the product into the opening seconds.' },
  product_time: { name: 'Product on screen long enough', kpi: 'productAttentionVideoTime',
    fb: a => (a.product_screen_pct == null ? null : a.product_screen_pct >= 30 ? 1 : a.product_screen_pct >= 15 ? 0.5 : 0),
    fix: 'Show the product for longer, or in more scenes.' },
  product_end: { name: 'Product in the last scene', kpi: 'productAttentionLastScene',
    fb: a => {
      const t = Array.isArray(a.timeline_attrs) ? a.timeline_attrs : [];
      const last = t.length ? t[t.length - 1] : null;
      return last && typeof last.product_visible === 'boolean' ? (last.product_visible ? 1 : 0) : null;
    },
    fix: 'Close on the product so people know what to look for.' },
  engaging_open: { name: 'Strong opening', kpi: 'engagingBeginning',
    fb: a => (a.hook_pace === 'fast_cut' ? 1 : a.hook_pace === 'single_shot' ? 0.5 : null),
    fix: 'Make the first seconds move: a cut, motion or a person.' },
  memorable: { name: 'Memorable', kpi: 'memorability', fb: () => null,
    fix: 'Add one distinctive, uncluttered moment people will remember.' },
  readable: { name: 'Text easy to read in time', kpi: 'readingTime', fb: () => null,
    fix: 'Shorten on-screen text or hold it longer.' },
  message_fit: { name: 'Visuals fit the key message', kpi: 'fitToMessageVisual', fb: () => null,
    fix: 'Use visuals that say the key message directly.' },
  sound_off: { name: 'Works with the sound off', kpi: 'idealAudioSetting',
    fb: a => (a.voiceover ? (a.captions ? 1 : a.has_text_overlay ? 0.5 : 0) : null),
    fix: 'Add captions or on-screen text for the key lines.' },
  short: { name: 'Short enough to land', fb: (a, m) => (m.isStatic || !m.duration ? null : m.duration <= 15.5 ? 1 : m.duration <= 30.5 ? 0.5 : 0),
    fix: 'Cut a 6 to 15 second version.' },
  story_length: { name: 'Long enough to explain', fb: (a, m) => (m.isStatic || !m.duration ? null : m.duration >= 9.5 && m.duration <= 60.5 ? 1 : 0.5),
    fix: 'Give the product reasons a few more seconds.' },
  reasons: { name: 'Gives reasons to choose it',
    fb: a => (!Array.isArray(a.reasons) ? null : a.reasons.length >= 3 ? 1 : a.reasons.length >= 1 ? 0.5 : 0),
    fix: 'Add one or two concrete reasons to buy: a benefit, an ingredient, a result.' },
  cta: { name: 'Clear call to action', kpi: 'conceptCallToActionAttention',
    fb: a => (typeof a.cta === 'boolean' ? (a.cta ? 1 : 0) : null),
    fix: 'End with a short call to action on screen.' },
  direct_action: { name: 'Asks for a direct action', fb: a => (typeof a.direct_action === 'boolean' ? (a.direct_action ? 1 : 0) : null),
    fix: "Use a direct action such as 'Order now' or 'Shop now', not only 'Available in stores'." },
  offer: { name: 'Has an offer or price',
    fb: a => (a.offer === undefined && !a.content_intent ? null : (String(a.offer || '').trim() || a.content_intent === 'promote_offer') ? 1 : 0),
    fix: 'Add a price, offer or reason to act now.' },
  urgency: { name: 'Gives a reason to act now', fb: a => (typeof a.urgency === 'boolean' ? (a.urgency ? 1 : 0) : null),
    fix: "Add a time limit or a 'this week' line." },
  brand_said: { name: 'Brand named in the sound', fromSound: 'brand_said', fix: 'Say the brand name in the first 5 seconds.' },
  voice_clear: { name: 'Voice clear over the music', fromSound: 'voice_clear', fix: 'Lower the music under the voice.' },
};

// ── The objective scores ─────────────────────────────────────────────────────
// Each objective score is the Pre-test Score, weighted for that objective:
// the same scored checks, the same pass marks and the same placement, with
// its categories counted differently for what the video is for. Sound is a
// small share of each. Conversion adds "the ask" (offer, call to action,
// urgency), which the Pre-test Score has no checks for.
// Each column adds up to 100. Agreed November 2026.
const MIX = {
  Awareness: [['attention', 35], ['branding', 35], ['processing', 10], ['emotion', 15], ['sound', 5]],
  Consideration: [['attention', 20], ['branding', 10], ['processing', 30], ['emotion', 10], ['persuasion', 25], ['sound', 5]],
  Conversion: [['attention', 20], ['branding', 10], ['processing', 15], ['persuasion', 20], ['ask', 30], ['sound', 5]],
};
const OBJECTIVES = Object.keys(MIX);
const SOUND_SHARE = 0.05;
const PART = {
  attention: { name: 'Attention', match: /attention/i },
  branding: { name: 'Branding', match: /brand/i },
  processing: { name: 'Processing Ease', match: /process/i },
  emotion: { name: 'Emotional Engagement', match: /emotion/i },
  persuasion: { name: 'Persuasion', match: /persua/i },
  ask: { name: 'The ask (offer, call to action, urgency)' },
  sound: { name: 'Sound' },
};
// The ask, from the video analysis (the call to action uses the scored check when there is one).
const ASK = [['cta', 3], ['direct_action', 2], ['offer', 2], ['urgency', 1]];

function signal(key, { a, bs, sound, meta }) {
  const s = SIG[key];
  if (s.fromSound) {
    const c = sound && (sound.checks || []).find(x => x.id === s.fromSound);
    return c && c.score != null ? { v: c.score, src: 'sound' } : null;
  }
  if (s.kpi) {
    const v = kpiScore(bs, s.kpi);
    if (v != null) return { v, src: 'pretest' };
  }
  const v = s.fb ? s.fb(a, meta) : null;
  return v == null ? null : { v, src: 'analysis' };
}

function intentOf(a) {
  const offer = !!(String(a.offer || '').trim()) || a.content_intent === 'promote_offer';
  const push = !!(a.direct_action || a.urgency || a.cta);
  if (offer && push) return { intent: 'Conversion', why: 'it has an offer and asks for action' };
  const reasons = Array.isArray(a.reasons) ? a.reasons.length : 0;
  if (reasons >= 2 || ['educate', 'demonstrate', 'prove'].includes(a.content_intent)) {
    return { intent: 'Consideration', why: 'it gives reasons to choose the product' };
  }
  return { intent: 'Awareness', why: 'it builds the brand rather than making an offer' };
}

const BAD = new Set(['negative', 'veryNegative', 'negativeTooLow', 'negativeTooHigh', 'medium']);

/** The tested placement's category scores, by part key. */
function categoriesOf(bs) {
  const out = {};
  for (const c of (bs && Array.isArray(bs.categories) ? bs.categories : [])) {
    for (const [key, p] of Object.entries(PART)) {
      if (p.match && p.match.test(c.name || '') && out[key] === undefined && c.score != null) out[key] = { score: Number(c.score), cat: c.name };
    }
  }
  return out;
}

/**
 * The three objective scores, and which one the video is judged on.
 *
 *   objective  what the person running a pre-test said the video is for
 *              (Awareness, Consideration or Conversion), or null. When it is
 *              given, that stage is the headline (`focus`). When it is not
 *              (tracked creatives, older pre-tests) the headline is what the
 *              video reads as (`intent`).
 *
 * Without a Pre-test Score there are no objective scores: they are the
 * Pre-test Score weighted for each objective, never a number of their own.
 * The video analysis still says what the video reads as.
 */
function scoreFunnel({ a = {}, bs = null, sound = null, meta = {}, objective = null }) {
  const ctx = { a, bs, sound, meta };
  const soundScore = sound && sound.score != null ? Number(sound.score) : null;
  const cats = categoriesOf(bs);
  const hasScore = Object.keys(cats).length > 0;
  const base = bs && bs.total && bs.total.score != null ? Math.round(Number(bs.total.score)) : null;

  // The ask, out of 100, and its first miss for the tip.
  let askN = 0, askD = 0, askGap = null;
  for (const [key, w] of ASK) {
    const sg = signal(key, ctx);
    if (!sg) continue;
    askN += sg.v * w; askD += w;
    if (sg.v < 1 && !askGap) askGap = sg.src === 'pretest' && TIPS[SIG[key].kpi] ? TIPS[SIG[key].kpi] : SIG[key].fix;
  }
  const askScore = askD ? Math.round((100 * askN) / askD) : null;
  const soundGap = sound && (sound.checks || []).find(c => c.result === 'fail' || c.result === 'partial');

  // The worst scored check in a category, for "to fit better".
  const tipFor = (catName) => {
    const k = (bs && bs.kpis || []).filter(x => x.category === catName && x.weighted !== false && BAD.has(x.rating))
      .sort((x, y) => (x.rating === 'medium') - (y.rating === 'medium'))[0];
    return k ? (k.tip || TIPS[k.id] || `Improve ${k.name.toLowerCase()}.`) : null;
  };

  const stages = {};
  for (const [stage, mix] of Object.entries(MIX)) {
    const parts = [];
    for (const [key, w] of mix) {
      if (key === 'sound') { if (soundScore != null) parts.push({ key, name: PART.sound.name, score: soundScore, w, fix: soundGap ? soundGap.fix : null, src: 'sound' }); continue; }
      if (key === 'ask') { if (askScore != null) parts.push({ key, name: PART.ask.name, score: askScore, w, fix: askGap, src: 'analysis' }); continue; }
      const c = cats[key];
      if (c) parts.push({ key, name: PART[key].name, cat: c.cat, score: c.score, w, fix: tipFor(c.cat), src: 'pretest' });
    }
    const d = parts.reduce((t, p) => t + p.w, 0);
    const score = hasScore && d ? Math.round(parts.reduce((t, p) => t + p.score * p.w, 0) / d) : null;
    const cat = new Set(parts.filter(p => p.cat).map(p => p.cat));
    stages[stage] = {
      score, rag: rag(score), word: score == null ? 'Needs the Pre-test Score' : FIT_WORD[rag(score)],
      helps: score == null ? [] : parts.filter(p => p.score >= GREEN).sort((x, y) => y.w - x.w).slice(0, 3).map(p => p.name),
      gaps: score == null ? [] : parts.filter(p => p.score < GREEN && p.fix).sort((x, y) => (100 - y.score) * y.w - (100 - x.score) * x.w).slice(0, 3)
        .map(p => ({ name: p.name, fix: p.fix })),
      // What went into the score and how much each part counts, heaviest first.
      parts: score == null ? [] : parts.sort((x, y) => y.w - x.w).map(p => ({ key: p.key, name: p.name, score: Math.round(p.score), share: Math.round((100 * p.w) / d), src: p.src })),
      // The scored checks that sit in this objective's categories.
      kpis: (bs && bs.kpis || []).filter(k => cat.has(k.category)).map(k => k.id),
    };
  }
  const { intent, why } = intentOf(a);
  const declared = OBJECTIVES.includes(objective) ? objective : null;
  const focus = declared || intent;
  const scored = Object.entries(stages).filter(([, v]) => v.score != null);
  const best = scored.length ? scored.sort((x, y) => y[1].score - x[1].score)[0][0] : null;
  const top = best ? stages[best].score : null;
  const mine = stages[focus];
  const lower = s => s.toLowerCase();
  const an = s => (s === 'Awareness' ? 'an' : 'a');
  const tip = g => (g && g.fix ? ` Biggest gain: ${g.fix.charAt(0).toLowerCase()}${g.fix.slice(1)}` : '');
  let verdict;
  if (!hasScore) {
    verdict = declared
      ? `The ${lower(declared)} score is worked out from the Pre-test Score, which is not in yet.`
      : `Reads as ${an(intent)} ${lower(intent)} ad because ${why}. The fit is worked out from the Pre-test Score, which this creative does not have.`;
  } else if (declared) {
    const word = { green: 'A strong fit', amber: 'A fair fit', red: 'A weak fit' }[mine.rag];
    verdict = `${word} for ${lower(declared)}.${mine.rag === 'green' ? '' : tip(mine.gaps[0])}`;
    // Only said when another stage is clearly ahead and is itself at least fair.
    if (best && best !== declared && top >= AMBER && top - mine.score >= 10) {
      verdict += ` As it stands it works better as ${an(best)} ${lower(best)} asset (${top}).`;
    }
  } else if (top < AMBER) verdict = `Reads as ${an(intent)} ${lower(intent)} ad because ${why}, but it is not a strong fit for any stage yet.${tip(mine.gaps[0])}`;
  else if (mine.score >= GREEN) verdict = `Built for ${lower(intent)} (${why}) and fits it well.`;
  else if (best === intent || top - mine.score <= 5) verdict = `Built for ${lower(intent)} (${why}), but only a fair fit.${tip(mine.gaps[0])}`;
  else verdict = `Reads as ${an(intent)} ${lower(intent)} ad (${why}), but its strongest fit is ${lower(best)}.${tip(mine.gaps[0])}`;

  return {
    version: 3,
    objective: declared, focus,
    intent, intentWhy: why, best, verdict, stages,
    base,
    soundShare: hasScore && soundScore != null ? Math.round(SOUND_SHARE * 100) : 0,
    soundScore,
    basis: hasScore ? 'full' : 'none',
    reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 6) : [],
    offer: String(a.offer || '').trim() || null,
    ctaText: String(a.cta_text || '').trim() || null,
  };
}

module.exports = { scoreSound, refreshSound, scoreFunnel, rag, voiceLift, kpiScore, intentOf, GREEN, AMBER, normName, OBJECTIVES, SOUND_SHARE, MIX };

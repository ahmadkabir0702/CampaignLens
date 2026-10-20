/**
 * "What's behind this": a short written panel for every chart on the share
 * of voice page, and one for every tracked brand.
 *
 *   read          two or three sentences on what the chart shows
 *   drivers       what drove it: a campaign, a viral moment, giveaways, a
 *                 theme that grew, brand-backed creators, a competitor push
 *   implications  for each Unilever brand in view: what it means, and one
 *                 next step
 *   quotes        two or three things consumers said, translated where
 *                 needed, with no names, handles or numbers to reach them
 *
 * Written once per run from facts worked out here, never on click, so every
 * viewer sees the same panel and it opens at once. The model only puts the
 * facts into words: every number it writes must be one of the given figures,
 * and the same wording rules as the summary apply (no posts, comments or
 * mentions, no platform names, no method, no dashes). A panel that fails the
 * check twice is left out rather than shown wrong.
 */
const A = require('./aggregate');
const L = require('./label');
const T = require('./text');

const pct = v => `${(100 * v).toFixed(1)}%`;
const pts = d => `${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)} points`;

// What a quote must not carry: handles, links, phone numbers, emails.
function scrub(text) {
  return String(text || '')
    .replace(/@[\w.]+/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[—–]/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function top(map, n, base) {
  const tot = base != null ? base : [...map.values()].reduce((a, b) => a + b, 0);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ name: k, share: pct(tot ? v / tot : 0) }));
}
function count(items, keyOf) {
  const m = new Map();
  for (const it of items) for (const k of [].concat(keyOf(it) || [])) if (k) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

const QUOTE_TYPES = new Set(['praise', 'complaint', 'question', 'purchase intent', 'recommendation request', 'comparison']);

/** Consumer lines worth quoting, best first. */
function quoteCandidates(conv, filter, n = 14) {
  const seen = new Set();
  const out = [];
  const list = conv
    .filter(c => c.kind === 'text' && QUOTE_TYPES.has(c.type) && filter(c))
    .map(c => ({ c, text: scrub(c.body) }))
    .filter(x => x.text.length >= 15 && x.text.length <= 240)
    .sort((a, b) => b.c.likes - a.c.likes);
  // Variety first: one of each kind of response, then the rest by likes.
  const byType = new Map();
  for (const x of list) if (!byType.has(x.c.type)) byType.set(x.c.type, x);
  for (const x of [...byType.values(), ...list]) {
    const k = x.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= n) break;
  }
  return out.map((x, i) => ({ qid: 'q' + (i + 1), kind: x.c.type, sentiment: x.c.sent, brands: x.c.B, text: x.text }));
}

/** The facts behind every panel, from the same rows the shares came from. */
function gather(ctx, R, prev) {
  const D = R.detail;
  const { W, winConv, winMeta, topicName, groupOf } = D;
  const uni = R.brands.filter(b => b.isUnilever).map(b => b.name);
  const byBrand = Object.fromEntries(R.brands.map(b => [b.name, b]));
  const weeks = R.weekly.map(w => w.week);

  const brandFacts = {};
  for (const b of R.brands) {
    const mine = W.filter(m => m.brand === b.name);
    const earnedM = mine.filter(m => m.origin === 'earned');
    const themes = top(count(earnedM, m => (m.topics || []).map(topicName)), 4);
    const responses = top(count(mine.filter(m => !m.isPost && m.origin === 'earned'), m => A.INTENT[m.type] || null), 4);
    const audience = mine.filter(m => !(m.isPost && m.origin !== 'earned'));
    const negThemes = top(count(audience.filter(m => m.sent === 'negative'), m => (m.topics || []).map(topicName)), 3);
    const posThemes = top(count(audience.filter(m => m.sent === 'positive'), m => (m.topics || []).map(topicName)), 3);
    const promo = mine.length ? mine.filter(m => m.contest).length / mine.length : 0;
    // The content that carried the brand: most engaged in the period.
    const keys = new Set(mine.filter(m => m.isPost).map(m => m.key));
    const content = D.postMeta.filter(p => keys.has(p.key)).sort((a, z) => z.eng - a.eng).slice(0, 3).map(p => ({
      origin: A.ORIGIN[p.origin], made_by: p.backed ? A.BACKED_SOURCE : (A.AUTH[p.author] || 'Other'),
      kind_of_content: p.theme || 'other', themes: (p.topics || []).map(topicName),
      what_it_says: clip(scrub(p.body), 240),
    }));
    const series = R.weekly.map(w => w.share[b.name] || 0);
    let peak = null, rise = null;
    if (series.length) {
      const i = series.indexOf(Math.max(...series));
      peak = { week_of: weeks[i], share: pct(series[i]) };
      let best = 0, at = -1;
      for (let k = 1; k < series.length; k++) if (series[k] - series[k - 1] > best) { best = series[k] - series[k - 1]; at = k; }
      if (at > 0 && best >= 0.01) rise = { week_of: weeks[at], change: pts(100 * best) };
    }
    const d = prev && prev.has(b.name) ? 100 * (b.sov - prev.get(b.name)) : null;
    brandFacts[b.name] = {
      brand: b.name, unilever: b.isUnilever, owner: (ctx.P.study.find(x => x.brand_name === b.name) || {}).owner || null,
      share_of_voice: pct(b.sov), share_excluding_promotions: pct(b.noContest), engagement_share: pct(b.engagement),
      earned_share: pct(b.earned), share_of_all_earned_conversation: pct(b.public),
      change_since_previous_period: d != null && Math.abs(d) >= 0.5 ? pts(d) : 'about the same or no earlier period',
      voice_comes_from: b.origin ? { brand_pages: pct(b.origin.brand), brand_backed_creators: pct(b.origin.backed), earned: pct(b.origin.earned) } : 'too little to say',
      promotions_share_of_its_voice: pct(promo),
      audience_sentiment: b.sentiment ? { positive: pct(b.sentiment.positive), neutral: pct(b.sentiment.neutral), negative: pct(b.sentiment.negative) } : 'too little to say',
      what_earned_conversation_about_it_covers: themes,
      how_consumers_respond_to_it: responses,
      themes_in_negative_conversation: negThemes,
      themes_in_positive_conversation: posThemes,
      strongest_week: peak, biggest_weekly_rise: rise,
      content_that_carried_it: content,
    };
  }

  const leaders = R.publicRows.slice(0, 8).map(r => ({ brand: r.key, group: r.grp, share: pct(r.value) }));
  const leaderDetail = R.publicRows.slice(0, 5).map(r => {
    const rows = W.filter(m => m.brand === r.key && m.origin === 'earned');
    const metas = D.postMeta.filter(p => !p.owned && p.B.includes(r.key) && p.day >= R.start && p.day <= R.end);
    return { brand: r.key, group: r.grp, about: top(count(rows, m => (m.topics || []).map(topicName)), 3),
      who_creates_it: top(count(metas, p => (p.backed ? A.BACKED_SOURCE : A.AUTH[p.author] || null)), 3) };
  });

  const topicBrands = R.topics.slice(0, 8).map(t => {
    const rows = W.filter(m => m.origin === 'earned' && (m.topics || []).map(topicName).includes(t.key));
    return { theme: t.key, share: pct(t.value), brands_most_linked: top(count(rows, m => m.brand), 3) };
  });
  const typeBrands = R.types.slice(0, 6).map(t => {
    const rows = winConv.filter(c => (A.INTENT[c.type] || null) === t.key);
    return { response: t.key, share: pct(t.value), brands_most_linked: top(count(rows, c => c.B), 3),
      themes: top(count(rows, c => (c.topics || []).map(topicName)), 3) };
  });
  const sourceThemes = R.authors.slice(0, 6).map(a => {
    const metas = winMeta.filter(p => (p.backed ? A.BACKED_SOURCE : A.AUTH[p.author]) === a.key);
    return { source: a.key, share: pct(a.value), themes: top(count(metas, p => (p.topics || []).map(topicName)), 3),
      brands_most_linked: top(count(metas, p => p.B), 3) };
  });

  const common = {
    category: ctx.cat.name, period: R.label, country: 'Sri Lanka',
    unilever_brands: uni,
    unilever_share_of_voice: pct(R.brands.filter(b => b.isUnilever).reduce((a, b) => a + b.sov, 0)),
    unilever_share_of_earned_conversation: pct(R.brands.filter(b => b.isUnilever).reduce((a, b) => a + b.public, 0)),
  };
  const shareTable = [...R.brands].sort((a, b) => b.sov - a.sov).map(b => ({
    brand: b.name, unilever: b.isUnilever, share_of_voice: pct(b.sov), share_excluding_promotions: pct(b.noContest),
    engagement_share: pct(b.engagement), earned_share: pct(b.earned),
    change_since_previous_period: brandFacts[b.name].change_since_previous_period,
  }));
  const lead = [...R.brands].sort((a, b) => b.sov - a.sov)[0];
  const trendBrands = [...new Set([...uni, lead && lead.name].filter(Boolean))];

  const sections = {
    share: { chart: 'Share of voice by brand', ...common, brands: shareTable,
      biggest_brands: trendBrands.map(n => brandFacts[n]) },
    trend: { chart: 'Share of voice over time, week by week', ...common,
      weeks: weeks, brands: trendBrands.map(n => ({ brand: n, weekly_share: R.weekly.map(w => pct(w.share[n] || 0)),
        strongest_week: brandFacts[n].strongest_week, biggest_weekly_rise: brandFacts[n].biggest_weekly_rise,
        content_that_carried_it: brandFacts[n].content_that_carried_it })) },
    sentiment: { chart: 'Sentiment of consumer conversation by brand', ...common,
      brands: R.brands.map(b => ({ brand: b.name, unilever: b.isUnilever, sentiment: brandFacts[b.name].audience_sentiment,
        themes_in_negative_conversation: brandFacts[b.name].themes_in_negative_conversation,
        themes_in_positive_conversation: brandFacts[b.name].themes_in_positive_conversation })) },
    public: { chart: 'Who leads earned conversation (every brand, tracked or not)', ...common, leaders, leader_detail: leaderDetail },
    origin: { chart: "Where each brand's voice comes from: its own pages, brand-backed creators, or earned conversation", ...common,
      brands: R.brands.map(b => ({ brand: b.name, unilever: b.isUnilever, voice_comes_from: brandFacts[b.name].voice_comes_from,
        share_of_voice: pct(b.sov) })) },
  };
  if (R.topics.length) sections.topics = { chart: 'Conversation themes in earned conversation', ...common, themes: topicBrands };
  if (R.types.length) sections.intent = { chart: 'Conversation intent: what consumers do in the conversation', ...common, responses: typeBrands };
  if (R.authors.length) sections.source = { chart: 'Voice by source: who creates earned category content', ...common, sources: sourceThemes };

  // Who each panel speaks to, and the lines it may quote: the audience
  // anywhere, on brand pages too (brand replies were never kept).
  const conv = D.conv.filter(c => c.day >= R.start && c.day <= R.end);
  const aboutUni = c => (c.B || []).some(b => uni.includes(b));
  const quotes = {
    share: quoteCandidates(conv, aboutUni),
    trend: quoteCandidates(conv, aboutUni),
    sentiment: quoteCandidates(conv, c => (c.type === 'praise' || c.type === 'complaint') && (c.B || []).length),
    public: quoteCandidates(conv, c => (c.B || []).some(b => leaders.slice(0, 5).some(l => l.brand === b))),
    origin: quoteCandidates(conv, c => (c.B || []).length > 0),
    topics: quoteCandidates(conv, c => (c.topics || []).length > 0),
    intent: quoteCandidates(conv, c => ['question', 'purchase intent', 'recommendation request', 'comparison'].includes(c.type)),
    source: quoteCandidates(conv, () => true),
  };
  const panels = [];
  for (const [name, facts] of Object.entries(sections)) {
    panels.push({ key: `section:${name}`, facts, quotes: quotes[name] || [], forBrands: uni });
  }
  for (const b of R.brands) {
    const f = { chart: `${b.name}: the brand in detail`, ...common, brand_in_focus: brandFacts[b.name],
      category_leader: lead ? lead.name : null };
    panels.push({ key: `brand:${b.name}`, facts: f,
      quotes: quoteCandidates(conv, c => (c.B || []).includes(b.name)),
      forBrands: b.isUnilever ? [b.name] : uni });
  }
  return panels;
}

const PANEL_TOOL = {
  name: 'panel',
  description: 'The panel behind one chart.',
  input_schema: {
    type: 'object', required: ['read', 'drivers', 'implications', 'quotes'],
    properties: {
      read: { type: 'string', description: 'Two or three sentences: what this shows for this period.' },
      drivers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: 'What drove it, one finding per item.' },
      implications: { type: 'array', items: { type: 'object', required: ['brand', 'implication', 'next_step'], properties: {
        brand: { type: 'string' }, implication: { type: 'string' }, next_step: { type: 'string' } } } },
      quotes: { type: 'array', maxItems: 3, items: { type: 'object', required: ['qid', 'text'], properties: {
        qid: { type: 'string' }, text: { type: 'string', description: 'The line in natural English. Translate Sinhala, Tamil or Singlish faithfully; keep English lines as written, tidied only for spelling.' } } } },
    },
  },
};

const PANEL_PROMPT = `You write the "what's behind this" panel for one chart on a social share of voice page used by Unilever Sri Lanka brand teams and their agency.

You get the facts behind the chart, worked out from the data, and a list of things consumers said. Write:
- read: two or three plain sentences on what the chart shows for this period, most important first.
- drivers: one to four short findings on why it looks this way, taken from the facts: where a brand's voice comes from (its own pages, brand-backed creators, earned), promotions and giveaways, the themes consumers raise, sentiment drivers, the content that carried a brand, the strongest week, competitors or local sellers leading earned conversation. Only claim a reason the facts show. If the facts do not explain something, do not invent a reason.
- implications: one entry for each brand listed under "write implications for", in that order. implication: what this means for that brand, one or two sentences. next_step: one concrete, practical action for the brand team, one sentence.
- quotes: pick up to three consumer lines from the list that best show the point, by qid. Prefer variety. Give each in natural English: translate Sinhala, Tamil or Singlish faithfully without adding meaning; keep English as written. Leave quotes empty if none fit.

Rules for read, drivers, implication and next_step:
- Use only percentages and point changes exactly as they appear in the facts. No other numbers, counts, dates or week dates.
- Say "share of voice", "earned conversation", "brand content", "brand-backed creators", "consumer conversation", "social". Never say posts, comments, mentions, or the name of any social platform.
- Do not explain how the figures are made. Do not name individual people, creators or private accounts; brands and businesses are fine.
- No dashes used as punctuation. Plain British English, short sentences.`;

function checkPanel(out, facts, quoteList, forBrands) {
  if (!out || typeof out.read !== 'string') return 'no panel';
  const texts = [out.read, ...(out.drivers || [])];
  const imp = Array.isArray(out.implications) ? out.implications : [];
  for (const b of forBrands) {
    const i = imp.find(x => x && String(x.brand).toLowerCase() === b.toLowerCase());
    if (!i) return `no implication for ${b}`;
    texts.push(i.implication, i.next_step);
  }
  if (!Array.isArray(out.drivers) || !out.drivers.length) return 'no drivers';
  const problem = A.check(texts.map(t => String(t || '')), facts);
  if (problem) return problem;
  if (String(out.read).length > 700) return 'the read is too long';
  for (const q of out.quotes || []) {
    if (!quoteList.find(x => x.qid === q.qid)) return `${q.qid} is not one of the given lines`;
  }
  return null;
}

async function writeOne(ctx, p) {
  const ids = new Map(p.quotes.map(q => [q.qid, q]));
  const content = `Facts:\n${JSON.stringify(p.facts, null, 1)}\n\nWrite implications for: ${JSON.stringify(p.forBrands)}\n\nThings consumers said:\n${
    p.quotes.length ? p.quotes.map(q => JSON.stringify(q)).join('\n') : '(none)'}`;
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      const res = await L.getClient().messages.create({
        ...L.extrasForModel(), model: L.MODEL, max_tokens: 1400,
        system: [{ type: 'text', text: PANEL_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [PANEL_TOOL], tool_choice: { type: 'tool', name: 'panel' },
        messages: [{ role: 'user', content: content + feedback }],
      });
      const call = (res.content || []).find(x => x.type === 'tool_use');
      out = call ? call.input : null;
    } catch (e) {
      ctx.log(`panel ${p.key} call failed: ${e.message}`);
      continue;
    }
    const problem = checkPanel(out, p.facts, p.quotes, p.forBrands);
    if (!problem) {
      const implications = {};
      for (const b of p.forBrands) {
        const i = out.implications.find(x => String(x.brand).toLowerCase() === b.toLowerCase());
        implications[b] = { implication: String(i.implication).trim(), next_step: String(i.next_step).trim() };
      }
      const quotes = (out.quotes || []).slice(0, 3).map(q => {
        const src = ids.get(q.qid);
        let text = scrub(q.text);
        // A rendering far longer than the line has had something added.
        if (!text || text.length > src.text.length * 1.8 + 40) text = src.text;
        // Translated: the line was in Sinhala or Tamil script, or the English
        // shares under half its words with it (Singlish rendered in English).
        const words = t => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
        const a = words(src.text), z = words(text);
        const overlap = z.size ? [...z].filter(w => a.has(w)).length / z.size : 1;
        const translated = T.SINHALA.test(src.text) || T.TAMIL.test(src.text) || overlap < 0.5;
        return { text: clip(text, 220), translated, kind: src.kind };
      }).filter((q, i, all) => all.findIndex(x => x.text.toLowerCase() === q.text.toLowerCase()) === i);
      return { read: out.read.trim(), drivers: out.drivers.map(d => String(d).trim()).filter(Boolean), implications, quotes };
    }
    feedback = `\n\nYour previous answer was rejected: ${problem}. Write it again following every rule.`;
    ctx.log(`panel ${p.key} rejected: ${problem}`);
  }
  return null;
}

async function build(ctx, R, prev) {
  if (process.env.SOV_PANELS === 'off' || !process.env.ANTHROPIC_API_KEY) return {};
  const list = gather(ctx, R, prev);
  const out = {};
  let failed = 0;
  await L.pool(list, Number(process.env.SOV_LABEL_CONCURRENCY || 4), async p => {
    const panel = await writeOne(ctx, p);
    if (panel) out[p.key] = panel; else failed++;
  });
  ctx.log(`panels written: ${Object.keys(out).length}${failed ? `, ${failed} left out` : ''}`);
  return out;
}

module.exports = { build, gather, checkPanel, scrub };

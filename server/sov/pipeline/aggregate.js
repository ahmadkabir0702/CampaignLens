/**
 * From labelled content to the shares Campaign Lens shows. Same definitions
 * as the first manual run (docs/share-of-voice.md):
 *
 *   share of voice   a brand's share of every time a tracked brand was talked
 *                    about: brand content, earned content and the
 *                    conversation on both, pooled across social
 *   excl. promotions the same without giveaway content and promotion entries
 *   engagement       brand-weighted by the reactions content received
 *   earned           consumers, unpaid creators, sellers and media only:
 *                    brand pages and brand-backed creator content are left
 *                    out, the conversation on brand-backed content is in
 *   public           every brand named in earned conversation, tracked or not
 *   sentiment        audience only: brand and brand-backed content left out
 *
 * Where a brand's voice comes from (voice_origin): its own pages (with the
 * conversation on them), brand-backed creator content, and earned.
 *
 * A monthly category's period is the last full calendar month. A weekly one
 * uses a rolling window (window_days, normally 28) ending on the last full
 * week. The weekly chart shows 12 full weeks either way.
 */
const T = require('./text');

const DAY = 86400000;
const OFFSET = 5.5 * 3600000;   // Sri Lanka time
const localDay = d => new Date(new Date(d).getTime() + OFFSET).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };

/** The last full calendar month before `now`, Sri Lanka time, or the month `iso` falls in. */
function monthOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}
function lastFullMonth(now = new Date()) {
  const today = localDay(now);
  const [y, m] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return monthOf(prev);
}
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = iso => { const [y, m] = iso.split('-').map(Number); return `${MONTH_LONG[m - 1]} ${y}`; };
/** The Sunday on or before an ISO day. */
const sundayOnOrBefore = iso => { const dow = new Date(iso + 'T00:00:00Z').getUTCDay(); return addDays(iso, -dow); };

/** The last Sunday before `now`, Sri Lanka time: the end of the last full week. */
function lastFullWeekEnd(now = new Date()) {
  const today = localDay(now);
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  return addDays(today, dow === 0 ? -7 : -dow);
}

const INTENT = {
  reaction: 'Reactions', question: 'Questions', praise: 'Praise', 'purchase intent': 'Purchase intent',
  'tag/mention friend': 'Social sharing', complaint: 'Complaints', 'recommendation request': 'Recommendation seeking',
  comparison: 'Brand comparison', 'contest entry': 'Promotion entries',
};
const AUTH = {
  'small seller': 'Small sellers', 'influencer/creator': 'Creators', 'brand official': 'Brands',
  consumer: 'Consumers', 'media/other': 'Media and publishers',
};
const BACKED_SOURCE = 'Brand partnerships';
const ORIGIN = { brand: 'Brand pages', backed: 'Brand-backed creators', earned: 'Earned' };

async function load(ctx, from) {
  const { q, cat } = ctx;
  const { rows: posts } = await q(
    `select platform, post_id, source, owner_brand, backed_brand, published_at, likes, comments, shares, label, body
       from sov_raw_posts
      where category_id = $1 and is_sri_lanka and (label->>'relevant')::boolean and published_at >= $2`,
    [cat.category_id, from]);
  const { rows: comments } = await q(
    `select c.platform, c.post_id, c.published_at, c.likes, c.label, c.body, c.kind
       from sov_raw_comments c
       join sov_raw_posts p using (category_id, platform, post_id)
      where c.category_id = $1 and c.label is not null and not c.is_brand_reply
        and p.is_sri_lanka and (p.label->>'relevant')::boolean and p.published_at >= $2
        and c.label->>'type' <> 'off-topic/spam'`,
    [cat.category_id, from]);
  return { posts, comments };
}

/**
 * One row per brand per piece of content or conversation that talks about it.
 *   origin  'brand'   the brand's own content, and the conversation on its
 *                     own pages
 *           'backed'  creator content made with a brand (collab, paid
 *                     partnership label, disclosure tag)
 *           'earned'  everything else, including the conversation on
 *                     brand-backed content
 */
function mentionsFrom({ posts, comments }, P) {
  const studyNames = new Set(P.study.map(b => b.brand_name));
  const byKey = new Map();
  const out = [];
  for (const p of posts) {
    const L = p.label || {};
    const B = new Set(((L.brands) || []).map(b => T.canonBrand(b, P)).filter(Boolean));
    const owned = p.source === 'owned';
    const backedBrand = p.backed_brand ? T.canonBrand(p.backed_brand, P) : null;
    if (owned && p.owner_brand) B.add(p.owner_brand);
    if (backedBrand) B.add(backedBrand);
    const origin = backedBrand ? 'backed' : owned ? 'brand' : 'earned';
    const key = p.platform + '|' + p.post_id;
    const meta = { key, B: [...B], owned, backed: !!backedBrand, backedBrand, owner: p.owner_brand, origin,
      theme: L.theme, author: L.author_type, topics: L.topics || [], day: localDay(p.published_at),
      eng: Number(p.likes || 0) + Number(p.comments || 0) + Number(p.shares || 0), body: p.body };
    byKey.set(key, meta);
    for (const b of B) out.push({
      brand: b, study: studyNames.has(b), owned, origin, isPost: true, platform: p.platform, day: meta.day, key,
      eng: meta.eng, sent: L.sentiment, contest: L.theme === 'giveaway/contest', topics: meta.topics,
    });
  }
  const conv = [];
  for (const c of comments) {
    const meta = byKey.get(c.platform + '|' + c.post_id);
    if (!meta) continue;
    const L = c.label || {};
    const lb = new Set((L.brands || []).map(b => T.canonBrand(b, P)).filter(Boolean));
    let B;
    if (meta.owned) {
      const others = [...lb].filter(b => b !== meta.owner);
      B = !others.length || L.type === 'comparison' ? [...new Set([...lb, meta.owner])] : [...lb];
    } else {
      const inPost = meta.B.filter(b => studyNames.has(b));
      B = lb.size ? [...lb] : inPost.length === 1 ? inPost : [];
    }
    // Conversation on a brand's own page is the brand's; on a collab or any
    // other brand-backed content it is the audience's, so earned.
    const onBrandPage = meta.owned && !meta.backed;
    const origin = onBrandPage ? 'brand' : 'earned';
    const day = localDay(c.published_at || Date.now());
    const row = { owned: onBrandPage, origin, type: L.type, topics: L.topics || [], B, day, sent: L.sentiment,
      likes: Number(c.likes || 0), body: c.body, kind: c.kind, postKey: meta.key, sameReply: !!L.same_reply };
    conv.push(row);
    for (const b of B) out.push({
      brand: b, study: studyNames.has(b), owned: onBrandPage, origin, isPost: false, platform: c.platform, day, key: meta.key,
      eng: 1 + Number(c.likes || 0), sent: L.sentiment, contest: L.type === 'contest entry' || L.type === 'tag/mention friend',
      topics: L.topics || [], type: L.type,
    });
  }
  return { mentions: out, postMeta: [...byKey.values()], conv };
}

function shares(rows, names, weight = () => 1) {
  const t = Object.fromEntries(names.map(n => [n, 0]));
  for (const m of rows) if (m.study) t[m.brand] += weight(m);
  const tot = Object.values(t).reduce((a, b) => a + b, 0);
  return { tot, share: Object.fromEntries(names.map(n => [n, tot ? t[n] / tot : 0])) };
}

function distribution(items, keyOf) {
  const c = new Map();
  let tot = 0;
  for (const it of items) for (const k of [].concat(keyOf(it) || [])) { if (!k) continue; c.set(k, (c.get(k) || 0) + 1); tot++; }
  return { tot, rows: [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, value: tot ? n / tot : 0 })) };
}

function compute(ctx, data, period) {
  const { P, cfg } = ctx;
  const { start, end: periodEnd } = period;
  const names = P.study.map(b => b.brand_name);
  const uni = new Set(P.study.filter(b => b.is_unilever).map(b => b.brand_name));
  const { mentions, postMeta, conv } = mentionsFrom(data, P);
  const inWin = m => m.day >= start && m.day <= periodEnd;
  const W = mentions.filter(inWin);
  const earnedOnly = m => m.origin === 'earned';

  const sov = shares(W, names);
  const noContest = shares(W.filter(m => !m.contest), names);
  const engagement = shares(W.filter(m => m.isPost), names, m => m.eng);
  const earned = shares(W.filter(earnedOnly), names);
  const platforms = {};
  for (const pl of ['facebook', 'instagram', 'tiktok']) platforms[pl] = shares(W.filter(m => m.platform === pl), names).share;

  // Earned conversation: every brand, tracked or not.
  const pub = new Map(); let pubTot = 0;
  for (const m of W) if (earnedOnly(m)) { pub.set(m.brand, (pub.get(m.brand) || 0) + 1); pubTot++; }
  const groupOf = b => {
    if (uni.has(b)) return 'Unilever';
    if (names.includes(b)) return 'Competitor';
    const o = P.others.find(x => x.name === b);
    return o ? o.group : 'Other brand';
  };
  const publicRows = [...pub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([b, n]) => ({ key: b, grp: groupOf(b), value: pubTot ? n / pubTot : 0 }));
  const publicShare = Object.fromEntries(names.map(n => [n, pubTot ? (pub.get(n) || 0) / pubTot : 0]));

  // Audience sentiment: brand and brand-backed content are not the audience.
  const audience = m => !(m.isPost && m.origin !== 'earned');
  const minSent = Number(process.env.SOV_MIN_SENTIMENT_BASE || 10);
  const sentiment = {};
  for (const n of names) {
    const rows = W.filter(m => m.brand === n && audience(m) && m.sent);
    if (rows.length < minSent) { sentiment[n] = null; continue; }
    const c = s => rows.filter(m => m.sent === s).length / rows.length;
    sentiment[n] = { positive: c('positive'), neutral: c('neutral'), negative: c('negative') };
  }

  // Where each brand's voice comes from.
  const origin = {};
  for (const n of names) {
    const rows = W.filter(m => m.brand === n);
    const tot = rows.length;
    origin[n] = tot ? Object.fromEntries(Object.keys(ORIGIN).map(k => [k, rows.filter(m => m.origin === k).length / tot])) : null;
  }

  // Weekly shares: 12 full weeks, Monday to Sunday, ending on the last
  // Sunday in the period.
  const weekly = [];
  const lastSunday = sundayOnOrBefore(periodEnd);
  for (let i = 11; i >= 0; i--) {
    const wEnd = addDays(lastSunday, -7 * i), wStart = addDays(wEnd, -6);
    const s = shares(mentions.filter(m => m.day >= wStart && m.day <= wEnd), names);
    if (s.tot) weekly.push({ week: wStart, share: s.share });
  }

  // The category view: content outside brand pages that the brands did not
  // make, and the audience conversation.
  const winMeta = postMeta.filter(p => !p.owned && p.day >= start && p.day <= periodEnd);
  const winConv = conv.filter(c => !c.owned && c.day >= start && c.day <= periodEnd);
  const topicName = k => (cfg.topics || {})[k] || k;
  const topics = distribution([...winMeta.filter(p => !p.backed).map(p => p.topics), ...winConv.map(c => c.topics)], x => x.map(topicName));
  const types = distribution(winConv, c => INTENT[c.type] || null);
  const authors = distribution(winMeta, p => (p.backed ? BACKED_SOURCE : AUTH[p.author] || null));

  return {
    start, end: periodEnd, base: sov.tot, publicBase: pubTot,
    brands: names.map(n => ({
      name: n, isUnilever: uni.has(n),
      sov: sov.share[n], noContest: noContest.share[n], engagement: engagement.share[n], earned: earned.share[n],
      public: publicShare[n], sentiment: sentiment[n], origin: origin[n],
      facebook: platforms.facebook[n], instagram: platforms.instagram[n], tiktok: platforms.tiktok[n],
    })),
    earnedBase: earned.tot,
    weekly, publicRows,
    topics: topics.tot >= 30 ? topics.rows.slice(0, 13) : [],
    types: types.tot >= 30 ? types.rows : [],
    authors: authors.tot >= 20 ? authors.rows : [],
    // For the "what's behind this" panels only; never published.
    detail: { W, mentions, postMeta, conv, winMeta, winConv, topicName, groupOf },
  };
}

// ── Summary sentences ───────────────────────────────────────────────────────
const pct = v => `${(100 * v).toFixed(1)}%`;
const BANNED = /\b(posts?|comments?|mentions?|facebook|instagram|tiktok|methodology|scraped?|scraping|sample|dataset|labell?ed|labell?ing|model|AI|Claude)\b|[—–]/i;

function facts(ctx, R, prev) {
  const sorted = [...R.brands].sort((a, b) => b.sov - a.sov);
  const uniShare = R.brands.filter(b => b.isUnilever).reduce((a, b) => a + b.sov, 0);
  const uniPublic = R.brands.filter(b => b.isUnilever).reduce((a, b) => a + b.public, 0);
  const f = {
    category: ctx.cat.name,
    period: R.label,
    unilever_share_of_voice: pct(uniShare),
    unilever_share_of_earned_public_conversation: pct(uniPublic),
    brands_by_share_of_voice: sorted.map(b => ({
      brand: b.name, unilever: b.isUnilever, share_of_voice: pct(b.sov), share_excluding_promotions: pct(b.noContest),
      engagement_share: pct(b.engagement), earned_share: pct(b.earned),
      voice_comes_from: b.origin ? { brand_pages: pct(b.origin.brand), brand_backed_creators: pct(b.origin.backed), earned: pct(b.origin.earned) } : 'too little to say',
      audience_sentiment: b.sentiment ? { positive: pct(b.sentiment.positive), negative: pct(b.sentiment.negative) } : 'too little to say',
    })),
    public_conversation_leaders: R.publicRows.slice(0, 5).map(r => ({ brand: r.key, group: r.grp, share: pct(r.value) })),
    leading_themes: R.topics.slice(0, 4).map(t => ({ theme: t.key, share: pct(t.value) })),
    consumer_response_types: R.types.slice(0, 4).map(t => ({ type: t.key, share: pct(t.value) })),
    who_creates_category_content: R.authors.slice(0, 3).map(t => ({ who: t.key, share: pct(t.value) })),
  };
  if (prev && prev.size) {
    f.change_since_previous_period = sorted
      .map(b => ({ brand: b.name, d: prev.has(b.name) ? 100 * (b.sov - prev.get(b.name)) : null }))
      .filter(x => x.d != null && Math.abs(x.d) >= 1)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 4)
      .map(x => ({ brand: x.brand, change: `${x.d > 0 ? 'up' : 'down'} ${Math.abs(x.d).toFixed(1)} points` }));
  }
  return f;
}

/** Every number in a sentence must be one of the percentages or point changes in the facts. */
function check(sentences, f) {
  const allowed = new Set();
  JSON.stringify(f).replace(/\d+(?:\.\d+)?%|\d+(?:\.\d+)? points/g, m => { allowed.add(m); return m; });
  for (const s of sentences) {
    if (typeof s !== 'string' || s.length < 20 || s.length > 400) return 'a sentence is empty or too long';
    if (BANNED.test(s)) return `"${s.match(BANNED)[0]}" is not allowed`;
    const nums = s.match(/\d+(?:\.\d+)?(?:%| percentage points| points)?/g) || [];
    for (const n of nums) {
      const k = n.replace(' percentage points', ' points');
      if (!allowed.has(k)) return `${n} is not one of the given figures`;
    }
  }
  return null;
}

const INSIGHT_TOOL = {
  name: 'summary',
  description: 'The summary sentences.',
  input_schema: { type: 'object', required: ['sentences'], properties: { sentences: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 } } },
};
const INSIGHT_PROMPT = `You write the summary on a share of voice page for Unilever Sri Lanka brand teams.
Write 4 or 5 short sentences, most important first, from the facts given. Plain British English, no jargon beyond the industry terms below, no headings.

Rules:
- Use only percentages and point changes exactly as they appear in the facts. No other numbers, counts or dates.
- Say "share of voice", "earned conversation", "brand content", "consumer conversation", "social". Never say posts, comments, mentions, or the name of any social platform.
- Do not explain how the figures are made.
- No dashes used as punctuation.
- Lead with where Unilever brands stand, then who leads earned conversation, then what consumers talk about, then any notable change.`;

function template(f) {
  const s = [];
  const b = f.brands_by_share_of_voice;
  s.push(`Unilever brands hold ${f.unilever_share_of_voice} of ${f.category.toLowerCase()} share of voice. ${b[0].brand} leads at ${b[0].share_of_voice}, followed by ${b[1].brand} (${b[1].share_of_voice}) and ${b[2].brand} (${b[2].share_of_voice}).`);
  s.push(`In earned conversation on social, Unilever brands hold ${f.unilever_share_of_earned_public_conversation} of voice.`);
  const pl = f.public_conversation_leaders;
  if (pl.length >= 2) s.push(`Earned conversation is led by ${pl[0].brand} at ${pl[0].share}, followed by ${pl[1].brand} at ${pl[1].share}.`);
  const th = f.leading_themes;
  if (th.length >= 3) s.push(`The leading themes in consumer conversation are ${th[0].theme.toLowerCase()} (${th[0].share}), ${th[1].theme.toLowerCase()} (${th[1].share}) and ${th[2].theme.toLowerCase()} (${th[2].share}).`);
  const ch = f.change_since_previous_period || [];
  if (ch.length) s.push(`Since the previous period, ${ch.slice(0, 2).map(c => `${c.brand} is ${c.change}`).join(' and ')} in share of voice.`);
  return s;
}

async function writeInsights(ctx, f) {
  if (process.env.SOV_INSIGHTS === 'template' || !process.env.ANTHROPIC_API_KEY) return { sentences: template(f), source: 'template' };
  const L = require('./label');
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await L.getClient().messages.create({
        ...L.extrasForModel(), model: L.MODEL, max_tokens: 900,
        system: INSIGHT_PROMPT, tools: [INSIGHT_TOOL], tool_choice: { type: 'tool', name: 'summary' },
        messages: [{ role: 'user', content: `Facts:\n${JSON.stringify(f, null, 1)}${feedback}` }],
      });
      const call = (res.content || []).find(x => x.type === 'tool_use');
      const sentences = call && Array.isArray(call.input.sentences) ? call.input.sentences.map(x => String(x).trim()) : [];
      const problem = sentences.length < 3 ? 'too few sentences' : check(sentences, f);
      if (!problem) return { sentences, source: 'model' };
      feedback = `\n\nYour previous attempt was rejected: ${problem}. Write it again following every rule.`;
      ctx.log(`summary rejected: ${problem}`);
    } catch (e) {
      ctx.log(`summary call failed: ${e.message}`);
    }
  }
  return { sentences: template(f), source: 'template' };
}

// ── Publish ─────────────────────────────────────────────────────────────────
async function publish(ctx, R, insights, panels) {
  const { db, cat, cfg } = ctx;
  const live = cfg.auto_publish !== false;
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`delete from sov_periods where category_id = $1 and period_start = $2 and period_end = $3`, [cat.category_id, R.start, R.end]);
    const { rows: [p] } = await client.query(
      `insert into sov_periods (category_id, period_start, period_end, label, insights, is_published, cadence)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning period_id`,
      [cat.category_id, R.start, R.end, R.label, JSON.stringify(insights), live, cfg.cadence || 'weekly']);
    for (const b of R.brands) {
      await client.query(
        `insert into sov_brand_metrics (period_id, brand_name, share_of_voice, share_no_contest, share_engagement, share_earned, share_public,
            sentiment_positive, sentiment_neutral, sentiment_negative, share_facebook, share_instagram, share_tiktok)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.period_id, b.name, b.sov, b.noContest, b.engagement, b.earned, b.public,
         b.sentiment ? b.sentiment.positive : null, b.sentiment ? b.sentiment.neutral : null, b.sentiment ? b.sentiment.negative : null,
         b.facebook, b.instagram, b.tiktok]);
    }
    const rows = [];
    R.weekly.forEach((w, i) => R.brands.forEach(b => rows.push(['weekly_share', w.week, b.name, null, w.share[b.name], i])));
    R.publicRows.forEach((r, i) => rows.push(['public_brand', r.key, '', r.grp, r.value, i]));
    R.topics.forEach((r, i) => rows.push(['topic', r.key, '', null, r.value, i]));
    R.types.forEach((r, i) => rows.push(['comment_type', r.key, '', null, r.value, i]));
    R.authors.forEach((r, i) => rows.push(['author_type', r.key, '', null, r.value, i]));
    R.brands.forEach((b, i) => { if (b.origin) Object.entries(ORIGIN).forEach(([k, label]) => rows.push(['voice_origin', label, b.name, null, b.origin[k], i])); });
    for (const r of rows) {
      await client.query(
        `insert into sov_breakdowns (period_id, dimension, key, brand_name, grp, value, sort_order) values ($1,$2,$3,$4,$5,$6,$7)`,
        [p.period_id, ...r]);
    }
    for (const [key, content] of Object.entries(panels || {})) {
      await client.query(`insert into sov_panels (period_id, panel_key, content) values ($1, $2, $3::jsonb)`,
        [p.period_id, key, JSON.stringify(content)]);
    }
    await client.query('commit');
    return p.period_id;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function periodFor(ctx) {
  const { cfg } = ctx;
  if (cfg.cadence === 'monthly') return ctx.periodEnd ? monthOf(ctx.periodEnd) : lastFullMonth();
  const end = ctx.periodEnd || lastFullWeekEnd();
  return { start: addDays(end, -(cfg.window_days || 28) + 1), end };
}

async function previousShares(ctx, R) {
  const { q, cat, cfg } = ctx;
  const { rows } = cfg.cadence === 'monthly'
    ? await q(
      `select m.brand_name, m.share_of_voice from sov_brand_metrics m
         join sov_periods p using (period_id)
        where p.category_id = $1 and p.is_published and p.cadence = 'monthly' and p.period_end = $2::date - 1
        order by p.period_id desc`, [cat.category_id, R.start])
    : await q(
      `select m.brand_name, m.share_of_voice from sov_brand_metrics m
         join sov_periods p using (period_id)
        where p.category_id = $1 and p.is_published and p.period_end < $2
          and p.period_end - p.period_start between $3 - 3 and $3 + 3
        order by p.period_end desc limit 100`, [cat.category_id, R.end, (cfg.window_days || 28) - 1]);
  const prev = new Map();
  for (const r of rows) if (!prev.has(r.brand_name)) prev.set(r.brand_name, Number(r.share_of_voice));
  return prev;
}

async function run(ctx) {
  const { cfg, log } = ctx;
  const period = periodFor(ctx);
  // Enough history for the period and the 12-week chart that ends with it.
  const chartStart = addDays(sundayOnOrBefore(period.end), -7 * 12 - 1);
  const from = new Date(Date.parse((period.start < chartStart ? period.start : chartStart) + 'T00:00:00Z'));
  const data = await load(ctx, from);
  const R = compute(ctx, data, period);
  if (cfg.cadence === 'monthly') R.label = monthLabel(R.start);
  else {
    const weeks = Math.round((cfg.window_days || 28) / 7);
    R.label = `last ${weeks} weeks, ${nice(R.start)} to ${nice(R.end)} ${R.end.slice(0, 4)}`;
  }
  ctx.stats.period = { start: R.start, end: R.end, label: R.label };

  const minBase = Number(process.env.SOV_MIN_MENTIONS || 200);
  if (R.base < minBase) {
    log(`not published: too little in the window to be reliable`);
    ctx.stats.published = false;
    ctx.stats.notPublishedReason = 'too little conversation in the window';
    return { published: false, R };
  }

  const prev = await previousShares(ctx, R);
  const f = facts(ctx, R, prev);
  const ins = await writeInsights(ctx, f);
  let panels = {};
  try {
    panels = await require('./panels').build(ctx, R, prev);
  } catch (e) {
    log(`panels skipped: ${e.message}`);
  }
  const periodId = await publish(ctx, R, ins.sentences, panels);
  const live = cfg.auto_publish !== false;
  Object.assign(ctx.stats, { published: live, awaitingReview: !live, periodId, insightsFrom: ins.source, panels: Object.keys(panels).length });
  log(live ? `published ${R.label}` : `saved ${R.label} for review (period ${periodId}); not on the page yet`);
  return { published: live, R, periodId, insights: ins.sentences };
}

async function purge(ctx) {
  const { q, cat } = ctx;
  const keep = Number(process.env.SOV_KEEP_DAYS || 130);
  const r = await q(`delete from sov_raw_posts where category_id = $1 and published_at < now() - ($2 || ' days')::interval`, [cat.category_id, String(keep)]);
  await q(`delete from sov_creators where checked_at < now() - interval '180 days'`);
  await q(`delete from sov_runs where category_id = $1 and started_at < now() - interval '1 year'`, [cat.category_id]);
  ctx.stats.purged = r.rowCount || 0;
}

module.exports = { run, purge, compute, facts, check, template, lastFullWeekEnd, lastFullMonth, monthOf, monthLabel, addDays, localDay, pct, BANNED, ORIGIN, INTENT, AUTH, BACKED_SOURCE };

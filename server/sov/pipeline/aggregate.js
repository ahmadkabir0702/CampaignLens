/**
 * From labelled content to the shares Campaign Lens shows. Same definitions
 * as the first manual run (docs/share-of-voice.md):
 *
 *   share of voice   a brand's share of every time a tracked brand was talked
 *                    about: brand content, earned content and the
 *                    conversation on both, pooled across social
 *   excl. promotions the same without giveaway content and promotion entries
 *   engagement       brand-weighted by the reactions content received
 *   earned           outside the brands' own pages only
 *   public           every brand named outside brand pages, tracked or not
 *   sentiment        audience only: the brand's own content is left out
 *
 * The headline uses a rolling window (window_days, normally 28) ending on
 * the last full week. The weekly chart shows 12 full weeks.
 */
const T = require('./text');

const DAY = 86400000;
const OFFSET = 5.5 * 3600000;   // Sri Lanka time
const localDay = d => new Date(new Date(d).getTime() + OFFSET).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };

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

async function load(ctx, from) {
  const { q, cat } = ctx;
  const { rows: posts } = await q(
    `select platform, post_id, source, owner_brand, published_at, likes, comments, shares, label
       from sov_raw_posts
      where category_id = $1 and is_sri_lanka and (label->>'relevant')::boolean and published_at >= $2`,
    [cat.category_id, from]);
  const { rows: comments } = await q(
    `select c.platform, c.post_id, c.published_at, c.likes, c.label
       from sov_raw_comments c
       join sov_raw_posts p using (category_id, platform, post_id)
      where c.category_id = $1 and c.label is not null and not c.is_brand_reply
        and p.is_sri_lanka and (p.label->>'relevant')::boolean and p.published_at >= $2
        and c.label->>'type' <> 'off-topic/spam'`,
    [cat.category_id, from]);
  return { posts, comments };
}

/** One row per brand per piece of content or conversation that talks about it. */
function mentionsFrom({ posts, comments }, P) {
  const studyNames = new Set(P.study.map(b => b.brand_name));
  const byKey = new Map();
  const out = [];
  for (const p of posts) {
    const L = p.label || {};
    const B = new Set(((L.brands) || []).map(b => T.canonBrand(b, P)).filter(Boolean));
    if (p.source === 'owned' && p.owner_brand) B.add(p.owner_brand);
    const meta = { B: [...B], owned: p.source === 'owned', owner: p.owner_brand, theme: L.theme, author: L.author_type, topics: L.topics || [] };
    byKey.set(p.platform + '|' + p.post_id, meta);
    for (const b of B) out.push({
      brand: b, study: studyNames.has(b), owned: meta.owned, isPost: true, platform: p.platform, day: localDay(p.published_at),
      eng: Number(p.likes || 0) + Number(p.comments || 0) + Number(p.shares || 0), sent: L.sentiment,
      contest: L.theme === 'giveaway/contest',
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
    const day = localDay(c.published_at || Date.now());
    conv.push({ owned: meta.owned, type: L.type, topics: L.topics || [], B, day });
    for (const b of B) out.push({
      brand: b, study: studyNames.has(b), owned: meta.owned, isPost: false, platform: c.platform, day,
      eng: 1 + Number(c.likes || 0), sent: L.sentiment, contest: L.type === 'contest entry' || L.type === 'tag/mention friend',
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

function compute(ctx, data, periodEnd) {
  const { P, cfg } = ctx;
  const names = P.study.map(b => b.brand_name);
  const uni = new Set(P.study.filter(b => b.is_unilever).map(b => b.brand_name));
  const start = addDays(periodEnd, -(cfg.window_days || 28) + 1);
  const { mentions, postMeta, conv } = mentionsFrom(data, P);
  const inWin = m => m.day >= start && m.day <= periodEnd;
  const W = mentions.filter(inWin);

  const sov = shares(W, names);
  const noContest = shares(W.filter(m => !m.contest), names);
  const engagement = shares(W.filter(m => m.isPost), names, m => m.eng);
  const earned = shares(W.filter(m => !m.owned), names);
  const platforms = {};
  for (const pl of ['facebook', 'instagram', 'tiktok']) platforms[pl] = shares(W.filter(m => m.platform === pl), names).share;

  // Public conversation: every brand, tracked or not, outside brand pages.
  const pub = new Map(); let pubTot = 0;
  for (const m of W) if (!m.owned) { pub.set(m.brand, (pub.get(m.brand) || 0) + 1); pubTot++; }
  const groupOf = b => {
    if (uni.has(b)) return 'Unilever';
    if (names.includes(b)) return 'Competitor';
    const o = P.others.find(x => x.name === b);
    return o ? o.group : 'Other brand';
  };
  const publicRows = [...pub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([b, n]) => ({ key: b, grp: groupOf(b), value: pubTot ? n / pubTot : 0 }));
  const publicShare = Object.fromEntries(names.map(n => [n, pubTot ? (pub.get(n) || 0) / pubTot : 0]));

  const minSent = Number(process.env.SOV_MIN_SENTIMENT_BASE || 10);
  const sentiment = {};
  for (const n of names) {
    const rows = W.filter(m => m.brand === n && !(m.owned && m.isPost) && m.sent);
    if (rows.length < minSent) { sentiment[n] = null; continue; }
    const c = s => rows.filter(m => m.sent === s).length / rows.length;
    sentiment[n] = { positive: c('positive'), neutral: c('neutral'), negative: c('negative') };
  }

  // Weekly shares: 12 full weeks, Monday to Sunday.
  const weekly = [];
  for (let i = 11; i >= 0; i--) {
    const wEnd = addDays(periodEnd, -7 * i), wStart = addDays(wEnd, -6);
    const s = shares(mentions.filter(m => m.day >= wStart && m.day <= wEnd), names);
    if (s.tot) weekly.push({ week: wStart, share: s.share });
  }

  // The category view: content and conversation outside brand pages.
  const winPosts = data.posts.filter(p => p.source !== 'owned' && localDay(p.published_at) >= start && localDay(p.published_at) <= periodEnd);
  const winConv = conv.filter(c => !c.owned && c.day >= start && c.day <= periodEnd);
  const topicName = k => (cfg.topics || {})[k] || k;
  const topics = distribution([...winPosts.map(p => (p.label || {}).topics || []), ...winConv.map(c => c.topics)], x => x.map(topicName));
  const types = distribution(winConv, c => INTENT[c.type] || null);
  const authors = distribution(winPosts, p => AUTH[(p.label || {}).author_type] || null);

  return {
    start, end: periodEnd, base: sov.tot, publicBase: pubTot,
    brands: names.map(n => ({
      name: n, isUnilever: uni.has(n),
      sov: sov.share[n], noContest: noContest.share[n], engagement: engagement.share[n], earned: earned.share[n],
      public: publicShare[n], sentiment: sentiment[n],
      facebook: platforms.facebook[n], instagram: platforms.instagram[n], tiktok: platforms.tiktok[n],
    })),
    earnedBase: earned.tot,
    weekly, publicRows,
    topics: topics.tot >= 30 ? topics.rows.slice(0, 13) : [],
    types: types.tot >= 30 ? types.rows : [],
    authors: authors.tot >= 20 ? authors.rows : [],
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
async function publish(ctx, R, insights) {
  const { db, cat } = ctx;
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`delete from sov_periods where category_id = $1 and period_start = $2 and period_end = $3`, [cat.category_id, R.start, R.end]);
    const { rows: [p] } = await client.query(
      `insert into sov_periods (category_id, period_start, period_end, label, insights, is_published)
       values ($1, $2, $3, $4, $5::jsonb, true) returning period_id`,
      [cat.category_id, R.start, R.end, R.label, JSON.stringify(insights)]);
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
    for (const r of rows) {
      await client.query(
        `insert into sov_breakdowns (period_id, dimension, key, brand_name, grp, value, sort_order) values ($1,$2,$3,$4,$5,$6,$7)`,
        [p.period_id, ...r]);
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

async function run(ctx) {
  const { q, cat, cfg, log } = ctx;
  const periodEnd = ctx.periodEnd || lastFullWeekEnd();
  const from = new Date(Date.parse(addDays(periodEnd, -7 * 12 - 1) + 'T00:00:00Z'));
  const data = await load(ctx, from);
  const R = compute(ctx, data, periodEnd);
  const weeks = Math.round((cfg.window_days || 28) / 7);
  R.label = `last ${weeks} weeks, ${nice(R.start)} to ${nice(R.end)} ${R.end.slice(0, 4)}`;
  ctx.stats.period = { start: R.start, end: R.end, label: R.label };

  const minBase = Number(process.env.SOV_MIN_MENTIONS || 200);
  if (R.base < minBase) {
    log(`not published: too little in the window to be reliable`);
    ctx.stats.published = false;
    ctx.stats.notPublishedReason = 'too little conversation in the window';
    return { published: false, R };
  }

  const { rows: prevRows } = await q(
    `select m.brand_name, m.share_of_voice from sov_brand_metrics m
       join sov_periods p using (period_id)
      where p.category_id = $1 and p.is_published and p.period_end < $2
        and p.period_end - p.period_start between $3 - 3 and $3 + 3
      order by p.period_end desc limit 100`, [cat.category_id, R.end, (cfg.window_days || 28) - 1]);
  const prev = new Map();
  for (const r of prevRows) if (!prev.has(r.brand_name)) prev.set(r.brand_name, Number(r.share_of_voice));

  const f = facts(ctx, R, prev);
  const ins = await writeInsights(ctx, f);
  const periodId = await publish(ctx, R, ins.sentences);
  Object.assign(ctx.stats, { published: true, periodId, insightsFrom: ins.source });
  log(`published ${R.label}`);
  return { published: true, R, periodId, insights: ins.sentences };
}

async function purge(ctx) {
  const { q, cat } = ctx;
  const keep = Number(process.env.SOV_KEEP_DAYS || 130);
  const r = await q(`delete from sov_raw_posts where category_id = $1 and published_at < now() - ($2 || ' days')::interval`, [cat.category_id, String(keep)]);
  await q(`delete from sov_creators where checked_at < now() - interval '180 days'`);
  await q(`delete from sov_runs where category_id = $1 and started_at < now() - interval '1 year'`, [cat.category_id]);
  ctx.stats.purged = r.rowCount || 0;
}

module.exports = { run, purge, compute, facts, check, template, lastFullWeekEnd, addDays, localDay };

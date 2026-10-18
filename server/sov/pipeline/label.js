/**
 * Labelling with Claude. Each new post gets: relevant to the category or not,
 * who wrote it, what kind of content it is, which brands it is about, themes
 * and sentiment. Each new comment gets: what kind of response it is, sentiment,
 * brands and themes. Labels are stored once and never redone.
 *
 * Emoji-only, empty and tag-only replies are labelled by rule, as in the
 * first manual run, so they cost nothing.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { extrasFor } = require('../../chat/router');
const T = require('./text');

const MODEL = process.env.SOV_LABEL_MODEL || 'claude-sonnet-5';
const POST_BATCH = 40;
const COMMENT_BATCH = 70;
const CONCURRENCY = Number(process.env.SOV_LABEL_CONCURRENCY || 4);

const AUTHOR = ['brand official', 'influencer/creator', 'small seller', 'consumer', 'media/other'];
const THEME = ['product promo', 'new launch/variant', 'giveaway/contest', 'event/activation', 'education/tips',
  'review/recommendation', 'price/offer', 'entertainment/meme', 'ASMR/demo', 'sales listing', 'other'];
const SENT = ['positive', 'neutral', 'negative'];
const CTYPE = ['praise', 'complaint', 'question', 'purchase intent', 'recommendation request', 'contest entry',
  'tag/mention friend', 'reaction', 'comparison', 'off-topic/spam'];

const POS = new Set([...'❤😍🥰😘💕💖💗💓💞💘💝🔥👍👌💯🙌👏😊☺🤩✨💜💙💚🧡💛🤍♥😻🌹🌸💐🙏🥳😁😀😃😄🤗💪⭐🌟']);
const NEG = new Set([...'😡🤬👎😤😠💩🤮🤢😒🙄😞😔😢😭']);
function emojiSentiment(t) {
  let p = 0, n = 0;
  for (const ch of String(t || '')) { if (POS.has(ch)) p++; else if (NEG.has(ch)) n++; }
  return p > n ? 'positive' : n > p ? 'negative' : 'neutral';
}

function codebook(cfg, P) {
  const topics = Object.keys(cfg.topics || {});
  const study = P.study.map(b => b.brand_name + (b.owner ? ` (${b.owner})` : '')).join(', ');
  const others = P.others.map(o => o.name).join(', ');
  return `You label Sri Lankan social media content for a share of voice tracker.

Category: ${cfg.name}.
In scope: ${cfg.scope_note || cfg.name}

Text may be English, Sinhala, Tamil, or Singlish (Sinhala written in English letters, for example "eka hondai" = it is good, "kohomada" = how, "ganna" = to buy, "mila" = price, "sudu" = fair, "suwanda" = fragrance).

Brands in the tracker (spelling variants and Sinhala or Tamil spellings count): ${study}.
Other brands seen before: ${others || 'none listed'}. Record any other brand in the category too, as written, in title case.
Content on a brand's own page is about that brand unless it clearly names another.

POSTS. For each post return:
- pid: as given
- relevant: true only if the post is about in-scope products of this category
- author_type: one of ${JSON.stringify(AUTHOR)}. brand official = the brand's own account or agency; influencer/creator = personal creator content, paid or not; small seller = a shop or home business selling (prices, WhatsApp numbers); consumer = an ordinary person; media/other = news, meme pages, unrelated pages
- theme: one of ${JSON.stringify(THEME)}
- brands: brand names the post is about, [] if none
- topics: zero or more of ${JSON.stringify(topics)}
- sentiment: one of ${JSON.stringify(SENT)}, toward the product or brand discussed

COMMENTS. Each comment comes with the post it was left on. For each comment return:
- cid: as given
- type: one of ${JSON.stringify(CTYPE)}. praise = says the product or ad is good; complaint = a negative experience or criticism; question = price, where to buy, how to use, availability; purchase intent = "I'll buy", "order"; recommendation request = asks which product is best for something; contest entry = answers a quiz or giveaway, "done", tags friends for a contest; tag/mention friend = only tags people; reaction = a short generic reaction ("nice", "lassanai", "superb") that says nothing about the product; comparison = compares brands or says they switched; off-topic/spam = unrelated, promotions, self-ads
- sentiment: one of ${JSON.stringify(SENT)}
- brands: brands the comment is about: a brand it names, else the page brand when the comment is clearly about the product or ad on a brand's own post; [] on other posts when no brand is named
- topics: zero or more of the topics above

Judge from the text only. Do not guess. Labels in English.`;
}

const POST_TOOL = {
  name: 'record_post_labels',
  description: 'Record one label per post, in the order given.',
  input_schema: {
    type: 'object', required: ['labels'],
    properties: { labels: { type: 'array', items: {
      type: 'object', required: ['pid', 'relevant', 'author_type', 'theme', 'brands', 'topics', 'sentiment'],
      properties: {
        pid: { type: 'string' }, relevant: { type: 'boolean' },
        author_type: { type: 'string', enum: AUTHOR }, theme: { type: 'string', enum: THEME },
        brands: { type: 'array', items: { type: 'string' } }, topics: { type: 'array', items: { type: 'string' } },
        sentiment: { type: 'string', enum: SENT },
      } } } },
  },
};
const COMMENT_TOOL = {
  name: 'record_comment_labels',
  description: 'Record one label per comment.',
  input_schema: {
    type: 'object', required: ['labels'],
    properties: { labels: { type: 'array', items: {
      type: 'object', required: ['cid', 'type', 'sentiment', 'brands', 'topics'],
      properties: {
        cid: { type: 'string' }, type: { type: 'string', enum: CTYPE }, sentiment: { type: 'string', enum: SENT },
        brands: { type: 'array', items: { type: 'string' } }, topics: { type: 'array', items: { type: 'string' } },
      } } } },
  },
};

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

let extrasOk = true;
async function callTool(system, tool, content, maxTokens) {
  const req = {
    model: MODEL, max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
  let res;
  try {
    res = await getClient().messages.create(extrasOk ? { ...extrasFor(MODEL), ...req } : req);
  } catch (e) {
    // A newer model that does not take the thinking setting: try once without it.
    if (extrasOk && e.status === 400 && /thinking/i.test(String(e.message))) {
      extrasOk = false;
      res = await getClient().messages.create(req);
    } else throw e;
  }
  const call = (res.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  const usage = res.usage || {};
  return { labels: (call && Array.isArray(call.input.labels)) ? call.input.labels : [], usage };
}

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 12) : []);

function cleanPost(l, topics) {
  if (!l || typeof l.relevant !== 'boolean') return null;
  return {
    relevant: l.relevant,
    author_type: pick(l.author_type, AUTHOR, 'media/other'),
    theme: pick(l.theme, THEME, 'other'),
    brands: strs(l.brands),
    topics: strs(l.topics).filter(t => topics.includes(t)),
    sentiment: pick(l.sentiment, SENT, 'neutral'),
  };
}
function cleanComment(l, topics) {
  if (!l || !CTYPE.includes(l.type)) return null;
  return {
    type: l.type,
    sentiment: pick(l.sentiment, SENT, 'neutral'),
    brands: strs(l.brands),
    topics: strs(l.topics).filter(t => topics.includes(t)),
  };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function labelPosts(ctx) {
  const { q, cat, cfg, P, log } = ctx;
  const topics = Object.keys(cfg.topics || {});
  const system = codebook(cfg, P);
  const since = new Date(Date.now() - ctx.historyDays * 86400000);

  // Brand posts that are plainly about another product line need no model.
  const { rows: owned } = await q(
    `select p.platform, p.post_id, p.body, p.owner_brand from sov_raw_posts p
      where p.category_id = $1 and p.label is null and p.source = 'owned' and p.published_at >= $2`, [cat.category_id, since]);
  let ruled = 0;
  for (const p of owned) {
    const b = P.study.find(x => x.brand_name === p.owner_brand);
    const tag = T.productTag(p.body, P);
    if (tag === 'other' || (tag === 'general' && b && b.page_scope === 'multi')) {
      await q(`update sov_raw_posts set label = $4, labelled_at = now() where category_id = $1 and platform = $2 and post_id = $3`,
        [cat.category_id, p.platform, p.post_id, JSON.stringify({ relevant: false, rule: tag === 'other' ? 'other product' : 'no category word on a multi-category page' })]);
      ruled++;
    }
  }

  const { rows } = await q(
    `select platform, post_id, source, owner_brand, body from sov_raw_posts
      where category_id = $1 and label is null and is_sri_lanka and published_at >= $2
      order by published_at desc`, [cat.category_id, since]);
  const batches = [];
  for (let i = 0; i < rows.length; i += POST_BATCH) batches.push(rows.slice(i, i + POST_BATCH));

  let done = 0, failed = 0, inTok = 0, outTok = 0;
  await pool(batches, CONCURRENCY, async batch => {
    let todo = batch.map((p, i) => ({ ...p, pid: 'p' + (i + 1) }));
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      const lines = todo.map(p => JSON.stringify({ pid: p.pid, where: p.source === 'owned' ? `${p.owner_brand}'s own page` : 'public', text: clip(p.body, 1200) }));
      let out;
      try { out = await callTool(system, POST_TOOL, `Label these ${todo.length} posts.\n\n${lines.join('\n')}`, 400 + 110 * todo.length); }
      catch (e) { log(`post labelling call failed: ${e.message}`); continue; }
      inTok += (out.usage.input_tokens || 0) + (out.usage.cache_read_input_tokens || 0); outTok += out.usage.output_tokens || 0;
      const byId = new Map(out.labels.map(l => [String(l.pid), l]));
      const left = [];
      for (const p of todo) {
        const l = cleanPost(byId.get(p.pid), topics);
        if (!l) { left.push(p); continue; }
        await q(`update sov_raw_posts set label = $4, labelled_at = now() where category_id = $1 and platform = $2 and post_id = $3`,
          [cat.category_id, p.platform, p.post_id, JSON.stringify(l)]);
        done++;
      }
      todo = left;
    }
    failed += todo.length;
  });
  log(`posts labelled: ${done} by model, ${ruled} by rule, ${failed} left for next run`);
  Object.assign(ctx.stats, { postsLabelled: done, postsRuled: ruled, postsUnlabelled: failed });
  const t = ctx.stats.labelTokens || { input: 0, output: 0 };
  ctx.stats.labelTokens = { input: t.input + inTok, output: t.output + outTok };
}

async function labelComments(ctx) {
  const { q, cat, cfg, P, log } = ctx;
  const topics = Object.keys(cfg.topics || {});
  const system = codebook(cfg, P);
  const since = new Date(Date.now() - ctx.historyDays * 86400000);

  const { rows } = await q(
    `select c.platform, c.post_id, c.comment_key, c.body, c.kind, p.source, p.owner_brand, p.body as post_body, p.label as post_label
       from sov_raw_comments c
       join sov_raw_posts p using (category_id, platform, post_id)
      where c.category_id = $1 and c.label is null and not c.is_brand_reply
        and (p.label->>'relevant')::boolean and p.published_at >= $2
      order by c.platform, c.post_id`, [cat.category_id, since]);

  // Rule labels first.
  let ruled = 0;
  const forModel = [];
  for (const c of rows) {
    if (c.kind === 'text' || c.kind === 'tiny') { forModel.push(c); continue; }
    const brands = c.source === 'owned' ? [c.owner_brand] : strs((c.post_label || {}).brands);
    const label = {
      type: c.kind === 'tag' ? 'tag/mention friend' : 'reaction',
      sentiment: c.kind === 'emoji' ? emojiSentiment(c.body) : 'neutral',
      brands, topics: [], rule: c.kind,
    };
    await q(`update sov_raw_comments set label = $4, labelled_at = now() where category_id = $1 and platform = $2 and comment_key = $3`,
      [cat.category_id, c.platform, c.comment_key, JSON.stringify(label)]);
    ruled++;
  }

  // Batches keep a post's comments together so the post is sent once.
  const batches = [];
  let cur = [];
  for (const c of forModel) {
    if (cur.length >= COMMENT_BATCH && cur[cur.length - 1].post_id !== c.post_id) { batches.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) batches.push(cur);

  let done = 0, failed = 0, inTok = 0, outTok = 0;
  await pool(batches, CONCURRENCY, async batch => {
    let todo = batch.map((c, i) => ({ ...c, cid: 'c' + (i + 1) }));
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      const groups = new Map();
      for (const c of todo) {
        const k = c.platform + '|' + c.post_id;
        if (!groups.has(k)) groups.set(k, { post: { where: c.source === 'owned' ? `${c.owner_brand}'s own page` : 'public', text: clip(c.post_body, 300) }, comments: [] });
        groups.get(k).comments.push({ cid: c.cid, text: clip(c.body, 400) });
      }
      const lines = [...groups.values()].map(g => JSON.stringify(g));
      let out;
      try { out = await callTool(system, COMMENT_TOOL, `Label these ${todo.length} comments.\n\n${lines.join('\n')}`, 400 + 70 * todo.length); }
      catch (e) { log(`comment labelling call failed: ${e.message}`); continue; }
      inTok += (out.usage.input_tokens || 0) + (out.usage.cache_read_input_tokens || 0); outTok += out.usage.output_tokens || 0;
      const byId = new Map(out.labels.map(l => [String(l.cid), l]));
      const left = [];
      for (const c of todo) {
        const l = cleanComment(byId.get(c.cid), topics);
        if (!l) { left.push(c); continue; }
        await q(`update sov_raw_comments set label = $4, labelled_at = now() where category_id = $1 and platform = $2 and comment_key = $3`,
          [cat.category_id, c.platform, c.comment_key, JSON.stringify(l)]);
        done++;
      }
      todo = left;
    }
    failed += todo.length;
  });
  log(`conversation labelled: ${done} by model, ${ruled} by rule, ${failed} left for next run`);
  Object.assign(ctx.stats, { conversationLabelled: done, conversationRuled: ruled, conversationUnlabelled: failed });
  const t = ctx.stats.labelTokens || { input: 0, output: 0 };
  ctx.stats.labelTokens = { input: t.input + inTok, output: t.output + outTok };
}

module.exports = { labelPosts, labelComments, codebook, MODEL, getClient, extrasForModel: () => (extrasOk ? extrasFor(MODEL) : {}) };

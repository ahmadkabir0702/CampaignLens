/**
 * Labelling with Claude. Each new post gets: relevant to the category or not,
 * who wrote it, what kind of content it is, which brands it is about, themes
 * and sentiment. Each new comment gets: what kind of response it is, sentiment,
 * brands and themes. Labels are stored once and never redone.
 *
 * Emoji-only, empty and tag-only replies are labelled by rule, as in the
 * first manual run, so they cost nothing. A short reply that names no brand
 * and has been seen before ("price?", "nice", "done") reuses its label.
 *
 * Requests go through the Message Batches API by default (half the price,
 * same model and answers). Each batch is recorded in sov_label_batches, so
 * a run cut off by a restart is collected by the next one instead of paid
 * for twice.
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
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}) });
  return client;
}

// 'batch' (the default) sends labelling through the Message Batches API at
// half the price; a monthly run does not need the answer in seconds.
// 'direct' calls the model straight away, as the first version did.
const MODE = () => (process.env.SOV_LABEL_MODE || 'batch').toLowerCase();
const WAIT_MIN = () => Number(process.env.SOV_BATCH_WAIT_MIN || 240);
const POLL_MS = () => Number(process.env.SOV_BATCH_POLL_MS || 30000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let extrasOk = true;
function params(system, tool, content, maxTokens) {
  const req = {
    model: MODEL, max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
  return extrasOk ? { ...extrasFor(MODEL), ...req } : req;
}
function readTool(message, tool) {
  const call = ((message && message.content) || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  return { labels: (call && Array.isArray(call.input.labels)) ? call.input.labels : [], usage: (message && message.usage) || {} };
}

async function callTool(system, tool, content, maxTokens) {
  let res;
  try {
    res = await getClient().messages.create(params(system, tool, content, maxTokens));
  } catch (e) {
    // A newer model that does not take the thinking setting: try once without it.
    if (extrasOk && e.status === 400 && /thinking/i.test(String(e.message))) {
      extrasOk = false;
      res = await getClient().messages.create(params(system, tool, content, maxTokens));
    } else throw e;
  }
  return readTool(res, tool);
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

function addTokens(ctx, usage) {
  const t = ctx.stats.labelTokens || { input: 0, output: 0 };
  t.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  t.output += usage.output_tokens || 0;
  ctx.stats.labelTokens = t;
}

// ── Sending a set of requests ───────────────────────────────────────────────
//   jobs: [{ id, system, tool, content, maxTokens, items }]
//   apply(items, labels) writes what came back and returns the items that
//   still have no label. Returns every item left unlabelled.

async function waitAndCollect(ctx, batchId, kind, byId, apply, tool) {
  const c = getClient();
  const deadline = Date.now() + WAIT_MIN() * 60000;
  let b = await c.messages.batches.retrieve(batchId);
  while (b.processing_status !== 'ended' && Date.now() < deadline) {
    await ctx.phaseNote(`waiting for ${kind} labels (${(b.request_counts || {}).succeeded || 0} of ${Object.keys(byId).length} done)`);
    await sleep(POLL_MS());
    b = await c.messages.batches.retrieve(batchId);
  }
  if (b.processing_status !== 'ended') {
    ctx.log(`${kind} labels not back after ${WAIT_MIN()} minutes; the next run collects them`);
    return { left: [], pending: true };
  }
  const left = [];
  let thinkingRejected = 0;
  const seen = new Set();
  for await (const r of await c.messages.batches.results(batchId)) {
    const items = byId[r.custom_id];
    if (!items) continue;
    seen.add(r.custom_id);
    if (r.result && r.result.type === 'succeeded') {
      const out = readTool(r.result.message, tool);
      addTokens(ctx, out.usage);
      left.push(...await apply(items, out.labels));
    } else {
      if (/thinking/i.test(JSON.stringify((r.result || {}).error || ''))) thinkingRejected++;
      left.push(...items);
    }
  }
  for (const [id, items] of Object.entries(byId)) if (!seen.has(id)) left.push(...items);
  if (thinkingRejected) extrasOk = false;
  await ctx.q(`update sov_label_batches set status = 'collected', collected_at = now() where batch_id = $1`, [batchId]);
  return { left, pending: false };
}

async function send(ctx, kind, jobs, apply) {
  if (!jobs.length) return [];
  const tool = kind === 'posts' ? POST_TOOL : COMMENT_TOOL;
  let left = [];
  if (MODE() === 'batch') {
    let batch = null;
    try {
      batch = await getClient().messages.batches.create({
        requests: jobs.map(j => ({ custom_id: j.id, params: params(j.system, j.tool, j.content, j.maxTokens) })),
      });
    } catch (e) {
      ctx.log(`could not send the ${kind} batch (${e.message}); labelling directly instead`);
    }
    if (batch) {
      // Only the keys are stored, not the text: enough to write labels back.
      const keyOf = it => `${it.platform}|${it.post_id && !it.comment_key ? it.post_id : it.comment_key}`;
      const slim = it => (it.comment_key
        ? { cid: it.cid, platform: it.platform, comment_key: it.comment_key, also: it.also || [] }
        : { pid: it.pid, platform: it.platform, post_id: it.post_id });
      const full = new Map(jobs.flatMap(j => j.items.map(it => [keyOf(it), it])));
      const byId = Object.fromEntries(jobs.map(j => [j.id, j.items.map(slim)]));
      await ctx.q(`insert into sov_label_batches (batch_id, category_id, run_id, kind, items) values ($1,$2,$3,$4,$5)`,
        [batch.id, ctx.cat.category_id, ctx.runId || null, kind, JSON.stringify(byId)]);
      ctx.log(`${kind}: ${jobs.length} requests sent as one batch`);
      const r = await waitAndCollect(ctx, batch.id, kind, byId, apply, tool);
      if (r.pending) return [];
      left = r.left.map(it => full.get(keyOf(it)) || it);
    } else {
      left = jobs.flatMap(j => j.items);
      jobs = [];
    }
    // Whatever did not come back cleanly gets one direct try, in small groups.
    if (left.length) ctx.log(`${kind}: ${left.length} retried directly`);
    const retry = ctx.rebuild(left);
    left = [];
    await pool(retry, CONCURRENCY, async j => {
      try {
        const out = await callTool(j.system, j.tool, j.content, j.maxTokens);
        addTokens(ctx, out.usage);
        left.push(...await apply(j.items, out.labels));
      } catch (e) { ctx.log(`${kind} labelling call failed: ${e.message}`); left.push(...j.items); }
    });
    return left;
  }
  // Direct: two tries per group.
  await pool(jobs, CONCURRENCY, async j => {
    let todo = j.items, job = j;
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      try {
        const out = await callTool(job.system, job.tool, job.content, job.maxTokens);
        addTokens(ctx, out.usage);
        todo = await apply(todo, out.labels);
      } catch (e) { ctx.log(`${kind} labelling call failed: ${e.message}`); }
      if (todo.length) job = ctx.rebuildOne(todo);
    }
    left.push(...todo);
  });
  return left;
}

/**
 * Labels from an earlier run that the server did not live to collect
 * (a restart mid-batch). They are paid for, so they are picked up here.
 */
async function collectPending(ctx, kind, apply) {
  let rows = [];
  try {
    ({ rows } = await ctx.q(
      `select batch_id, items from sov_label_batches
        where category_id = $1 and kind = $2 and status = 'sent' and created_at > now() - interval '28 days'`,
      [ctx.cat.category_id, kind]));
  } catch (e) { if (e.code === '42P01') return; throw e; }
  const tool = kind === 'posts' ? POST_TOOL : COMMENT_TOOL;
  for (const r of rows) {
    try {
      const out = await waitAndCollect(ctx, r.batch_id, kind, r.items, apply, tool);
      if (!out.pending) ctx.log(`${kind}: collected labels from an earlier batch`);
    } catch (e) {
      ctx.log(`could not collect earlier batch ${r.batch_id}: ${e.message}`);
      if (e.status === 404) await ctx.q(`update sov_label_batches set status = 'expired' where batch_id = $1`, [r.batch_id]);
    }
  }
  await ctx.q(`update sov_label_batches set status = 'expired' where category_id = $1 and kind = $2 and status = 'sent'
                 and created_at <= now() - interval '28 days'`, [ctx.cat.category_id, kind]).catch(() => {});
}

// ── Posts ───────────────────────────────────────────────────────────────────
async function labelPosts(ctx) {
  const { q, cat, cfg, P, log } = ctx;
  const topics = Object.keys(cfg.topics || {});
  const system = codebook(cfg, P);
  const since = new Date(Date.now() - ctx.historyDays * 86400000);

  let done = 0;
  // items: { pid, platform, post_id, source, owner_brand, body }
  const apply = async (items, labels) => {
    const byId = new Map(labels.map(l => [String(l.pid), l]));
    const left = [];
    for (const it of items) {
      const l = cleanPost(byId.get(it.pid), topics);
      if (!l) { left.push(it); continue; }
      const r = await q(`update sov_raw_posts set label = $4, labelled_at = now()
                          where category_id = $1 and platform = $2 and post_id = $3 and label is null`,
        [cat.category_id, it.platform, it.post_id, JSON.stringify(l)]);
      done += r.rowCount || 0;
    }
    return left;
  };
  const toJob = (items, n) => {
    const withIds = items.map((p, i) => ({ ...p, pid: 'p' + (i + 1) }));
    const lines = withIds.map(p => JSON.stringify({ pid: p.pid, where: p.source === 'owned' ? `${p.owner_brand}'s own page` : 'public', text: clip(p.body, 1200) }));
    return { id: `posts-${n}`, system, tool: POST_TOOL, content: `Label these ${withIds.length} posts.\n\n${lines.join('\n')}`,
      maxTokens: 400 + 110 * withIds.length, items: withIds };
  };
  ctx.rebuild = items => { const out = []; for (let i = 0; i < items.length; i += 10) out.push(toJob(items.slice(i, i + 10), 'retry' + i)); return out; };
  ctx.rebuildOne = items => toJob(items, 'retry');

  await collectPending(ctx, 'posts', apply);

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
  const jobs = [];
  for (let i = 0; i < rows.length; i += POST_BATCH) jobs.push(toJob(rows.slice(i, i + POST_BATCH), i / POST_BATCH));
  const left = await send(ctx, 'posts', jobs, apply);
  log(`posts labelled: ${done} by model, ${ruled} by rule, ${left.length} left for next run`);
  Object.assign(ctx.stats, { postsLabelled: done, postsRuled: ruled, postsUnlabelled: left.length });
}

// ── Conversation ────────────────────────────────────────────────────────────
async function labelComments(ctx) {
  const { q, cat, cfg, P, log } = ctx;
  const topics = Object.keys(cfg.topics || {});
  const system = codebook(cfg, P);
  const since = new Date(Date.now() - ctx.historyDays * 86400000);

  let done = 0, reused = 0;
  // items: { cid, platform, comment_key, post_id, ..., also: [[platform, key]] }
  const write = async (platform, key, label) => {
    const r = await q(`update sov_raw_comments set label = $4, labelled_at = now()
                        where category_id = $1 and platform = $2 and comment_key = $3 and label is null`,
      [cat.category_id, platform, key, JSON.stringify(label)]);
    return r.rowCount || 0;
  };
  const apply = async (items, labels) => {
    const byId = new Map(labels.map(l => [String(l.cid), l]));
    const left = [];
    for (const it of items) {
      const l = cleanComment(byId.get(it.cid), topics);
      if (!l) { left.push(it); continue; }
      if (it.also && it.also.length) {
        // A repeated reply names no brand: which brand it is about comes
        // from where it was left, which the share calculation already knows.
        const shared = { ...l, brands: [], same_reply: true };
        done += await write(it.platform, it.comment_key, shared);
        for (const [pl, k] of it.also) reused += await write(pl, k, shared);
      } else {
        done += await write(it.platform, it.comment_key, l);
      }
    }
    return left;
  };
  const toJob = (items, n) => {
    const withIds = items.map((c, i) => ({ ...c, cid: 'c' + (i + 1) }));
    const groups = new Map();
    for (const c of withIds) {
      const k = c.platform + '|' + c.post_id;
      if (!groups.has(k)) groups.set(k, { post: { where: c.source === 'owned' ? `${c.owner_brand}'s own page` : 'public', text: clip(c.post_body, 300) }, comments: [] });
      groups.get(k).comments.push({ cid: c.cid, text: clip(c.body, 400) });
    }
    const lines = [...groups.values()].map(g => JSON.stringify(g));
    return { id: `comments-${n}`, system, tool: COMMENT_TOOL, content: `Label these ${withIds.length} comments.\n\n${lines.join('\n')}`,
      maxTokens: 400 + 70 * withIds.length, items: withIds };
  };
  ctx.rebuild = items => { const out = []; for (let i = 0; i < items.length; i += 25) out.push(toJob(items.slice(i, i + 25), 'retry' + i)); return out; };
  ctx.rebuildOne = items => toJob(items, 'retry');

  await collectPending(ctx, 'comments', apply);

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
    ruled += await write(c.platform, c.comment_key, label);
  }

  // The same short reply is labelled once: reuse an earlier label for it,
  // or send one copy and share the answer.
  const groups = new Map();
  const single = [];
  for (const c of forModel) {
    const k = T.normKey(c.body, P);
    if (!k) { single.push(c); continue; }
    c.norm_key = k;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  if (groups.size) {
    for (const [k, list] of groups) {
      for (const c of list) await q(`update sov_raw_comments set norm_key = $4 where category_id = $1 and platform = $2 and comment_key = $3`,
        [cat.category_id, c.platform, c.comment_key, k]);
    }
    const { rows: known } = await q(
      `select distinct on (norm_key) norm_key, label from sov_raw_comments
        where category_id = $1 and norm_key = any($2) and label is not null and label->>'rule' is null
        order by norm_key, labelled_at desc`, [cat.category_id, [...groups.keys()]]);
    for (const r of known) {
      const shared = { ...r.label, brands: [], same_reply: true };
      for (const c of groups.get(r.norm_key)) reused += await write(c.platform, c.comment_key, shared);
      groups.delete(r.norm_key);
    }
  }
  const reps = [...groups.values()].map(list => ({ ...list[0], also: list.slice(1).map(c => [c.platform, c.comment_key]) }));
  const todo = [...single, ...reps].sort((a, b) => (a.platform + a.post_id).localeCompare(b.platform + b.post_id));

  // Groups keep a post's comments together so the post is sent once.
  const jobs = [];
  let cur = [];
  for (const c of todo) {
    if (cur.length >= COMMENT_BATCH && cur[cur.length - 1].post_id !== c.post_id) { jobs.push(toJob(cur, jobs.length)); cur = []; }
    cur.push(c);
  }
  if (cur.length) jobs.push(toJob(cur, jobs.length));

  const left = await send(ctx, 'comments', jobs, apply);
  log(`conversation labelled: ${done} by model, ${reused} repeats reused, ${ruled} by rule, ${left.length} left for next run`);
  Object.assign(ctx.stats, { conversationLabelled: done, conversationReused: reused, conversationRuled: ruled, conversationUnlabelled: left.length });
}

module.exports = { labelPosts, labelComments, codebook, MODEL, getClient, extrasForModel: () => (extrasOk ? extrasFor(MODEL) : {}), callTool, pool };

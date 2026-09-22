/**
 * Ask Lens - answer pre-warm
 *
 * After every snapshot rebuild, run the starter questions once per brand,
 * headless, and store the answers in the shared cache. Anyone who clicks a
 * starter chip then gets an instant, free answer instead of a paid one.
 *
 * Runs in the background after /api/chat/warm responds, so n8n is never
 * kept waiting. Sequential, so it never bursts the rate limit.
 */

const Anthropic = require('@anthropic-ai/sdk');
const S = require('./schema.config');
const { getPool } = require('./db');
const { getSnapshot } = require('./snapshot');
const { buildSystem } = require('./systemPrompt');
const { buildTools } = require('./tools');
const { runTool } = require('./toolHandlers');
const answerCache = require('./answerCache');
const { extractMarkers, referencedIds } = require('./orchestrator');
const { modelFor } = require('./router');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Keep this list identical to the chips in chat-panel.js, or the cache
// keys will not match and the pre-warm is wasted.
const QUESTIONS = [
  'What are our best performing creatives?',
  'Which Poor creatives are still running?',
  'How does Brand Say compare to Others Say?',
  'What is validated but not boosted yet?',
  'What should we pause?',
  'What about organic?',
];

const MAX_TOOL_ROUNDS = 2;

async function answerOnce(brand, question, snap, pool) {
  const system = buildSystem({ brand, snapshotBody: snap.body, rangeDays: 0 });
  const tools = buildTools();
  const messages = [{ role: 'user', content: question }];
  const records = { ...(snap.records || {}) };
  let text = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // Same routing as live chat, so the cached answer matches what a user would get.
    const route = modelFor(question);
    const res = await client.messages.create({ model: route.model, max_tokens: route.maxTokens, system, tools, messages });
    text += res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (res.stop_reason !== 'tool_use' || round === MAX_TOOL_ROUNDS) break;

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const use of res.content.filter((b) => b.type === 'tool_use')) {
      const out = await runTool(use.name, use.input, { brand, rangeDays: 0, pool });
      Object.assign(records, out.records || {});
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.result) });
    }
    messages.push({ role: 'user', content: results });
  }

  const ids = referencedIds(extractMarkers(text));
  const used = {};
  for (const id of ids) if (records[id]) used[id] = records[id];
  return { text, records: used };
}

/** Pre-warm every brand. Returns a summary; never throws. */
/** Pre-warm one brand's quick-lookup starters. Off unless ASK_LENS_PREWARM=1. */
async function prewarmBrand(brand, opts = {}) {
  const pool = opts.pool || getPool();
  const summary = { asked: 0, cached_already: 0, written: 0, failed: 0 };
  let snap;
  try { snap = await getSnapshot(brand, 0, { pool, noPrewarm: true }); } catch (e) { summary.failed += QUESTIONS.length; return summary; }
  const boosted = snap.records && snap.records.brand ? Number(snap.records.brand.creatives || 0) : 0;
  if (boosted < 2) return summary;
  for (const question of QUESTIONS) {
    if (modelFor(question).mode === 'analysis') continue; // answered live, then cached for everyone
    const params = { brand, rangeDays: 0, snapshotVersion: snap.version, question, hasHistory: false };
    summary.asked += 1;
    try {
      const hit = await answerCache.get(params, { pool });
      if (hit) { summary.cached_already += 1; continue; }
      const { text, records } = await answerOnce(brand, question, snap, pool);
      const refused = text.startsWith("That's outside") || text.startsWith("I'm scoped to");
      if (!refused && text.length > 20) { await answerCache.put(params, { answer: text, records }, { pool }); summary.written += 1; }
    } catch (err) { summary.failed += 1; console.error(`[prewarm] ${brand} "${question}":`, err.message); }
  }
  return summary;
}

async function prewarmAll(opts = {}) {
  if (process.env.ASK_LENS_PREWARM !== '1' && !opts.force) {
    if (!opts.quiet) console.log('[prewarm] off (set ASK_LENS_PREWARM=1 to enable)');
    return { off: true };
  }
  const total = { asked: 0, cached_already: 0, written: 0, failed: 0 };
  for (const brand of S.brands) {
    const r = await prewarmBrand(brand, opts);
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
  }
  if (!opts.quiet) console.log('[prewarm]', JSON.stringify(total));
  return total;
}

module.exports = { prewarmAll, prewarmBrand, QUESTIONS };

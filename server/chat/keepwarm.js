/**
 * Ask Lens - keep the prompt cache warm while people are using it
 *
 * The chat's prompt (instructions, playbook, brand data) is cached for an
 * hour. Every time it expires, the next question pays to write the whole
 * thing again, separately for Haiku and for Sonnet. During a working day
 * that happens after every lunch break or quiet spell.
 *
 * A cache hit resets the hour. So while a brand is in use, this sends a tiny
 * one-token request every ~50 minutes that reads the same cached prompt,
 * keeping it alive for a fraction of the cost of rewriting it.
 *
 * It only runs for brand and model pairs someone actually used in the last
 * two hours, so quiet brands and quiet evenings cost nothing.
 *
 * Set ASK_LENS_KEEPWARM=0 to turn it off.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystem } = require('./systemPrompt');
const { buildTools } = require('./tools');

const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;   // keep warm while used in the last 2 hours
const REFRESH_AFTER_MS = 50 * 60 * 1000;       // the cache lives 60 minutes; refresh at 50
const TICK_MS = 5 * 60 * 1000;

const state = new Map(); // "brand|model" -> { brand, model, lastUsed, lastTouched }
let client = null;
let timer = null;

/** Called by the chat after every model call, so the cache was just refreshed. */
function touch(brand, model) {
  const key = `${brand}|${model}`;
  const now = Date.now();
  const s = state.get(key) || { brand, model };
  s.lastUsed = now;
  s.lastTouched = now;
  state.set(key, s);
}

async function ping(brand, model) {
  const { getSnapshot } = require('./snapshot');
  const snap = await getSnapshot(brand, 0, { noPrewarm: true });
  // Must be byte-identical to what the chat sends, or it would write a new
  // cache entry instead of refreshing the existing one.
  await client.messages.create({
    model,
    max_tokens: 1,
    system: buildSystem({ brand, snapshotBody: snap.body }),
    tools: buildTools(),
    messages: [{ role: 'user', content: '.' }],
  });
}

async function tick() {
  const now = Date.now();
  for (const s of state.values()) {
    if (now - s.lastUsed > ACTIVE_WINDOW_MS) continue;      // brand has gone quiet: let it expire
    if (now - s.lastTouched < REFRESH_AFTER_MS) continue;   // recently refreshed by real use
    try {
      await ping(s.brand, s.model);
      s.lastTouched = Date.now();
    } catch (err) {
      console.error('[keepwarm]', s.brand, s.model, err.message);
    }
  }
}

function start() {
  if (process.env.ASK_LENS_KEEPWARM === '0' || timer) return;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref(); // never keeps the process alive on shutdown
}

module.exports = { touch, start, tick, _state: state };

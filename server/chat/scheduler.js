/**
 * Ask Lens - nightly refresh, built into the server
 *
 * Once a day it rebuilds every brand's data and refreshes the insight cards,
 * so everything stays current for all brands without anyone running a
 * command. Findings only rewrite for brands whose creatives changed, so a
 * quiet night costs almost nothing.
 *
 * If n8n also calls /api/chat/warm after its pipeline, that is fine: both
 * paths are safe to run twice.
 *
 *   ASK_LENS_NIGHTLY_HOUR  hour in Sri Lanka time to run (default 6, after the
 *                          overnight data pull; set it to an hour after n8n finishes)
 *   ASK_LENS_NIGHTLY=0     turn it off
 */

const HOUR = Number(process.env.ASK_LENS_NIGHTLY_HOUR || 6);
const CHECK_EVERY_MS = 10 * 60 * 1000;

let timer = null;
let running = false;
let lastRunDay = null;

function colomboNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function runNow(reason = 'scheduled') {
  if (running) return { skipped: 'already running' };
  running = true;
  const started = Date.now();
  try {
    const { warmAll } = require('./snapshot');
    const { generateAll } = require('./insights');
    const { prewarmAll } = require('./prewarm');
    const snaps = await warmAll({ quiet: true });
    const cards = await generateAll({ quiet: true });
    await prewarmAll({ quiet: true }); // off unless ASK_LENS_PREWARM=1
    const changed = cards.filter((c) => !c.unchanged && !c.error).map((c) => c.brand);
    console.log(`[nightly] ${reason}: ${snaps.length} brands rebuilt, insight cards refreshed for ${changed.length ? changed.join(', ') : 'none (no creative changes)'} in ${Math.round((Date.now() - started) / 1000)}s`);
    return { snaps, cards };
  } catch (err) {
    console.error('[nightly] failed:', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

function tick() {
  const now = colomboNow();
  if (now.hour === HOUR && lastRunDay !== now.day) {
    lastRunDay = now.day;
    runNow('scheduled').catch(() => {});
  }
}

function start() {
  if (process.env.ASK_LENS_NIGHTLY === '0' || timer) return;
  timer = setInterval(tick, CHECK_EVERY_MS);
  if (timer.unref) timer.unref();
  console.log(`[nightly] scheduled daily at ${String(HOUR).padStart(2, '0')}:00 Sri Lanka time`);
}

module.exports = { start, runNow, colomboNow, _tick: tick };

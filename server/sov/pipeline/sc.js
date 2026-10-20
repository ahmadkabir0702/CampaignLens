/**
 * ScrapeCreators client for the share of voice run.
 *
 * Every call costs a credit, so the client keeps count and stops the run
 * (BudgetStop) when the run's cap is reached, the account balance falls to
 * the floor, the key is rejected, or credits run out. A stopped run keeps
 * what it collected; the next run carries on from there.
 */
const BASE = process.env.SCRAPECREATORS_BASE_URL || 'https://api.scrapecreators.com';

class BudgetStop extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createClient({ apiKey, cap = 1500, minCredits = Number(process.env.SOV_MIN_CREDITS || 300) }) {
  if (!apiKey) throw new BudgetStop('SCRAPECREATORS_API_KEY is not set');
  const st = { start: null, credits: null, calls: 0, errors: 0 };

  function guard() {
    if (st.start == null || st.credits == null) return;
    if (st.start - st.credits >= cap) throw new BudgetStop(`This run reached its cap of ${cap} credits`);
    if (st.credits <= minCredits) throw new BudgetStop(`ScrapeCreators balance is down to ${st.credits} credits`);
  }

  async function get(path, params = {}, { retries = 2 } = {}) {
    guard();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(`${BASE}${path}?${qs}`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(120000) });
      } catch (e) {
        last = e.message;
        await sleep(3000 * (attempt + 1));
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        st.calls++;
        if (typeof body.credits_remaining === 'number') st.credits = body.credits_remaining;
        return body;
      }
      if (res.status === 401) throw new BudgetStop('ScrapeCreators rejected the API key');
      if (res.status === 402) throw new BudgetStop('ScrapeCreators credits have run out');
      if (res.status === 400 || res.status === 403 || res.status === 404) { st.errors++; return { _error: res.status }; }
      last = `HTTP ${res.status}`;
      await sleep(3000 * (attempt + 1));
    }
    st.errors++;
    return { _error: last };
  }

  async function balance() {
    const qs = '';
    const res = await fetch(`${BASE}/v1/account/credit-balance${qs}`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new BudgetStop('ScrapeCreators rejected the API key');
    const n = typeof body.creditCount === 'number' ? body.creditCount : null;
    if (n != null) { st.credits = n; if (st.start == null) st.start = n; }
    return n;
  }

  return { get, balance, state: st, used: () => (st.start != null && st.credits != null ? st.start - st.credits : 0) };
}

/** Run fn over items, n at a time. A BudgetStop from any worker stops them all and is rethrown. */
async function pool(items, n, fn) {
  let i = 0, stop = null;
  async function worker() {
    while (!stop && i < items.length) {
      const item = items[i++];
      try { await fn(item); }
      catch (e) {
        if (e instanceof BudgetStop) { stop = e; return; }
        console.warn('[sov] item failed:', e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (stop) throw stop;
}

module.exports = { createClient, pool, BudgetStop, sleep };

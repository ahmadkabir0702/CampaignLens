/**
 * Endpoints n8n calls to run the share of voice updates. They sit outside
 * the login (server.js lets /api/sov/automation, /api/sov/runs and
 * /api/sov/periods through) and are protected by a shared token instead:
 *
 *   header  x-sov-token: <SOV_RUN_TOKEN>
 *
 *   GET  /api/sov/automation     credits left and the categories, each with
 *                                `due`: whether n8n should run it today
 *   POST /api/sov/runs           { "category_id": "skin_cleansing" } → { runId }
 *                                409 while another run is going
 *   GET  /api/sov/runs/:id       status: running | succeeded | failed
 *   POST /api/sov/periods/:id/publish   put a period saved for review live
 *
 * Nothing here returns collected content: only run status and counts of
 * work done, for the operator.
 */
const crypto = require('crypto');
const R = require('./pipeline/run');

function tokenOk(req) {
  const want = process.env.SOV_RUN_TOKEN || '';
  const got = String(req.get('x-sov-token') || '');
  if (want.length < 16 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function guard(req, res, next) {
  if (!process.env.SOV_RUN_TOKEN) return res.status(503).json({ error: 'SOV_RUN_TOKEN is not set on the server' });
  if (!tokenOk(req)) return res.status(401).json({ error: 'Bad or missing x-sov-token' });
  next();
}

function fail(res, e) {
  if (e.code === '42P01' || e.code === '42703') return res.status(503).json({ error: 'Run migrations 019, 020 and 030 first' });
  res.status(e.status || 500).json({ error: e.message, runId: e.runId });
}

module.exports = function mountSovAutomation(app) {
  // A run cut off by a restart is closed so the next one can start.
  R.closeOrphans().catch(e => { if (e.code !== '42P01') console.error('[sov] could not close old runs:', e.message); });

  app.get('/api/sov/automation', guard, async (req, res) => {
    try {
      let credits = null;
      if (process.env.SCRAPECREATORS_API_KEY) {
        const base = process.env.SCRAPECREATORS_BASE_URL || 'https://api.scrapecreators.com';
        const r = await fetch(`${base}/v1/account/credit-balance`, { headers: { 'x-api-key': process.env.SCRAPECREATORS_API_KEY }, signal: AbortSignal.timeout(20000) })
          .then(x => x.json()).catch(() => ({}));
        credits = typeof r.creditCount === 'number' ? r.creditCount : null;
      }
      res.json({ credits, minCredits: Number(process.env.SOV_MIN_CREDITS || 300), running: R.isRunning(), categories: await R.automatedCategories() });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/sov/runs', guard, async (req, res) => {
    try {
      const id = String((req.body || {}).category_id || '').trim();
      if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'category_id is required' });
      const periodEnd = (req.body || {}).period_end;
      if (periodEnd && !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return res.status(400).json({ error: 'period_end must be YYYY-MM-DD' });
      const runId = await R.startRun(id, { backfill: !!(req.body || {}).backfill, periodEnd: periodEnd || null });
      res.status(202).json({ runId, status: 'running' });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/sov/runs/:id', guard, async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad run id' });
      const r = await R.getRun(req.params.id);
      if (!r) return res.status(404).json({ error: 'No such run' });
      const s = r.stats || {};
      res.json({
        runId: Number(r.run_id), category: r.category_id, status: r.status, phase: r.phase,
        startedAt: r.started_at, finishedAt: r.finished_at, creditsStart: r.credits_start, creditsEnd: r.credits_end,
        error: r.error, published: s.published ?? null, awaitingReview: !!s.awaitingReview, periodId: s.periodId ?? null,
        period: s.period || null, creditsUsed: s.creditsUsed ?? null,
        log: (s.log || []).slice(-15),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/sov/periods/:id/publish', guard, async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad period id' });
      const p = await R.publishPeriod(req.params.id);
      res.json({ published: true, periodId: Number(p.period_id), category: p.category_id, label: p.label });
    } catch (e) { fail(res, e); }
  });
};

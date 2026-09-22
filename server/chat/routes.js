/**
 * Ask Lens - Express routes
 *
 * Mount in your app:
 *   require('./server/chat/routes')(app);
 *
 * Auth is handled globally in server.js. This reads req.session.user (the
 * username string) and req.session.role. Coordinators do not get the panel.
 */

const express = require('express');
const S = require('./schema.config');
const { getPool } = require('./db');
const { handleMessage } = require('./orchestrator');
const { getSnapshot } = require('./snapshot');
const { handlers } = require('./toolHandlers');

const { warmAll } = require('./snapshot');
const { prewarmAll } = require('./prewarm');
const { generateAll: generateInsights } = require('./insights');
const rateLimitMod = require('./rateLimit');

module.exports = function mountChatRoutes(app) {
  require('./keepwarm').start();
  // ---- Optional pipeline hook, no session. -----------------------------
  // Snapshots refresh themselves on first use after new data lands, so
  // this endpoint is NOT required. Wiring n8n to call it after each run
  // just moves the rebuild and pre-warm to pipeline time instead of the
  // first question of the day. Protected by X-Warm-Secret; set
  // ASK_LENS_WARM_SECRET in Render to enable it.
  app.post('/api/chat/warm', express.json(), async (req, res) => {
    const secret = process.env.ASK_LENS_WARM_SECRET;
    if (!secret) return res.status(503).json({ error: 'ASK_LENS_WARM_SECRET not configured.' });
    if (req.get('X-Warm-Secret') !== secret) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const results = await warmAll({ quiet: true });
      const failed = results.filter((r) => r.error);
      res.status(failed.length ? 207 : 200).json({ ok: !failed.length, results, prewarm: 'started' });
      // Everything below runs after the response, so n8n is never kept waiting.
      // Order matters: findings must exist before pre-warmed answers are
      // generated, or the cached answers will not cite them.
      setImmediate(async () => {
        try { await generateInsights({ quiet: false }); } catch (e) { console.error('[insights]', e.message); }
        try { await prewarmAll({ quiet: false }); } catch (e) { console.error('[prewarm]', e.message); }
      });
    } catch (err) {
      console.error('[ask-lens/warm]', err.message);
      res.status(500).json({ error: 'Warm failed.' });
    }
  });

  const router = express.Router();
  router.use(express.json());

  // server.js already runs requireAuth and the coordinator role guard before
  // any route, so req.session is populated here and coordinators are already
  // bounced. This is a second explicit guard for defence in depth.
  router.use((req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.role === 'influencer_coordinator') {
      return res.status(403).json({ error: 'Not available for this role.' });
    }
    next();
  });

  // Resolve the brand for this request the same way the rest of the app does:
  // an explicit brand is honoured only if the user is allowed it; otherwise
  // fall back to their active brand, then their first allowed brand. A brand
  // the user cannot access, or one not in the snapshot set, returns null.
  function resolveBrand(req, requested) {
    const allowed = req.session.brands || [];
    const pick = requested || req.session.activeBrand || allowed[0];
    if (!pick) return null;
    if (!allowed.includes(pick)) return null;      // access control
    if (!S.brands.includes(pick)) return null;     // must have a snapshot
    return pick;
  }

  function validRange(days) {
    const n = Number(days);
    return S.snapshotRanges.includes(n) ? n : S.snapshotRanges[S.snapshotRanges.length - 1];
  }

  // ---- Sessions ------------------------------------------------

  router.get('/sessions', async (req, res) => {
    const pool = getPool();
    const brand = resolveBrand(req, req.query.brand);
    try {
      const { rows } = await pool.query(
        `select id, brand, range_days, title, turn_count, updated_at
         from chat_sessions
         where user_id = $1 and archived = false
           and ($2::text is null or brand = $2)
         order by updated_at desc
         limit 25`,
        [req.session.user, brand],
      );
      res.json({ sessions: rows });
    } catch (err) {
      console.error('[routes/sessions]', err.message);
      res.status(500).json({ error: 'Could not load sessions.' });
    }
  });

  router.post('/sessions', async (req, res) => {
    const pool = getPool();
    const brand = resolveBrand(req, req.body.brand);
    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });
    const rangeDays = validRange(req.body.rangeDays);
    try {
      const { rows } = await pool.query(
        `insert into chat_sessions (user_id, brand, range_days)
         values ($1, $2, $3) returning id, brand, range_days, created_at`,
        [req.session.user, brand, rangeDays],
      );
      res.json({ session: rows[0] });
    } catch (err) {
      console.error('[routes/newSession]', err.message);
      res.status(500).json({ error: 'Could not start a session.' });
    }
  });

  router.get('/sessions/:id/messages', async (req, res) => {
    const pool = getPool();
    try {
      const { rows } = await pool.query(
        `select m.role, m.content, m.created_at
         from chat_messages m
         join chat_sessions s on s.id = m.session_id
         where m.session_id = $1 and s.user_id = $2
         order by m.created_at`,
        [req.params.id, req.session.user],
      );
      res.json({ messages: rows });
    } catch (err) {
      console.error('[routes/messages]', err.message);
      res.status(500).json({ error: 'Could not load messages.' });
    }
  });

  router.delete('/sessions/:id', async (req, res) => {
    const pool = getPool();
    try {
      await pool.query(
        `update chat_sessions set archived = true
         where id = $1 and user_id = $2`,
        [req.params.id, req.session.user],
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Could not archive that session.' });
    }
  });

  // ---- The chat itself -----------------------------------------

  router.post('/message', async (req, res) => {
    const pool = getPool();
    const { sessionId, message } = req.body;
    const brand = resolveBrand(req, req.body.brand);
    const rangeDays = validRange(req.body.rangeDays);

    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ error: 'Empty message.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'That message is too long. Keep questions short.' });
    }

    // Session ownership and turn cap.
    let session;
    try {
      const { rows } = await pool.query(
        `select id, turn_count from chat_sessions
         where id = $1 and user_id = $2 and archived = false`,
        [sessionId, req.session.user],
      );
      session = rows[0];
    } catch (err) {
      return res.status(500).json({ error: 'Could not load that session.' });
    }
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    if (session.turn_count >= S.sessionTurnCap) {
      return res.status(409).json({
        error: 'This conversation has run long. Start a new chat to keep answers fast.',
        code: 'TURN_CAP',
      });
    }

    await handleMessage({
      userId: req.session.user,
      sessionId: session.id,
      brand,
      rangeDays,
      message: message.trim(),
      res,
    });
  });

  // ---- Marker fallback -----------------------------------------
  // Frontend safety net for a marker the side payload missed.

  router.get('/records', async (req, res) => {
    const brand = resolveBrand(req, req.query.brand);
    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });

    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (!ids.length) return res.json({ records: {} });

    try {
      const out = await handlers.compare_creatives(
        { creative_ids: ids.length === 1 ? [ids[0], ids[0]] : ids },
        { brand, rangeDays: validRange(req.query.rangeDays), pool: getPool() },
      );
      res.json({ records: out.records });
    } catch (err) {
      res.status(500).json({ error: 'Could not resolve those records.' });
    }
  });

  // ---- Usage, for the panel's limit bar ------------------------

  router.get('/usage', async (req, res) => {
    const pool = getPool();
    try {
      const { rows } = await pool.query(
        `select window_kind, coalesce(sum(count), 0)::int as used
         from chat_rate_limit
         where user_id = $1
           and ((window_kind = 'day'  and window_start >= date_trunc('day', now()))
             or (window_kind = 'hour' and window_start >= date_trunc('hour', now())))
         group by window_kind`,
        [req.session.user],
      );
      const by = Object.fromEntries(rows.map((r) => [r.window_kind, r.used]));
      res.json({
        day:  { used: by.day  || 0, limit: S.rateLimit.perDay },
        hour: { used: by.hour || 0, limit: S.rateLimit.perHour },
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not load usage.' });
    }
  });

  // ---- Brand context for the panel header ----------------------

  router.get('/context', async (req, res) => {
    const brand = resolveBrand(req, req.query.brand);
    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });
    try {
      const snap = await getSnapshot(brand, validRange(req.query.rangeDays));
      const meta = (snap.records && snap.records.__meta) || {};
      const freshness = meta.freshness || snap.period_end;
      const ageDays = freshness ? Math.floor((Date.now() - new Date(freshness).getTime()) / 86400000) : null;
      res.json({
        brand,
        brandLabel: S.brandLabels[brand],
        dataThrough: freshness,
        ageDays,
        stale: ageDays !== null && ageDays > S.staleAfterDays,
        generatedAt: snap.generated_at,
        records: snap.records,
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not load brand context.' });
    }
  });

  app.use('/api/chat', router);
  console.log('[ask-lens] chat routes mounted at /api/chat');
};

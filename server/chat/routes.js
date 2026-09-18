/**
 * Ask Lens - Express routes
 *
 * Mount in your app:
 *   app.use('/api/chat', require('./server/chat/routes')(requireAuth));
 *
 * `requireAuth` is your existing middleware. It must set req.user with
 * at least { id, role }. Coordinators do not get the chat panel.
 */

const express = require('express');
const S = require('./schema.config');
const { getPool } = require('./db');
const { handleMessage } = require('./orchestrator');
const { getSnapshot } = require('./snapshot');
const { handlers } = require('./toolHandlers');

module.exports = function chatRoutes(requireAuth) {
  const router = express.Router();
  router.use(express.json());
  if (requireAuth) router.use(requireAuth);

  // Coordinators are scoped to /coordinator and do not get chat.
  router.use((req, res, next) => {
    if (req.user?.role === 'coordinator') {
      return res.status(403).json({ error: 'Not available for this role.' });
    }
    next();
  });

  function validBrand(brand) {
    return S.brands.includes(brand) ? brand : null;
  }

  function validRange(days) {
    const n = Number(days);
    return S.snapshotRanges.includes(n) ? n : S.snapshotRanges[S.snapshotRanges.length - 1];
  }

  // ---- Sessions ------------------------------------------------

  router.get('/sessions', async (req, res) => {
    const pool = getPool();
    const brand = validBrand(req.query.brand);
    try {
      const { rows } = await pool.query(
        `select id, brand, range_days, title, turn_count, updated_at
         from chat_sessions
         where user_id = $1 and archived = false
           and ($2::text is null or brand = $2)
         order by updated_at desc
         limit 25`,
        [req.user.id, brand],
      );
      res.json({ sessions: rows });
    } catch (err) {
      console.error('[routes/sessions]', err.message);
      res.status(500).json({ error: 'Could not load sessions.' });
    }
  });

  router.post('/sessions', async (req, res) => {
    const pool = getPool();
    const brand = validBrand(req.body.brand);
    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });
    const rangeDays = validRange(req.body.rangeDays);
    try {
      const { rows } = await pool.query(
        `insert into chat_sessions (user_id, brand, range_days)
         values ($1, $2, $3) returning id, brand, range_days, created_at`,
        [req.user.id, brand, rangeDays],
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
        [req.params.id, req.user.id],
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
        [req.params.id, req.user.id],
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
    const brand = validBrand(req.body.brand);
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
        [sessionId, req.user.id],
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
      userId: req.user.id,
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
    const brand = validBrand(req.query.brand);
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

  // ---- Brand context for the panel header ----------------------

  router.get('/context', async (req, res) => {
    const brand = validBrand(req.query.brand);
    if (!brand) return res.status(400).json({ error: 'Unknown brand.' });
    try {
      const snap = await getSnapshot(brand, validRange(req.query.rangeDays));
      res.json({
        brand,
        brandLabel: S.brandLabels[brand],
        period: `${snap.period_start} to ${snap.period_end}`,
        generatedAt: snap.generated_at,
        records: snap.records,
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not load brand context.' });
    }
  });

  return router;
};

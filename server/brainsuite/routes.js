/**
 * Brainsuite routes. Mounted by server.js after login, so every request has a
 * session. Every handler checks brand access through assertBrandAllowed
 * before touching data (see the note at the top of routes.js).
 *
 *   GET    /api/pretests                 list for the active brand + form settings
 *   POST   /api/pretests                 check, announce, return the upload form
 *   POST   /api/pretests/:id/upload-url  a fresh upload form (they last 5 minutes)
 *   POST   /api/pretests/:id/start       after the browser's upload: start the test
 *   GET    /api/pretests/:id             one pre-test with its report
 *   DELETE /api/pretests/:id             cancel an upload, or delete a report now
 *   GET    /api/brainsuite/creative/:id  a creative's score
 *   GET    /api/brainsuite/jobs/:id/media  fresh image and video links
 *   GET    /api/brainsuite/usage         this month's tests (internal users)
 */
const { query, assertBrandAllowed } = require('../../db');
const store = require('./store');
const service = require('./service');
const { BUSINESS_GROUPS, CATEGORIES, LANGUAGES, CHANNELS } = require('./briefing');

const { HttpError } = service;

function send(res, err, label) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status
    : (String(err.message || '').startsWith('Access denied') || String(err.message || '').startsWith('No brand access')) ? 403
    : 500;
  if (status >= 500) console.error(`[brainsuite] ${label}:`, err.message);
  // A missing table means the migration has not been run yet.
  if (err.code === '42P01' || err.code === '42703') {
    return res.status(503).json({ error: 'Brainsuite is not set up on this database yet (run server/012_brainsuite.sql).' });
  }
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong. Try again.' : err.message });
}

function resolveBrand(req) {
  const requested = req.query.brand || (req.body && req.body.brand_id) || req.session.activeBrand;
  return assertBrandAllowed(req.session, requested || (req.session.brands || [])[0]);
}

// Loads a pre-test and checks the user can see its brand.
async function loadPretest(req) {
  const row = await store.getJob(req.params.id);
  if (!row || row.kind !== 'pretest') throw new HttpError(404, 'Pre-test not found.');
  assertBrandAllowed(req.session, row.brand_id);
  return row;
}

function canManage(req, row) {
  return row.requested_by === req.session.user || !!req.session.isInternal;
}

function publicRow(row, result) {
  return {
    id: row.id,
    status: row.status,
    channel: row.channel,
    channelLabel: CHANNELS[row.channel] || row.channel,
    assetName: row.asset_name || row.file_name,
    fileName: row.file_name,
    campaign: (row.briefing && row.briefing.projectName) || null,
    contentOrigin: row.briefing && row.briefing.contentOrigin,
    keyMessage: row.briefing && row.briefing.intendedMessages ? row.briefing.intendedMessages[0] : null,
    requestedBy: row.requested_by_name || row.requested_by,
    error: row.error,
    createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, expiresAt: row.expires_at,
    totalScore: result ? Number(result.total_score) : (row.total_score != null ? Number(row.total_score) : null),
    totalRating: result ? result.total_rating : (row.total_rating || null),
    summary: result ? result.summary : undefined,
    weblink: result ? result.weblink : undefined,
  };
}

module.exports = function mountBrainsuite(app) {

  app.get('/api/pretests', async (req, res) => {
    try {
      const brandId = resolveBrand(req);
      const [rows, brand] = await Promise.all([store.listPretests(brandId), store.brandInfo(brandId)]);
      res.json({
        brand: brand ? {
          id: brand.brand_id, name: brand.name,
          businessGroup: brand.bs_business_group, category: brand.bs_category, language: brand.bs_language,
        } : null,
        settings: { ...service.settings(), businessGroups: BUSINESS_GROUPS, categories: CATEGORIES, languages: LANGUAGES },
        me: req.session.user,
        isInternal: !!req.session.isInternal,
        pretests: rows.map(r => ({ ...publicRow(r), canManage: canManage(req, r) })),
      });
    } catch (err) { send(res, err, 'list pretests'); }
  });

  app.post('/api/pretests', async (req, res) => {
    try {
      const brandId = resolveBrand(req);
      const out = await service.createPretest({ brandId, username: req.session.user, fields: req.body || {} });
      res.status(201).json({ id: out.row.id, upload: out.upload });
    } catch (err) { send(res, err, 'create pretest'); }
  });

  app.post('/api/pretests/:id/upload-url', async (req, res) => {
    try {
      const row = await loadPretest(req);
      if (row.requested_by !== req.session.user) throw new HttpError(403, 'Only the person who started this pre-test can upload to it.');
      res.json({ upload: await service.freshUpload(row) });
    } catch (err) { send(res, err, 'fresh upload'); }
  });

  app.post('/api/pretests/:id/start', async (req, res) => {
    try {
      const row = await loadPretest(req);
      if (row.requested_by !== req.session.user) throw new HttpError(403, 'Only the person who started this pre-test can start it.');
      const updated = await service.startPretest(row);
      res.json(publicRow(updated));
    } catch (err) { send(res, err, 'start pretest'); }
  });

  app.get('/api/pretests/:id', async (req, res) => {
    try {
      const row = await loadPretest(req);
      const result = row.status === 'succeeded' ? await store.getResult(row.id) : null;
      const { rows } = await query(`select display_name from app_users where username = $1`, [row.requested_by]);
      res.json({ ...publicRow({ ...row, requested_by_name: rows[0] && rows[0].display_name }, result), canManage: canManage(req, row) });
    } catch (err) { send(res, err, 'get pretest'); }
  });

  app.delete('/api/pretests/:id', async (req, res) => {
    try {
      const row = await loadPretest(req);
      if (!canManage(req, row)) throw new HttpError(403, 'Only the person who ran this pre-test can delete it.');
      const updated = await service.removePretest(row);
      res.json(publicRow(updated));
    } catch (err) { send(res, err, 'delete pretest'); }
  });

  app.get('/api/brainsuite/creative/:creativeId', async (req, res) => {
    try {
      const { rows } = await query(`select brand_id from creatives where creative_id = $1`, [req.params.creativeId]);
      if (!rows.length) throw new HttpError(404, 'Creative not found.');
      assertBrandAllowed(req.session, rows[0].brand_id);
      const j = await store.latestForCreative(req.params.creativeId);
      if (!j) return res.json({ status: 'none' });
      res.json({
        id: j.id, status: j.status, error: j.error, channel: j.channel,
        channelLabel: CHANNELS[j.channel] || j.channel,
        reused: !!j.reused_from, completedAt: j.completed_at,
        totalScore: j.total_score != null ? Number(j.total_score) : null, totalRating: j.total_rating,
        summary: j.status === 'succeeded' ? j.summary : null,
        weblink: j.weblink || null,
      });
    } catch (err) { send(res, err, 'creative score'); }
  });

  app.get('/api/brainsuite/jobs/:id/media', async (req, res) => {
    try {
      let row = await store.getJob(req.params.id);
      if (!row) throw new HttpError(404, 'Test not found.');
      assertBrandAllowed(req.session, row.brand_id);
      if (row.status !== 'succeeded') throw new HttpError(409, 'This test has no report.');
      // A reused score points at the test that actually ran.
      if (!row.bs_job_id && row.reused_from) row = (await store.getJob(row.reused_from)) || row;
      if (!row.bs_job_id) return res.json({ montage: null, stills: [], heatmovie: null, gone: true });
      res.json(await service.mediaFor(row));
    } catch (err) { send(res, err, 'media'); }
  });

  app.get('/api/brainsuite/usage', async (req, res) => {
    try {
      if (!req.session.isInternal) throw new HttpError(403, 'Internal users only.');
      res.json({ settings: service.settings(), rows: await store.usage() });
    } catch (err) { send(res, err, 'usage'); }
  });

  console.log('[brainsuite] routes mounted at /api/pretests and /api/brainsuite');
};

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
 *   GET    /api/pretest-scores/creative/:id    a creative's Pre-test Score
 *   GET    /api/pretest-scores/jobs/:id/media  fresh image and video links
 *   GET    /api/pretest-scores/jobs/:id/media/file?k=  one heatmap image, through this site (for the PDF)
 *   GET    /api/pretest-scores/usage           this month's tests (internal users)
 *   GET    /api/lens/creative/:id              a creative's Sound and Funnel fit
 *
 * Nothing sent from here names the scoring vendor: the vendor's weblink is
 * kept in the database but never sent, and stored error text is scrubbed.
 */
const { query, assertBrandAllowed } = require('../../db');
const store = require('./store');
const service = require('./service');
const lensStore = require('../lens/store');
const { BUSINESS_GROUPS, CATEGORIES, LANGUAGES, CHANNELS } = require('./briefing');

const { HttpError } = service;

// Errors written before the rename (or passed through from the vendor) can
// carry its name. Scrub on the way out rather than rewriting history.
function scrub(text) {
  if (text == null) return text;
  return String(text)
    .replace(/brainsuite[\w.-]*/gi, 'the scoring service')
    .replace(/the scoring service\s+(POST|GET)\s+\S+\s+failed/gi, 'The scoring service failed');
}

function send(res, err, label) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status
    : (String(err.message || '').startsWith('Access denied') || String(err.message || '').startsWith('No brand access')) ? 403
    : 500;
  if (status >= 500) console.error(`[brainsuite] ${label}:`, err.message);
  // A missing table means the migration has not been run yet.
  if (err.code === '42P01' || err.code === '42703') {
    return res.status(503).json({ error: 'Pre-testing is not set up on this database yet (run server/012_brainsuite.sql).' });
  }
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong. Try again.' : scrub(err.message) });
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
    // What the person said the video is for. Null on older pre-tests.
    objective: row.objective || null,
    contentOrigin: row.briefing && row.briefing.contentOrigin,
    keyMessage: row.briefing && row.briefing.intendedMessages ? row.briefing.intendedMessages[0] : null,
    ctaOverlay: row.briefing && row.briefing.platformCTAOverlay
      ? (row.briefing.platformCTAOverlay === 'overlayPresent' ? 'yes' : 'no') : null,
    requestedBy: row.requested_by_name || row.requested_by,
    error: scrub(row.error),
    createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, expiresAt: row.expires_at,
    totalScore: result ? Number(result.total_score) : (row.total_score != null ? Number(row.total_score) : null),
    totalRating: result ? result.total_rating : (row.total_rating || null),
    summary: result ? result.summary : undefined,
    // Sound and Funnel fit: the short form for the list. builtFor is the
    // objective when one was chosen, else what the video reads as.
    lens: row.lens ? {
      status: row.lens.status, builtFor: row.lens.funnel_intent || null,
      fit: row.lens.funnel_fit, sound: row.lens.sound_score,
    } : null,
    // The video analysis has not finished yet, so the report is not final.
    lensPending: lensPending(row, row.lens),
  };
}

// A stored-mode pre-test whose Sound and Funnel fit are still on their way.
// The worker writes that row once, at the end (or as failed after its last
// attempt), so no row within the first half hour means it is still working.
const LENS_WAIT_MS = 30 * 60 * 1000;
function lensPending(row, lens) {
  if (lens || !row.upload_key) return false;
  if (!['queued', 'analysing', 'succeeded'].includes(row.status)) return false;
  const since = new Date(row.started_at || row.created_at).getTime();
  return Date.now() - since < LENS_WAIT_MS;
}

// The full Sound and Funnel fit for one report. Only what the screen draws.
function publicLens(l) {
  if (!l) return null;
  return { status: l.status, error: scrub(l.error), sound: l.sound, funnel: l.funnel, updatedAt: l.updated_at };
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
      const ref = { kind: 'pretest', pretestId: row.id, brandId: row.brand_id };
      let lens = await lensStore.get(ref).catch(() => null);
      // The report is only shown once it is final. If the score landed a
      // moment ago and the funnel has not been re-worked with the scored
      // checks yet (or was worked out by an older version), do it now.
      if (result && lens && lens.status === 'succeeded' && lens.funnel
          && (lens.funnel.basis !== 'full' || lens.funnel.version !== 2)) {
        await require('../lens/service').refreshFunnel(ref);
        lens = await lensStore.get(ref).catch(() => lens);
      }
      res.json({ ...publicRow({ ...row, requested_by_name: rows[0] && rows[0].display_name, lens }, result),
        lensReport: publicLens(lens), canManage: canManage(req, row) });
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

  app.get('/api/pretest-scores/creative/:creativeId', async (req, res) => {
    try {
      const { rows } = await query(`select brand_id from creatives where creative_id = $1`, [req.params.creativeId]);
      if (!rows.length) throw new HttpError(404, 'Creative not found.');
      assertBrandAllowed(req.session, rows[0].brand_id);
      const j = await store.latestForCreative(req.params.creativeId);
      if (!j) return res.json({ status: 'none' });
      res.json({
        id: j.id, status: j.status, error: scrub(j.error), channel: j.channel,
        channelLabel: CHANNELS[j.channel] || j.channel,
        reused: !!j.reused_from, completedAt: j.completed_at,
        totalScore: j.total_score != null ? Number(j.total_score) : null, totalRating: j.total_rating,
        summary: j.status === 'succeeded' ? j.summary : null,
      });
    } catch (err) { send(res, err, 'creative score'); }
  });

  // A tracked creative's Sound and Funnel fit.
  app.get('/api/lens/creative/:creativeId', async (req, res) => {
    try {
      const { rows } = await query(`select brand_id from creatives where creative_id = $1`, [req.params.creativeId]);
      if (!rows.length) throw new HttpError(404, 'Creative not found.');
      assertBrandAllowed(req.session, rows[0].brand_id);
      const l = await lensStore.get({ kind: 'creative', creativeId: req.params.creativeId });
      res.json(l ? publicLens(l) : { status: 'none' });
    } catch (err) {
      if (err.code === '42P01') return res.json({ status: 'none' });
      send(res, err, 'lens creative');
    }
  });

  // One heatmap image, fetched here and passed on, so the PDF can draw it:
  // a browser will not let a page copy pixels from another site's image.
  // Only the images of a test the person can open, by name, never a URL.
  app.get('/api/pretest-scores/jobs/:id/media/file', async (req, res) => {
    try {
      const k = String(req.query.k || '');
      if (!/^(montage|still[0-9])$/.test(k)) throw new HttpError(400, 'Unknown image.');
      let row = await store.getJob(req.params.id);
      if (!row) throw new HttpError(404, 'Test not found.');
      assertBrandAllowed(req.session, row.brand_id);
      if (row.status !== 'succeeded') throw new HttpError(409, 'This test has no report.');
      if (!row.bs_job_id && row.reused_from) row = (await store.getJob(row.reused_from)) || row;
      if (!row.bs_job_id) throw new HttpError(404, 'No images for this test.');
      const m = await service.mediaFor(row);
      const url = k === 'montage' ? m.montage : ((m.stills || [])[Number(k.slice(5))] || {}).url;
      if (!url || !/^https:\/\//i.test(url)) throw new HttpError(404, 'Image not available.');
      const r = await require('axios').get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 15 * 1024 * 1024, maxRedirects: 2 });
      const type = String(r.headers['content-type'] || '');
      if (!/^image\/(png|jpe?g|webp|gif)/i.test(type)) throw new HttpError(502, 'Not an image.');
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
      res.send(Buffer.from(r.data));
    } catch (err) { send(res, err, 'media file'); }
  });

  app.get('/api/pretest-scores/jobs/:id/media', async (req, res) => {
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

  app.get('/api/pretest-scores/usage', async (req, res) => {
    try {
      if (!req.session.isInternal) throw new HttpError(403, 'Internal users only.');
      res.json({ settings: service.settings(), rows: await store.usage() });
    } catch (err) { send(res, err, 'usage'); }
  });

  console.log('[brainsuite] routes mounted at /api/pretests and /api/pretest-scores');
};

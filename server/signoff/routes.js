/**
 * Campaign sign-off: the API.
 *
 * Unilever and Mindshare accounts (can_signoff) create and edit checklists
 * for the brands they can see and send them to the media head. The media
 * head (role 'media_head', Chaminda) is the only approver: he fills in his
 * section, marks items OK or needing a change, sends it back or approves.
 * Approving locks the checklist and adds the campaign to the brand.
 *
 *   GET    /api/signoffs                 list (brands this session can see)
 *   GET    /api/signoffs/summary         { waiting } for the menu badge
 *   GET    /api/signoffs/:id             one checklist, its notes, activity, versions
 *   POST   /api/signoffs                 new draft                      creators
 *   PUT    /api/signoffs/:id             save                           creators, draft or sent back
 *   POST   /api/signoffs/:id/submit      save and send to the media head creators
 *   DELETE /api/signoffs/:id             delete a draft never sent      creators
 *   POST   /api/signoffs/:id/duplicate   copy into a new draft          creators
 *   POST   /api/signoffs/:id/amend       new version of an approved one creators
 *   PUT    /api/signoffs/:id/review      save the media head's section  media head, while with him
 *   POST   /api/signoffs/:id/return      send back for changes          media head
 *   POST   /api/signoffs/:id/approve     approve                        media head
 *   POST   /api/signoffs/:id/notes       add a note                     anyone who can see it
 *
 * The page hides what a person cannot do; this file is what enforces it.
 * The checklist itself is defined once in public/js/signoff-items.js.
 */
const { pool, query, assertBrandAllowed } = require('../../db');
const Items = require('../../public/js/signoff-items.js');

const EDITABLE = ['draft', 'changes_requested'];
const ITEM_KEYS = new Set(Items.ITEMS.map((i) => i.key));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isReviewer = (req) => req.session.role === 'media_head';
const canCreate = (req) => !isReviewer(req) && (req.session.features || {}).signoff !== false;

function requireCreator(req) {
  if (!canCreate(req)) throw new HttpError(403, 'Only Unilever and Mindshare accounts can do this.');
}
function requireReviewer(req) {
  if (!isReviewer(req)) throw new HttpError(403, 'Only the media head can do this.');
}

const clip = (v, n = 500) => (v === null || v === undefined ? null : String(v).slice(0, n));
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

function cleanMeta(m) {
  m = m || {};
  return {
    campaignName: clip(m.campaignName, 160) || '',
    market: clip(m.market, 80) || '',
    goLive: dateOrNull(m.goLive) || '',
    clientLead: clip(m.clientLead, 120) || '',
    variant: clip(m.variant, 160) || '',
    format: clip(m.format, 160) || '',
    datePrepared: dateOrNull(m.datePrepared) || '',
  };
}

/** Only the shape the checklist uses, so nothing else lands in the jsonb. */
function cleanFields(x) {
  const b = Items.blankFields();
  x = x || {};
  const s = (v, n) => (v === null || v === undefined ? '' : String(v).slice(0, n || 400));
  const pick = (v, list) => (list.includes(v) ? v : null);
  const fu = x.funnel || {};
  b.funnel.tofu = s(fu.tofu); b.funnel.mofu = s(fu.mofu); b.funnel.bofu = s(fu.bofu);
  const bu = fu.budget || {};
  for (const k of ['tofu', 'mofu', 'bofu']) b.funnel.budget[k] = isFinite(Number(bu[k])) && bu[k] !== '' ? Number(bu[k]) : 0;
  const bid = fu.bid || {};
  for (const [st, opts] of Object.entries(Items.FUNNEL_BID)) b.funnel.bid[st] = pick(bid[st], opts);
  const de = x.delivery || {};
  for (const [k] of Items.DELIVERY_FIELDS) b.delivery[k] = s(de[k], 60);
  const se = x.setup || {};
  b.setup.audienceDone = pick(se.audienceDone, Items.YES_NO);
  b.setup.startDate = dateOrNull(se.startDate) || '';
  b.setup.endDate = dateOrNull(se.endDate) || '';
  b.setup.tgSize = s(se.tgSize, 60);
  b.setup.creativeTypes = (Array.isArray(se.creativeTypes) ? se.creativeTypes : []).filter((v) => Items.CREATIVE_TYPES.includes(v));
  b.setup.landingLinks = s(se.landingLinks, 2000);
  const co = x.costs || {};
  b.costs.platform = s(co.platform, 120); b.costs.data = s(co.data, 120); b.costs.adServing = s(co.adServing, 120);
  b.costs.verification = pick(co.verification, Items.YES_NO);
  b.costs.pd1 = pick(co.pd1, Items.YES_NO);
  b.costs.retainer = pick(co.retainer, Items.YES_NO);
  b.costs.ustore = pick(co.ustore, Items.YES_NO);
  b.costs.google = (Array.isArray(co.google) ? co.google : []).filter((v) => Items.GOOGLE_ALLOC.includes(v));
  if (b.costs.google.includes('Not used')) b.costs.google = ['Not used'];
  b.costs.other = s(co.other, 2000);
  return b;
}

function cleanReview(x, current) {
  const out = Object.assign({ items: {} }, current || {});
  x = x || {};
  if ('approvedBudget' in x) out.approvedBudget = clip(x.approvedBudget, 160) || '';
  if ('kpis' in x) out.kpis = clip(x.kpis, 1000) || '';
  if ('conditions' in x) out.conditions = clip(x.conditions, 1000) || '';
  if (x.items && typeof x.items === 'object') {
    out.items = Object.assign({}, out.items);
    for (const [k, v] of Object.entries(x.items)) {
      if (!ITEM_KEYS.has(k)) continue;
      if (v === 'ok' || v === 'change') out.items[k] = v;
      else if (v === null || v === '') delete out.items[k];
    }
  }
  return out;
}

/** The record shape signoff-items.js reads. */
const asRecord = (row) => ({
  brand_id: row.brand_id,
  meta: {
    campaignName: row.campaign_name || '', market: row.market || '',
    goLive: row.go_live_date ? isoDate(row.go_live_date) : '',
    clientLead: row.client_lead_name || '', variant: row.variant || '', format: row.format || '',
    datePrepared: row.date_prepared ? isoDate(row.date_prepared) : '',
  },
  fields: row.fields || {},
});

function isoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // A date column comes back as midnight local time; read it back the same way.
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

async function displayName(username) {
  const { rows } = await query(`select display_name from app_users where username = $1`, [username]);
  return (rows[0] && rows[0].display_name) || username;
}

async function logEvent(db, id, action, req, detail) {
  await db.query(
    `insert into sign_off_events (sign_off_id, action, actor, actor_name, detail) values ($1, $2, $3, $4, $5)`,
    [id, action, req.session.user, await displayName(req.session.user), JSON.stringify(detail || {})]);
}

/** One sign-off this session may see, or a 404 / 403. */
async function load(req, id, db) {
  if (!/^\d+$/.test(String(id))) throw new HttpError(404, 'Sign-off not found.');
  const { rows } = await (db || pool).query(`select * from sign_offs where id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Sign-off not found.');
  try { assertBrandAllowed(req.session, rows[0].brand_id); }
  catch (e) { throw new HttpError(403, 'You do not have access to this brand.'); }
  return rows[0];
}

/** Run fn inside one transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function writeRecord(db, id, req, body) {
  const meta = cleanMeta(body.meta);
  const fields = cleanFields(body.fields);
  await db.query(
    `update sign_offs
        set campaign_name = $2, market = $3, go_live_date = nullif($4,'')::date,
            client_lead_name = $5, variant = $6, format = $7, date_prepared = nullif($8,'')::date,
            fields = $9, updated_by = $10, updated_at = now()
      where id = $1`,
    [id, meta.campaignName, meta.market || null, meta.goLive, meta.clientLead || null,
     meta.variant || null, meta.format || null, meta.datePrepared, JSON.stringify(fields), req.session.user]);
}

module.exports = function mountSignoff(app) {
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      const status = err.status || (String(err.message).startsWith('Access denied') ? 403 : 500);
      if (status >= 500) console.error('[signoffs]', req.method, req.path, err.message);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
    }
  };

  // ---- List and summary -------------------------------------------------
  app.get('/api/signoffs', wrap(async (req, res) => {
    const { rows } = await query(
      `select s.id, s.brand_id, b.name as brand_name, s.status, s.version, s.parent_id,
              s.campaign_name, s.market, s.go_live_date, s.client_lead_name, s.variant, s.format,
              s.date_prepared, s.fields, s.review, s.created_by, s.created_at, s.updated_at,
              s.submitted_at, s.returned_at, s.approved_by, s.approved_at, s.campaign_id,
              coalesce(cu.display_name, s.created_by) as created_by_name,
              (select count(*) from sign_off_notes n where n.sign_off_id = s.id)::int as notes,
              (select max(at) from sign_off_events e where e.sign_off_id = s.id) as last_activity
         from sign_offs s
         left join brands b on b.brand_id = s.brand_id
         left join app_users cu on cu.username = s.created_by
        where s.brand_id = any($1)
        order by coalesce(s.updated_at, s.created_at) desc`,
      [req.session.brands || []]);
    res.json({
      signoffs: rows.map((r) => Object.assign(r, { progress: Items.progress(asRecord(r)) })),
      me: { username: req.session.user, reviewer: isReviewer(req), canCreate: canCreate(req) },
    });
  }));

  app.get('/api/signoffs/summary', wrap(async (req, res) => {
    const status = isReviewer(req) ? 'submitted' : 'changes_requested';
    const { rows } = await query(
      `select count(*)::int as n from sign_offs where brand_id = any($1) and status = $2`,
      [req.session.brands || [], status]);
    res.json({ waiting: rows[0].n, reviewer: isReviewer(req) });
  }));

  // ---- One sign-off -----------------------------------------------------
  app.get('/api/signoffs/:id', wrap(async (req, res) => {
    const s = await load(req, req.params.id);
    const [notes, events, versions, brand] = await Promise.all([
      query(`select id, item_key, author, author_name, is_reviewer, body, created_at
               from sign_off_notes where sign_off_id = $1 order by created_at`, [s.id]),
      query(`select action, actor, actor_name, detail, at
               from sign_off_events where sign_off_id = $1 order by at`, [s.id]),
      query(`with recursive up as (
                 select id, parent_id from sign_offs where id = $1
                 union all
                 select p.id, p.parent_id from sign_offs p join up on p.id = up.parent_id),
               root as (select id from up where parent_id is null),
               down as (
                 select id from root
                 union all
                 select c.id from sign_offs c join down on c.parent_id = down.id)
             select s.id, s.version, s.status, s.approved_at
               from sign_offs s where s.id in (select id from down) order by s.version`, [s.id]),
      query(`select name from brands where brand_id = $1`, [s.brand_id]),
    ]);
    const rec = asRecord(s);
    res.json({
      signoff: Object.assign(s, {
        brand_name: brand.rows[0] ? brand.rows[0].name : s.brand_id,
        meta: rec.meta, progress: Items.progress(rec),
        created_by_name: await displayName(s.created_by),
      }),
      notes: notes.rows, events: events.rows, versions: versions.rows,
      me: { username: req.session.user, reviewer: isReviewer(req), canCreate: canCreate(req) },
    });
  }));

  // ---- Creators ----------------------------------------------------------
  app.post('/api/signoffs', wrap(async (req, res) => {
    requireCreator(req);
    const brand = assertBrandAllowed(req.session, req.body.brand_id);
    const meta = cleanMeta(req.body.meta);
    if (!meta.campaignName.trim()) throw new HttpError(400, 'Give the campaign a name first.');
    const id = await tx(async (db) => {
      const { rows } = await db.query(
        `insert into sign_offs (brand_id, status, campaign_name, created_by, updated_by, fields)
         values ($1, 'draft', $2, $3, $3, '{}'::jsonb) returning id`,
        [brand, meta.campaignName, req.session.user]);
      await writeRecord(db, rows[0].id, req, req.body);
      await logEvent(db, rows[0].id, 'created', req);
      return rows[0].id;
    });
    res.status(201).json({ id });
  }));

  app.put('/api/signoffs/:id', wrap(async (req, res) => {
    requireCreator(req);
    const s = await load(req, req.params.id);
    if (!EDITABLE.includes(s.status)) throw new HttpError(409, 'This checklist is not open for editing.');
    if (!cleanMeta(req.body.meta).campaignName.trim()) throw new HttpError(400, 'The campaign needs a name.');
    if (req.body.brand_id && req.body.brand_id !== s.brand_id) {
      if (s.status !== 'draft' || s.version > 1) throw new HttpError(409, 'The brand can only change on a first draft.');
      const brand = assertBrandAllowed(req.session, req.body.brand_id);
      await query(`update sign_offs set brand_id = $2 where id = $1`, [s.id, brand]);
    }
    await writeRecord(pool, s.id, req, req.body);
    res.json({ ok: true });
  }));

  app.post('/api/signoffs/:id/submit', wrap(async (req, res) => {
    requireCreator(req);
    const result = await tx(async (db) => {
      const s = await load(req, req.params.id, db);
      if (!EDITABLE.includes(s.status)) throw new HttpError(409, 'This checklist has already been sent.');
      if (req.body && req.body.meta) await writeRecord(db, s.id, req, req.body);
      const { rows } = await db.query(`select * from sign_offs where id = $1`, [s.id]);
      const problems = Items.submitProblems(asRecord(rows[0]));
      if (problems.length) return { problems };
      // Items the media head asked to change are marked for him to check again.
      const review = cleanReview({}, rows[0].review);
      for (const [k, v] of Object.entries(review.items)) if (v === 'change') review.items[k] = 'recheck';
      const resubmit = s.status === 'changes_requested';
      await db.query(
        `update sign_offs set status = 'submitted', submitted_by = $2, submitted_at = now(), review = $3,
                updated_by = $2, updated_at = now()
          where id = $1`,
        [s.id, req.session.user, JSON.stringify(review)]);
      await logEvent(db, s.id, resubmit ? 'resubmitted' : 'submitted', req);
      return { ok: true };
    });
    if (result.problems) return res.status(422).json({ error: 'Some items still need filling in.', problems: result.problems });
    res.json(result);
  }));

  app.delete('/api/signoffs/:id', wrap(async (req, res) => {
    requireCreator(req);
    const s = await load(req, req.params.id);
    if (s.status !== 'draft' || s.submitted_at) throw new HttpError(409, 'Only a draft that was never sent can be deleted.');
    await tx(async (db) => {
      await db.query(`delete from sign_off_notes where sign_off_id = $1`, [s.id]);
      await db.query(`delete from sign_off_events where sign_off_id = $1`, [s.id]);
      await db.query(`delete from sign_offs where id = $1`, [s.id]);
    });
    res.json({ ok: true });
  }));

  async function copyInto(db, s, req, { version, parentId, name }) {
    const { rows } = await db.query(
      `insert into sign_offs (brand_id, status, version, parent_id, campaign_name, market, go_live_date,
                              client_lead_name, variant, format, date_prepared, fields, created_by, updated_by)
       select brand_id, 'draft', $2, $3, $4, market, go_live_date, client_lead_name, variant, format,
              current_date, fields, $5, $5
         from sign_offs where id = $1
       returning id`,
      [s.id, version, parentId, name, req.session.user]);
    return rows[0].id;
  }

  app.post('/api/signoffs/:id/duplicate', wrap(async (req, res) => {
    requireCreator(req);
    const s = await load(req, req.params.id);
    const name = clip((req.body && req.body.campaignName) || `${s.campaign_name} (copy)`, 160);
    const id = await tx(async (db) => {
      const nid = await copyInto(db, s, req, { version: 1, parentId: null, name });
      await logEvent(db, nid, 'created', req, { copied_from: s.id });
      return nid;
    });
    res.status(201).json({ id });
  }));

  app.post('/api/signoffs/:id/amend', wrap(async (req, res) => {
    requireCreator(req);
    const s = await load(req, req.params.id);
    if (s.status !== 'approved') throw new HttpError(409, 'Only an approved checklist can be amended.');
    const open = await query(
      `select id from sign_offs where parent_id = $1 and status in ('draft','submitted','changes_requested')`, [s.id]);
    if (open.rows.length) return res.status(409).json({ error: 'An amendment is already open.', id: open.rows[0].id });
    const id = await tx(async (db) => {
      const nid = await copyInto(db, s, req, { version: s.version + 1, parentId: s.id, name: s.campaign_name });
      await logEvent(db, nid, 'created', req, { amends: s.id, version: s.version + 1 });
      await logEvent(db, s.id, 'amended', req, { amendment: nid, version: s.version + 1 });
      return nid;
    });
    res.status(201).json({ id });
  }));

  // ---- Media head --------------------------------------------------------
  app.put('/api/signoffs/:id/review', wrap(async (req, res) => {
    requireReviewer(req);
    const s = await load(req, req.params.id);
    if (s.status !== 'submitted') throw new HttpError(409, 'This checklist is not with you for review.');
    const review = cleanReview(req.body, s.review);
    await query(`update sign_offs set review = $2, updated_at = now() where id = $1`, [s.id, JSON.stringify(review)]);
    res.json({ ok: true, review });
  }));

  app.post('/api/signoffs/:id/return', wrap(async (req, res) => {
    requireReviewer(req);
    await tx(async (db) => {
      const s = await load(req, req.params.id, db);
      if (s.status !== 'submitted') throw new HttpError(409, 'This checklist is not with you for review.');
      const review = cleanReview(req.body, s.review);
      const flagged = Object.entries(review.items).filter(([, v]) => v === 'change').map(([k]) => k);
      const note = clip(req.body && req.body.note, 2000);
      if (!flagged.length && !(note && note.trim())) {
        throw new HttpError(400, 'Mark the items that need changing, or add a note saying what to change.');
      }
      if (note && note.trim()) {
        await db.query(
          `insert into sign_off_notes (sign_off_id, item_key, author, author_name, is_reviewer, body)
           values ($1, null, $2, $3, true, $4)`,
          [s.id, req.session.user, await displayName(req.session.user), note.trim()]);
      }
      await db.query(
        `update sign_offs set status = 'changes_requested', review = $2, returned_by = $3, returned_at = now(),
                updated_at = now()
          where id = $1`,
        [s.id, JSON.stringify(review), req.session.user]);
      await logEvent(db, s.id, 'changes_requested', req, { items: flagged });
    });
    res.json({ ok: true });
  }));

  app.post('/api/signoffs/:id/approve', wrap(async (req, res) => {
    requireReviewer(req);
    const out = await tx(async (db) => {
      const s = await load(req, req.params.id, db);
      if (s.status !== 'submitted') throw new HttpError(409, 'This checklist is not with you for review.');
      const review = cleanReview(req.body, s.review);
      if (!review.approvedBudget || !review.approvedBudget.trim()) {
        throw new HttpError(400, 'Fill in the approved budget before approving.');
      }
      const flagged = Object.entries(review.items).filter(([, v]) => v === 'change').map(([k]) => k);
      if (flagged.length) throw new HttpError(400, 'Some items are marked as needing a change. Send it back, or mark them OK.');
      // Approving signs off every item.
      for (const i of Items.ITEMS) review.items[i.key] = 'ok';

      // The campaign, in the same place the Add creative form reads from.
      const c = await db.query(
        `insert into campaigns (brand_id, name) values ($1, $2)
         on conflict (brand_id, name) do update set is_active = true
         returning id`,
        [s.brand_id, s.campaign_name]);
      await db.query(
        `update sign_offs set status = 'approved', review = $2, approved_by = $3, approved_at = now(),
                campaign_id = $4, updated_at = now()
          where id = $1`,
        [s.id, JSON.stringify(review), req.session.user, c.rows[0].id]);
      await logEvent(db, s.id, 'approved', req, { campaign_id: c.rows[0].id });
      if (s.parent_id) {
        await db.query(`update sign_offs set status = 'superseded', updated_at = now() where id = $1 and status = 'approved'`, [s.parent_id]);
        await logEvent(db, s.parent_id, 'superseded', req, { by: s.id, version: s.version });
      }
      return { campaign: s.campaign_name };
    });
    res.json(Object.assign({ ok: true }, out));
  }));

  // ---- Notes -------------------------------------------------------------
  app.post('/api/signoffs/:id/notes', wrap(async (req, res) => {
    if (!isReviewer(req) && !canCreate(req)) throw new HttpError(403, 'You cannot add notes here.');
    const s = await load(req, req.params.id);
    const body = clip(req.body && req.body.body, 2000);
    if (!body || !body.trim()) throw new HttpError(400, 'Write something first.');
    const key = req.body.item_key && ITEM_KEYS.has(req.body.item_key) ? req.body.item_key : null;
    const { rows } = await query(
      `insert into sign_off_notes (sign_off_id, item_key, author, author_name, is_reviewer, body)
       values ($1, $2, $3, $4, $5, $6)
       returning id, item_key, author, author_name, is_reviewer, body, created_at`,
      [s.id, key, req.session.user, await displayName(req.session.user), isReviewer(req), body.trim()]);
    res.status(201).json({ note: rows[0] });
  }));
};

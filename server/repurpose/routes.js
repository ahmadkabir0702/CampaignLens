/**
 * Assign agency for repurposing: the API.
 *
 * Unilever and Mindshare accounts assign a creative to an agency with a
 * due date. The agency marks it done; a Unilever account approves it or
 * reopens it with a note. The media head sees everything, read-only.
 * A creative qualifies when it has something to act on: a paid
 * recommendation if it ran on paid, a pre-test score if organic only.
 *
 *   GET  /api/repurpose                     tasks this account can see
 *   GET  /api/repurpose/summary             { waiting } for the menu badge
 *   GET  /api/repurpose/open                open task per creative (hub card tags)
 *   GET  /api/repurpose/creative/:id        a creative's eligibility, agencies, tasks
 *   POST /api/repurpose                     assign            Unilever, Mindshare
 *   POST /api/repurpose/:id/done            mark done         the agency it is with
 *   POST /api/repurpose/:id/approve         approve           Unilever
 *   POST /api/repurpose/:id/reopen          reopen, with note Unilever
 *   POST /api/repurpose/:id/cancel          withdraw          Unilever, Mindshare
 *   POST /api/repurpose/:id/due             change due date   Unilever, Mindshare
 *
 * Who is on which side comes from app_users.org and agency_key (036),
 * read once per session.
 */
const { pool, query, assertBrandAllowed } = require('../../db');

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

async function who(req) {
  if (req.session.rp === undefined) {
    const { rows } = await query(
      `select org, agency_key, role, coalesce(display_name, username) as name from app_users where username = $1`,
      [req.session.user]);
    const r = rows[0] || {};
    req.session.rp = { org: r.org || null, agencyKey: r.agency_key || null, name: r.name || req.session.user };
  }
  const rp = req.session.rp;
  const viewer = req.session.role === 'media_head';
  return {
    org: rp.org, agencyKey: rp.agencyKey, name: rp.name, viewer,
    canAssign: !viewer && (rp.org === 'unilever' || rp.org === 'mindshare'),
    canApprove: !viewer && rp.org === 'unilever',
    isAgency: rp.org === 'agency',
  };
}

const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
const todayLK = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

async function logEvent(db, taskId, action, me, req, note) {
  await db.query(
    `insert into repurpose_task_events (task_id, action, actor, actor_name, note) values ($1, $2, $3, $4, $5)`,
    [taskId, action, req.session.user, me.name, note || null]);
}

/** What the account may see: its brands, and for an agency only its own tasks. */
function scope(me, req, alias = 't') {
  const params = [req.session.brands || []];
  let where = `${alias}.brand_id = any($1)`;
  if (me.isAgency) { params.push(me.agencyKey || '-'); where += ` and ${alias}.agency_key = $2`; }
  return { where, params };
}

/** Whether a creative has something to act on, and why not if it does not. */
async function eligibility(creativeId) {
  const { rows } = await query(
    `select c.creative_id, c.brand_id,
            (exists (select 1 from paid_meta m where m.creative_id = c.creative_id)
             or exists (select 1 from paid_tiktok t where t.creative_id = c.creative_id)) as paid,
            exists (select 1 from recommendations r where r.creative_id = c.creative_id
                     and coalesce(r.recommendation, '') <> '') as has_rec
       from creatives c where c.creative_id = $1`, [creativeId]);
  if (!rows.length) return null;
  const c = rows[0];
  let hasPretest = false;
  try {
    const p = await query(
      `select 1 from brainsuite_jobs where creative_id = $1 and kind = 'creative' and status = 'succeeded' limit 1`, [creativeId]);
    hasPretest = p.rows.length > 0;
  } catch (e) { /* pre-testing not installed */ }
  const eligible = c.paid ? c.has_rec : hasPretest;
  const reason = eligible ? null
    : c.paid ? 'This creative ran on paid and has no recommendation yet. It can be assigned once it has one.'
    : 'This creative is organic only and has no pre-test score yet. It can be assigned once it has been pre-tested.';
  return { brandId: c.brand_id, paid: c.paid, hasRec: c.has_rec, hasPretest, eligible, reason };
}

/** Agencies that handle a brand: those with an active login that can see it. */
async function agenciesFor(brandId) {
  const { rows } = await query(
    `select distinct a.agency_id::text as key, a.name
       from agencies a
       join app_users u on u.agency_key = a.agency_id::text and u.is_active and u.org = 'agency'
       join v_user_access v on v.username = u.username
      where $1 = any(v.brands)
        and coalesce(a.is_active, true)
      order by a.name`, [brandId]);
  return rows;
}

const TASK_COLS = `t.id, t.creative_id, t.brand_id, b.name as brand_name, t.agency_key, t.agency_name, t.status,
       t.due_date, t.assigned_by, coalesce(ua.display_name, t.assigned_by) as assigned_by_name, t.assigned_at,
       t.done_by, coalesce(ud.display_name, t.done_by) as done_by_name, t.done_at,
       t.approved_by, coalesce(up.display_name, t.approved_by) as approved_by_name, t.approved_at,
       t.cancelled_at, t.reopened, t.updated_at,
       c.campaign, c.type as creative_type, c.thumbnail_url,
       (select e.note from repurpose_task_events e where e.task_id = t.id and e.action = 'reopened'
         order by e.at desc limit 1) as last_reopen_note`;
const TASK_FROM = `from repurpose_tasks t
       left join creatives c on c.creative_id = t.creative_id
       left join brands b on b.brand_id = t.brand_id
       left join app_users ua on ua.username = t.assigned_by
       left join app_users ud on ud.username = t.done_by
       left join app_users up on up.username = t.approved_by`;

async function loadTask(req, me, id, db) {
  if (!/^\d+$/.test(String(id))) throw new HttpError(404, 'Request not found.');
  const { rows } = await (db || pool).query(`select * from repurpose_tasks where id = $1 for update`, [id]);
  if (!rows.length) throw new HttpError(404, 'Request not found.');
  const t = rows[0];
  try { assertBrandAllowed(req.session, t.brand_id); } catch (e) { throw new HttpError(403, 'You do not have access to this brand.'); }
  if (me.isAgency && t.agency_key !== me.agencyKey) throw new HttpError(403, 'This request is with another agency.');
  return t;
}

async function tx(fn) {
  const client = await pool.connect();
  try { await client.query('begin'); const out = await fn(client); await client.query('commit'); return out; }
  catch (e) { await client.query('rollback').catch(() => {}); throw e; }
  finally { client.release(); }
}

module.exports = function mountRepurpose(app) {
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      const status = err.status || (String(err.message).startsWith('Access denied') ? 403 : 500);
      if (status >= 500) console.error('[repurpose]', req.method, req.path, err.message);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
    }
  };
  const meOut = (me) => ({ org: me.org, canAssign: me.canAssign, canApprove: me.canApprove, isAgency: me.isAgency, viewer: me.viewer });

  app.get('/api/repurpose', wrap(async (req, res) => {
    const me = await who(req);
    const s = scope(me, req);
    const { rows } = await query(
      `select ${TASK_COLS} ${TASK_FROM}
        where ${s.where} and t.status <> 'cancelled'
        order by case t.status when 'assigned' then 0 when 'done' then 1 else 2 end, t.due_date, t.id desc`, s.params);
    // Turnaround per agency, from requests approved in the last 180 days.
    const perf = me.isAgency ? [] : (await query(
      `select t.agency_name,
              count(*) filter (where t.status in ('assigned','done'))::int as open,
              count(*) filter (where t.status = 'assigned' and t.due_date < (now() at time zone 'Asia/Colombo')::date)::int as overdue,
              round(avg(extract(epoch from (t.approved_at - t.assigned_at)) / 86400) filter (where t.status = 'approved'), 1) as avg_days,
              round(100.0 * count(*) filter (where t.status = 'approved' and (t.done_at at time zone 'Asia/Colombo')::date <= t.due_date)
                    / nullif(count(*) filter (where t.status = 'approved'), 0)) as on_time_pct,
              count(*) filter (where t.status = 'approved')::int as approved
         from repurpose_tasks t
        where t.brand_id = any($1) and t.status <> 'cancelled'
          and t.assigned_at > now() - interval '180 days'
        group by t.agency_name order by t.agency_name`, [req.session.brands || []])).rows;
    res.json({ tasks: rows, perf, me: meOut(me), today: todayLK() });
  }));

  app.get('/api/repurpose/summary', wrap(async (req, res) => {
    const me = await who(req);
    const s = scope(me, req);
    const status = me.isAgency ? 'assigned' : me.canApprove ? 'done' : null;
    if (!status) return res.json({ waiting: 0 });
    const { rows } = await query(`select count(*)::int as n from repurpose_tasks t where ${s.where} and t.status = '${status}'`, s.params);
    res.json({ waiting: rows[0].n, me: meOut(me) });
  }));

  app.get('/api/repurpose/open', wrap(async (req, res) => {
    const me = await who(req);
    const s = scope(me, req);
    const { rows } = await query(
      `select t.creative_id, t.agency_name, t.status, t.due_date from repurpose_tasks t
        where ${s.where} and t.status in ('assigned','done')`, s.params);
    res.json({ open: rows, today: todayLK() });
  }));

  app.get('/api/repurpose/creative/:id', wrap(async (req, res) => {
    const me = await who(req);
    const el = await eligibility(req.params.id);
    if (!el) throw new HttpError(404, 'Creative not found.');
    try { assertBrandAllowed(req.session, el.brandId); } catch (e) { throw new HttpError(403, 'You do not have access to this brand.'); }
    const s = scope(me, req);
    s.params.push(req.params.id);
    const tasks = (await query(
      `select ${TASK_COLS} ${TASK_FROM} where ${s.where} and t.creative_id = $${s.params.length} order by t.assigned_at desc`, s.params)).rows;
    const ids = tasks.map((t) => t.id);
    const events = ids.length ? (await query(
      `select task_id, action, actor, actor_name, note, at from repurpose_task_events where task_id = any($1) order by at`, [ids])).rows : [];
    res.json({
      eligible: el.eligible, reason: el.reason,
      agencies: me.canAssign ? await agenciesFor(el.brandId) : [],
      tasks, events, me: meOut(me), today: todayLK(),
    });
  }));

  app.post('/api/repurpose', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.canAssign) throw new HttpError(403, 'Only Unilever and Mindshare accounts can assign repurposing.');
    const { creative_id, agency_key, due_date } = req.body || {};
    const el = await eligibility(creative_id);
    if (!el) throw new HttpError(404, 'Creative not found.');
    try { assertBrandAllowed(req.session, el.brandId); } catch (e) { throw new HttpError(403, 'You do not have access to this brand.'); }
    if (!el.eligible) throw new HttpError(409, el.reason);
    if (!dateOk(due_date)) throw new HttpError(400, 'Pick a due date.');
    if (due_date < todayLK()) throw new HttpError(400, 'The due date has already passed.');
    const agency = (await agenciesFor(el.brandId)).find((a) => a.key === String(agency_key));
    if (!agency) throw new HttpError(400, 'Pick an agency that handles this brand.');
    const id = await tx(async (db) => {
      const open = await db.query(`select id from repurpose_tasks where creative_id = $1 and status in ('assigned','done')`, [creative_id]);
      if (open.rows.length) throw new HttpError(409, 'This creative is already with an agency.');
      const { rows } = await db.query(
        `insert into repurpose_tasks (creative_id, brand_id, agency_key, agency_name, due_date, assigned_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [creative_id, el.brandId, agency.key, agency.name, due_date, req.session.user]);
      await logEvent(db, rows[0].id, 'assigned', me, req, null);
      return rows[0].id;
    });
    res.status(201).json({ id });
  }));

  app.post('/api/repurpose/:id/done', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.isAgency) throw new HttpError(403, 'Only the agency can mark this done.');
    await tx(async (db) => {
      const t = await loadTask(req, me, req.params.id, db);
      if (t.status !== 'assigned') throw new HttpError(409, 'This request is not open.');
      await db.query(`update repurpose_tasks set status = 'done', done_by = $2, done_at = now(), updated_at = now() where id = $1`, [t.id, req.session.user]);
      await logEvent(db, t.id, 'done', me, req, String((req.body || {}).note || '').slice(0, 1000).trim() || null);
    });
    res.json({ ok: true });
  }));

  app.post('/api/repurpose/:id/approve', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.canApprove) throw new HttpError(403, 'Only a Unilever account can approve this.');
    await tx(async (db) => {
      const t = await loadTask(req, me, req.params.id, db);
      if (t.status !== 'done') throw new HttpError(409, 'The agency has not marked this done yet.');
      await db.query(`update repurpose_tasks set status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() where id = $1`, [t.id, req.session.user]);
      await logEvent(db, t.id, 'approved', me, req, null);
      // The creative's paid recommendations read as actioned, by this agency.
      await db.query(
        `update recommendations set action_status = 'Actioned', actioned_by = $2,
                action_date = (now() at time zone 'Asia/Colombo')::date, agency = $3, updated_at = now()
          where creative_id = $1`, [t.creative_id, me.name, t.agency_name]);
    });
    res.json({ ok: true });
  }));

  app.post('/api/repurpose/:id/reopen', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.canApprove) throw new HttpError(403, 'Only a Unilever account can reopen this.');
    const note = String((req.body || {}).note || '').slice(0, 1000).trim();
    if (!note) throw new HttpError(400, 'Say what is still to be done.');
    await tx(async (db) => {
      const t = await loadTask(req, me, req.params.id, db);
      if (t.status !== 'done') throw new HttpError(409, 'Only a request marked done can be reopened.');
      await db.query(`update repurpose_tasks set status = 'assigned', done_by = null, done_at = null, reopened = reopened + 1, updated_at = now() where id = $1`, [t.id]);
      await logEvent(db, t.id, 'reopened', me, req, note);
    });
    res.json({ ok: true });
  }));

  app.post('/api/repurpose/:id/cancel', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.canAssign) throw new HttpError(403, 'Only Unilever and Mindshare accounts can withdraw a request.');
    await tx(async (db) => {
      const t = await loadTask(req, me, req.params.id, db);
      if (!['assigned', 'done'].includes(t.status)) throw new HttpError(409, 'This request is already closed.');
      await db.query(`update repurpose_tasks set status = 'cancelled', cancelled_by = $2, cancelled_at = now(), updated_at = now() where id = $1`, [t.id, req.session.user]);
      await logEvent(db, t.id, 'cancelled', me, req, null);
    });
    res.json({ ok: true });
  }));

  app.post('/api/repurpose/:id/due', wrap(async (req, res) => {
    const me = await who(req);
    if (!me.canAssign) throw new HttpError(403, 'Only Unilever and Mindshare accounts can change the due date.');
    const due = (req.body || {}).due_date;
    if (!dateOk(due)) throw new HttpError(400, 'Pick a due date.');
    await tx(async (db) => {
      const t = await loadTask(req, me, req.params.id, db);
      if (!['assigned', 'done'].includes(t.status)) throw new HttpError(409, 'This request is already closed.');
      await db.query(`update repurpose_tasks set due_date = $2, updated_at = now() where id = $1`, [t.id, due]);
      await logEvent(db, t.id, 'due_changed', me, req, `${String(t.due_date instanceof Date ? t.due_date.toISOString().slice(0, 10) : t.due_date).slice(0, 10)} to ${due}`);
    });
    res.json({ ok: true });
  }));
};

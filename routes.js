// =====================================================================
//  routes.js — Postgres-backed API for Campaign Lens
//
//  Replaces the Google Sheets endpoints in server.js. Mount with:
//      require('./routes')(app, { ai, youtubedl });
//
//  BRAND SCOPING: Express connects with a role that bypasses RLS, so
//  every data query is scoped in code. Each handler resolves the brand
//  through assertBrandAllowed() before touching data. Adding a new
//  endpoint without that call leaks another client's data.
// =====================================================================
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { query, brandsForUser, assertBrandAllowed } = require('./db');
const { checkLinks } = require('./link-check');
const { checkContent } = require('./content-check');

// Review runs the content check; Confirm needs the same answer a moment later.
// Caching by the normalised links means each link is scraped once per add,
// not twice. Entries expire so a stale answer is never reused for long.
const CONTENT_TTL_MS = 20 * 60 * 1000;
const contentCache = new Map();
async function contentFor(links) {
  const key = JSON.stringify({ ig: links.ig || null, tt: links.tt || null, fb: links.fb || null });
  const hit = contentCache.get(key);
  if (hit && Date.now() - hit.at < CONTENT_TTL_MS) return hit.result;
  const result = await checkContent(links);
  contentCache.set(key, { at: Date.now(), result });
  if (contentCache.size > 500) contentCache.delete(contentCache.keys().next().value);
  return result;
}
// Prompt + response schema live in worker.js so the queue, the regenerate
// endpoint and the upload test page all analyse videos identically.
const { buildPrompt, normaliseTimeline, RESPONSE_SCHEMA } = require('./worker');
// Gemini model. Google retires these on their own schedule — 2.5-flash was
// pulled for new users — so it is an env var, changeable without a deploy.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Max characters of the optional description that get folded into the
// creative_id. Kept short because the id is typed by hand into ad names.
const DESCRIPTION_MAX = 20;


module.exports = function mountRoutes(app, deps = {}) {
  const { ai, youtubedl } = deps;

  // Resolve which brand this request is for: explicit ?brand=, else the
  // session's active brand, else their first allowed brand.
  function resolveBrand(req) {
    const requested = req.query.brand || req.body?.brand_id || req.session.activeBrand;
    const brand = requested || (req.session.brands || [])[0];
    return assertBrandAllowed(req.session, brand);
  }

  // -------------------------------------------------------------------
  //  LOGIN — reads app_users instead of USER_* environment variables
  // -------------------------------------------------------------------
  app.post('/login', async (req, res) => {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    try {
      const { rows } = await query(
        `select password_hash, role from app_users
          where username = $1 and is_active = true`,
        [username]
      );

      // Compare even when the user is missing, so a wrong username and a
      // wrong password take the same time and cannot be told apart.
      const hash = rows.length ? rows[0].password_hash
                               : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
      const ok = await bcrypt.compare(password, hash);
      if (!rows.length || !ok) return res.redirect('/login?error=1');

      const access = await brandsForUser(username);
      if (!access || !access.brands.length) {
        console.warn(`[login] ${username} authenticated but has no brands assigned`);
        return res.redirect('/login?error=2');
      }

      req.session.user = username;
      req.session.brands = access.brands;
      req.session.isInternal = access.isInternal;
      req.session.role = rows[0].role || null;
      req.session.activeBrand = access.brands[0];
      req.session.save(err => {
        if (err) { console.error('[login] session save:', err); return res.redirect('/login?error=1'); }
        res.redirect(req.session.role === 'influencer_coordinator' ? '/coordinator' : '/');
      });
    } catch (err) {
      console.error('[login] failed:', err.message);
      res.redirect('/login?error=1');
    }
  });

  // -------------------------------------------------------------------
  //  Campaigns. Real rows, so a campaign can exist before any creative
  //  uses it and every form can pick from a list instead of free text.
  // -------------------------------------------------------------------
  app.get('/api/campaigns', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      // id is needed so creators can be scoped to a campaign. Legacy campaign
      // names that only exist on creatives come back with a null id and simply
      // have no creators assigned.
      const { rows } = await query(
        `select c.id, c.name from campaigns c
          where c.brand_id = $1 and c.is_active = true
         union
         select null::bigint as id, x.campaign as name
           from (select distinct campaign from creatives
                  where brand_id = $1 and campaign is not null and campaign <> '') x
          where not exists (select 1 from campaigns c2
                             where c2.brand_id = $1 and c2.name = x.campaign)
         order by name`,
        [brand]
      );
      res.json(rows);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/campaigns', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      // Adding campaigns is an internal job, not a coordinator one.
      if (req.session.role === 'influencer_coordinator') {
        return res.status(403).json({ error: 'Not permitted for this role' });
      }
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Campaign name is required.' });
      await query(
        `insert into campaigns (brand_id, name) values ($1,$2)
         on conflict (brand_id, name) do update set is_active = true`,
        [brand, name]
      );
      res.json({ success: true, name });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  Creators
  //  A creator is a real row rather than free text on a creative, so the
  //  same person can be assigned to several campaigns and still roll up to
  //  one set of overall numbers.
  // -------------------------------------------------------------------

  // Creators assigned to a campaign, for the coordinator's picker.
  // Without campaign_id it returns every active creator, which is what the
  // admin list needs.
  app.get('/api/creators', async (req, res) => {
    try {
      resolveBrand(req);            // brand access check
      const campaignId = req.query.campaign_id;
      const params = [];
      let sql = `select c.id, c.name,
                        coalesce(json_agg(json_build_object(
                          'platform', p.platform, 'handle', p.handle, 'url', p.profile_url)
                        ) filter (where p.platform is not null), '[]') as profiles
                   from creators c
                   left join creator_profiles p on p.creator_id = c.id`;
      if (campaignId) {
        params.push(campaignId);
        sql += `\n  join campaign_creators cc on cc.creator_id = c.id and cc.campaign_id = $1`;
      }
      sql += `\n where c.is_active = true
                group by c.id, c.name
                order by c.name`;
      const { rows } = await query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Create or update a creator and their platform profiles.
  app.post('/api/creators', async (req, res) => {
    try {
      resolveBrand(req);
      if (req.session.role === 'influencer_coordinator') {
        return res.status(403).json({ error: 'Not permitted for this role' });
      }
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Creator name is required.' });

      const { rows } = await query(
        `insert into creators (name) values ($1)
         on conflict (lower(name)) do update set is_active = true
         returning id`, [name]);
      const id = rows[0].id;

      // profiles: [{ platform, handle, url }]
      for (const p of (req.body.profiles || [])) {
        if (!p || !['ig','fb','tt','yt','other'].includes(p.platform)) continue;
        await query(
          `insert into creator_profiles (creator_id, platform, handle, profile_url)
           values ($1,$2,$3,$4)
           on conflict (creator_id, platform) do update
             set handle = excluded.handle, profile_url = excluded.profile_url`,
          [id, p.platform, p.handle || null, p.url || null]);
      }
      res.json({ success: true, id, name });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Assign or unassign creators on a campaign.
  app.post('/api/campaign-creators', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      if (req.session.role === 'influencer_coordinator') {
        return res.status(403).json({ error: 'Not permitted for this role' });
      }
      const { campaign_id, creator_ids, remove } = req.body;
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required.' });

      // the campaign must belong to a brand this user can see
      const { rows: own } = await query(
        'select 1 from campaigns where id = $1 and brand_id = $2', [campaign_id, brand]);
      if (!own.length) return res.status(403).json({ error: 'Campaign not found for this brand.' });

      const ids = [].concat(creator_ids || []).filter(Boolean);
      if (!ids.length) return res.status(400).json({ error: 'creator_ids is required.' });

      if (remove) {
        await query(
          'delete from campaign_creators where campaign_id = $1 and creator_id = any($2::bigint[])',
          [campaign_id, ids]);
      } else {
        await query(
          `insert into campaign_creators (campaign_id, creator_id)
           select $1, unnest($2::bigint[])
           on conflict do nothing`, [campaign_id, ids]);
      }
      res.json({ success: true, count: ids.length });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  Which brands can this user see, and which is active
  // -------------------------------------------------------------------
app.get('/api/brands', async (req, res) => {
    try {
      const [b, a] = await Promise.all([
        query(`select brand_id, name from brands
                where brand_id = any($1) and is_active = true order by name`,
              [req.session.brands || []]),
        query(`select agency_id, name from agencies
                where is_active = true order by name`)
      ]);
      const u = await query(
        `select display_name from app_users where username = $1`,
        [req.session.user]
      );
      res.json({
        brands: b.rows,
        active: req.session.activeBrand,
        isInternal: !!req.session.isInternal,
        agencies: a.rows,
        user: { username: req.session.user,
                displayName: u.rows[0]?.display_name || req.session.user,
                role: req.session.role || null }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/switch-brand', (req, res) => {
    try {
      const brand = assertBrandAllowed(req.session, req.body.brand_id);
      req.session.activeBrand = brand;
      req.session.save(() => res.json({ success: true, active: brand }));
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  CAMPAIGN SIGN-OFF — create (client lead only), list (own brands),
  //  approve (media head only). Role lives on app_users.role, set on
  //  the session at login; nothing here trusts anything the client
  //  claims about itself.
  // -------------------------------------------------------------------
  app.post('/api/signoffs', async (req, res) => {
    try {
      // TEMPORARY: open to everyone while roles are still being assigned.
      // Restore this check once real usernames are set via
      // `update app_users set role = 'client_lead' where username = ...`
      // if (req.session.role !== 'client_lead') {
      //   return res.status(403).json({ error: 'Only client leads can create a sign-off.' });
      // }
      const brand = assertBrandAllowed(req.session, req.body.brand_id);
      const m = req.body.meta || {};
      if (!m.campaignName || !String(m.campaignName).trim()) {
        return res.status(400).json({ error: 'Campaign name is required.' });
      }

      const { rows } = await query(
        `insert into sign_offs
           (brand_id, status, campaign_name, market, go_live_date,
            client_lead_name, variant, format, date_prepared, fields, created_by)
         values ($1, 'pending', $2, $3, nullif($4,'')::date, $5, $6, $7,
                 nullif($8,'')::date, $9, $10)
         returning id, status, created_at`,
        [brand, m.campaignName, m.market || null, m.goLive || '',
         m.clientLead || null, m.variant || null, m.format || null,
         m.datePrepared || '', JSON.stringify(req.body.fields || {}), req.session.user]
      );
      res.status(201).json({ success: true, signoff: rows[0] });
    } catch (err) {
      console.error('[signoffs] create failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/signoffs', async (req, res) => {
    try {
      const { rows } = await query(
        `select id, brand_id, status, campaign_name, market, go_live_date,
                client_lead_name, variant, format, date_prepared,
                created_by, created_at, approved_by, approved_at
           from sign_offs
          where brand_id = any($1)
          order by created_at desc`,
        [req.session.brands || []]
      );
      res.json({ signoffs: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/signoffs/:id/approve', async (req, res) => {
    try {
      // TEMPORARY: open to everyone while roles are still being assigned.
      // Restore this check once real usernames are set via
      // `update app_users set role = 'media_head' where username = ...`
      // if (req.session.role !== 'media_head') {
      //   return res.status(403).json({ error: 'Only the media head can approve a sign-off.' });
      // }
      const { rows: existing } = await query(
        `select brand_id, status from sign_offs where id = $1`, [req.params.id]
      );
      if (!existing.length) return res.status(404).json({ error: 'Sign-off not found.' });
      assertBrandAllowed(req.session, existing[0].brand_id);
      if (existing[0].status === 'approved') {
        return res.status(409).json({ error: 'Already approved.' });
      }

      const { rows } = await query(
        `update sign_offs
            set status = 'approved', approved_by = $2, approved_at = now()
          where id = $1
          returning id, status, approved_by, approved_at`,
        [req.params.id, req.session.user]
      );
      res.json({ success: true, signoff: rows[0] });
    } catch (err) {
      console.error('[signoffs] approve failed:', err.message);
      res.status(err.message.startsWith('Access denied') ? 403 : 500)
         .json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  DASHBOARD DATA — same 11-array shape the frontend already parses
  // -------------------------------------------------------------------
  const { buildPayload } = require('./creatives');

  app.get('/api/dashboard-data', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      res.json(await buildPayload(brand));
    } catch (err) {
      console.error('[dashboard-data]', err.message);
      res.status(err.message.startsWith('Access denied') ? 403 : 500)
         .json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  ADD CREATIVE — writes to `creatives`, then Gemini fills the rest
  // -------------------------------------------------------------------
  // Who is adding this, and where their notification should go. Falls back to
  // the username alone when the account has no address on file; the fixed
  // NOTIFY_TO list still receives everything either way.
  async function resolveAdder(req) {
    const username = (req.session && req.session.user) || null;
    if (!username) return { username: null, displayName: null, email: null };
    try {
      const { rows } = await query(
        'select display_name, email from app_users where username = $1', [username]);
      return {
        username,
        displayName: (rows[0] && rows[0].display_name) || username,
        email: (rows[0] && rows[0].email) || null,
      };
    } catch (err) {
      console.error('[add-creative] could not resolve adder:', err.message);
      return { username, displayName: username, email: null };
    }
  }

  // Inline feedback for the add forms. Same rules add-creative enforces, so
  // what the form shows as valid is exactly what the server will accept.
  app.post('/api/check-links', async (req, res) => {
    try {
      const { ig, fb, tt } = req.body || {};
      const result = await checkLinks(app, query, { ig, fb, tt });
      // Only worth comparing videos once every link is individually valid.
      if (result.ok) result.content = await contentFor(result.links);
      return res.json(result);
    } catch (err) {
      console.error('[check-links]', err.message);
      return res.status(500).json({ error: 'Could not check links. Try again.' });
    }
  });

 app.post('/api/add-creative', async (req, res) => {
    const adder = await resolveAdder(req);
    // date is no longer taken from the form. The real post date comes from the
    // platform on first sync; until then the row gets today as a placeholder.
    const { campaign, type, repurposed, originalId, creator, creator_id, description } = req.body;
    const date = null;
    let ig, fb, tt;
    let brand;
    try { brand = resolveBrand(req); }
    catch (err) { return res.status(403).json({ error: err.message }); }

    if (!['Brand Say', 'Others Say'].includes(type)) {
      return res.status(400).json({ error: 'Invalid Type selected.' });
    }
    if (!campaign) return res.status(400).json({ error: 'Campaign is required.' });

    // Links are checked here as well as in the browser. The browser check is
    // a convenience; this is the one that counts, since it cannot be skipped.
    // Every link is normalised, so what gets stored is always parseable by the
    // matchers, and short TikTok links are resolved to carry the video id.
    let normalised;
    try {
      const lc = await checkLinks(app, query, { ig: req.body.ig, fb: req.body.fb, tt: req.body.tt });
      if (!lc.ok) {
        const fieldErrors = {};
        for (const [k, v] of Object.entries(lc.fields)) if (!v.ok) fieldErrors[k] = v.error;
        return res.status(400).json({ error: 'Fix the highlighted links.', fieldErrors });
      }
      normalised = lc.links;
      ig = normalised.ig || null; fb = normalised.fb || null; tt = normalised.tt || null;
    } catch (err) {
      console.error('[add-creative] link check failed:', err.message);
      return res.status(500).json({ error: 'Could not verify the links. Try again.' });
    }

    // Are the links the same video? Duration first, caption second.
    // A clear mismatch is a warning the person must confirm, not a block:
    // creators sometimes post a different edit per platform on purpose.
    const content = await contentFor({ ig, fb, tt });
    if (content.verdict === 'different' && !req.body.content_confirmed) {
      return res.status(409).json({
        error: 'These links look like different videos.',
        contentWarning: content.warning, content });
    }
    // Overriding a mismatch lets the creative in, but it is not treated as
    // proof the links are one video, so it never joins creators.
    const linkVerdict = content.verdict === 'different' ? 'different_confirmed' : content.verdict;

    // The creative_id is typed by hand into ad names after the pipe, so it has
    // to be short and readable. A description gives BRAND_BS_SHANUDRIE0042
    // instead of BRAND_BS_0042; either way the trailing number keeps it unique.
    const typeCode = type === 'Brand Say' ? 'BS' : 'OS';
    const prefix = `${brand.toUpperCase()}_${typeCode}`;

    const slug = String(description || '')
      .toUpperCase()
      .replace(/&/g, 'AND')
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, DESCRIPTION_MAX);

    // Uniqueness has to cover two cases. A row that already exists is the
    // obvious one. The subtle one: the row is not written until the analysis
    // finishes minutes later, so two adds with the same description would
    // both pass a table-only check, and the worker's insert is an upsert —
    // the second would silently overwrite the first. In-flight jobs are
    // therefore checked too.
    const pendingIds = new Set();
    try {
      const q = app.get('mediaQueue');
      if (q && typeof q.getJobs === 'function') {
        const jobs = await q.getJobs(['waiting', 'active', 'delayed', 'paused']);
        for (const j of jobs) {
          const id = j && j.data && j.data.creativeId;
          if (id) pendingIds.add(id);
        }
      }
    } catch (e) {
      console.error('[add-creative] could not read pending job ids:', e.message);
    }

    const isTaken = async (id) => {
      if (pendingIds.has(id)) return true;
      const { rows } = await query('select 1 from creatives where creative_id = $1', [id]);
      return rows.length > 0;
    };

    // Every id ends in a per-brand number, attached with NO separator:
    //   PONDS_BS_SHANUDRIE6SEC0042   or   PONDS_OS_0043
    //
    // Two reasons, both about the paid matchers. They find the creative in an
    // ad name with /[A-Z0-9]+_(?:BS|OS)_[A-Z0-9]+/, and that last part stops at
    // the first underscore. The old clash suffix was _M3K9ZQ, so a clashed id
    // was read back as the ORIGINAL creative and its spend booked against it.
    // No underscore means the matcher always reads the whole id.
    //
    // The number comes from an atomic counter, so uniqueness no longer depends
    // on checking the table first: two people adding the same description at
    // the same moment still get different numbers.
    const nextNumber = async () => {
      const { rows } = await query(
        `insert into creative_id_counters (brand_id, last_n) values ($1, 1)
         on conflict (brand_id) do update
           set last_n = creative_id_counters.last_n + 1
         returning last_n`, [brand]);
      return String(rows[0].last_n).padStart(4, '0');
    };
    const buildId = (n) => `${prefix}_${slug}${n}`;

    let creativeId;
    try {
      creativeId = buildId(await nextNumber());
      // Backstop only. An old id can still collide in rare cases, such as an
      // old description ending in four digits (PROMO2024 vs PROMO + 2024).
      for (let i = 0; i < 6 && await isTaken(creativeId); i++) {
        creativeId = buildId(await nextNumber());
      }
    } catch (err) {
      console.error('[add-creative] could not allocate id:', err.message);
      return res.status(500).json({ error: 'Could not create an id for this creative. Try again.' });
    }

    // Record whether the links were proven to be one video. Creator matching
    // reads this: handles on one creative are only joined as the same person
    // when the verdict is 'same', so a wrong link cannot merge two creators.
    try {
      await query(
        `insert into creative_link_checks (creative_id, verdict, analysed_platform, details)
         values ($1, $2, $3, $4)
         on conflict (creative_id) do update
           set verdict = excluded.verdict, analysed_platform = excluded.analysed_platform,
               details = excluded.details, checked_at = now()`,
        [creativeId, linkVerdict, content.analysed || null, JSON.stringify(content)]);
    } catch (err) {
      // Never block an add over bookkeeping. The creative just will not be
      // used as evidence for joining creators.
      console.error('[add-creative] could not record link check:', err.message);
    }

    const videoLink = ig || tt || fb;
    const queue = app.get('mediaQueue');

    // Nothing is written until the analysis succeeds. The row is created by
    // the worker, so a failed job leaves no half-populated creative behind.
    // The id is returned now regardless, because it goes into the ad name.
    if (videoLink && queue) {
      try {
        const job = await queue.add(
          'process-creative',
          {
            creativeId, brand, campaign, type, date: date || null,
            repurposed: repurposed === 'Yes', originalId: originalId || null,
            ig: ig || null, fb: fb || null, tt: tt || null,
            creator: creator || null,
            creatorId: creator_id || null,
            mediaUrl: videoLink,
            platform: videoLink.includes('instagram.com') ? 'instagram'
                    : videoLink.includes('tiktok.com') ? 'tiktok' : 'facebook',
            // req.session.user is the username string, not an object — the
            // previous .username read here was always undefined, which is why
            // "Added by" never appeared in the notification.
            addedBy: adder.username,
            addedByName: adder.displayName,
            addedByEmail: adder.email,
          },
          // 60s base gives roughly 1, 2 and 4 minute gaps. The previous 15s
          // base retried inside 105 seconds, which was not long enough to ride
          // out a Gemini-side hiccup: all three attempts failed and the same
          // video then processed fine on a manual retry minutes later.
          { attempts: 3, backoff: { type: 'exponential', delay: 60000 },
            removeOnComplete: 100, removeOnFail: 500 }
        );
        // The id is deliberately not returned here. It only becomes real when
        // the row is written, so it is delivered by email after the analysis
        // succeeds — no id floating around for a creative that may never exist.
        return res.status(202).json({
          success: true, queued: true, jobId: job.id,
          message: 'Queued for analysis. The creative ID will be emailed once processing finishes.'
        });
      } catch (err) {
        console.error('[add-creative] enqueue failed:', err.message);
        return res.status(500).json({ error: 'Could not queue the creative. Try again.' });
      }
    }

    // No link, or no queue configured: write the row directly. There is no
    // analysis to wait for in the first case, and no worker in the second.
    try {
      await query(
        `insert into creatives
           (creative_id, brand_id, date, campaign, type, is_repurposed,
            original_creative_id, content_type, ig_link, fb_link, tt_link,
            creator_profile, creator_id)
         values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7,'Video',$8,$9,$10,$11,$12)`,
        [creativeId, brand, date || null, campaign, type, repurposed === 'Yes',
         originalId || null, ig || null, fb || null, tt || null,
         creator || null, creator_id || null]
      );
      return res.json({
        success: true, creativeId, queued: false,
        message: videoLink ? 'Added without analysis (no worker configured).' : 'Added.'
      });
    } catch (err) {
      console.error('[add-creative]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/regenerate-description', async (req, res) => {
    let brand;
    try { brand = resolveBrand(req); }
    catch (err) { return res.status(403).json({ error: err.message }); }

    const { creative_id } = req.body;
    if (!creative_id) return res.status(400).json({ error: 'creative_id is required' });
    if (!ai || !youtubedl) return res.status(503).json({ error: 'Video analysis is not configured on this server.' });

    let videoPath = null, geminiFile = null;
    try {
      const { rows } = await query(
        `select ig_link, fb_link, tt_link from creatives
          where creative_id = $1 and brand_id = $2`,
        [creative_id, brand]
      );
      if (!rows.length) return res.status(404).json({ error: 'Creative not found for this brand' });

      const videoLink = rows[0].ig_link || rows[0].tt_link || rows[0].fb_link;
      if (!videoLink) return res.status(400).json({ error: 'This creative has no video link to analyse.' });

      videoPath = path.join(os.tmpdir(), `regen_${Date.now()}.mp4`);
        await youtubedl(videoLink, {
        output: videoPath,
        format: 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
        mergeOutputFormat: 'mp4',
        noWarnings: true,
        noCheckCertificates: true,
        addHeader: [
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'accept-language:en-US,en;q=0.9'
        ]
      });

      geminiFile = await ai.files.upload({ file: videoPath, mimeType: 'video/mp4' });
      let state = await ai.files.get({ name: geminiFile.name });
      while (state.state === 'PROCESSING') {
        await new Promise(r => setTimeout(r, 3000));
        state = await ai.files.get({ name: geminiFile.name });
      }
      if (state.state === 'FAILED') throw new Error('Gemini processing failed.');

      // Same shape as the worker so a regenerate cannot leave a creative with
      // quartile segments but no timeline.
      const prompt = buildPrompt(rows[0].duration_s || null);

      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [
          { fileData: { fileUri: geminiFile.uri, mimeType: 'video/mp4' } },
          { text: prompt }
        ]}],
        config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 16000 }
      });

      const a = JSON.parse(result.text.replace(/```json|```/g, '').trim());
      const dur = parseFloat(a.duration);
      const safeDur = Number.isFinite(dur) && dur >= 1 && dur <= 600 ? dur : null;

      await query(
        `update creatives
            set content_hook = $2,
                duration_s = coalesce($3, duration_s),
                segments = coalesce($4::jsonb, segments),
                format = coalesce($5, format),
                product_role = coalesce($6, product_role),
                format_note = coalesce($7, format_note)
          where creative_id = $1`,
        [creative_id, a.hook || null, safeDur,
         // coalesce: never wipe an existing timeline if this run returned none.
         (() => { const t = normaliseTimeline(a.timeline); return t.length ? JSON.stringify(t) : null; })(),
         a.format || null, a.product_role || null, a.format_note || null]
      );

      res.json({
        success: true, creativeId: creative_id,
        analysis: { hook: a.hook || null,
                    format: a.format || null,
                    product_role: a.product_role || null,
                    format_note: a.format_note || null,
                    segments: [a.seg1, a.seg2, a.seg3, a.seg4],
                    duration: safeDur },
        usage: a._usage || null
      });
    } catch (err) {
      console.error('[regenerate-description]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (geminiFile) { try { await ai.files.delete({ name: geminiFile.name }); } catch (e) {} }
    }
  });

  // -------------------------------------------------------------------
  //  UPDATE ACTION — writes to `recommendations`
  //  The old endpoint took Sheets A1 ranges. This takes fields.
  // -------------------------------------------------------------------
  app.post('/api/update-action', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      const { creative_id, platform, action_status, actioned_by, action_date, agency } = req.body;

      // Only the admin or a client user (not internal WPP/agency staff) may
      // mark a recommendation actioned and assign it to an agency.
      const isAdmin = req.session.role === 'admin';
      const isClient = !req.session.isInternal;
      if (!isAdmin && !isClient) {
        return res.status(403).json({ error: 'Only the admin or a client user can assign this to an agency.' });
      }

      if (!creative_id) return res.status(400).json({ error: 'creative_id is required' });
      if (!['meta', 'tiktok'].includes(platform)) {
        return res.status(400).json({ error: "platform must be 'meta' or 'tiktok'" });
      }

      // Confirm the creative belongs to a brand this user may touch.
      const { rows } = await query(
        `select 1 from creatives where creative_id = $1 and brand_id = $2`,
        [creative_id, brand]
      );
      if (!rows.length) return res.status(404).json({ error: 'Creative not found for this brand' });

      await query(
        `insert into recommendations
           (creative_id, platform, action_status, actioned_by, action_date, agency, updated_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (creative_id, platform) do update set
           action_status = excluded.action_status,
           actioned_by   = excluded.actioned_by,
           action_date   = excluded.action_date,
           agency        = excluded.agency,
           updated_at    = now()`,
        [creative_id, platform, action_status || null, actioned_by || null,
         action_date || null, agency || null]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('[update-action]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------
  //  OTHERS SAY STATS — manual entry. No sheet to type into any more,
  //  so this is the only way these numbers get in.
  // -------------------------------------------------------------------
  app.get('/api/others-say-pending', async (req, res) => {
    try {
      const brand = resolveBrand(req);
      // Everything the coordinator page needs to show sync state per platform:
      // the numbers, which of them a person typed, and any open sync error so
      // the coordinator can see their own link is broken.
      const { rows } = await query(
        `select c.creative_id, c.campaign, c.creator_profile, c.creator_handle,
                c.ig_handle, c.tt_handle, c.fb_handle,
                c.duration_s, c.ig_link, c.fb_link, c.tt_link,
                c.date, c.posted_at, c.created_at, c.format, c.content_hook,
                c.tracking_mode,
                round(extract(epoch from (now() - c.created_at)) / 3600, 1) as hours_since_upload,
                coalesce((
                  select json_agg(json_build_object(
                    'platform', o.platform, 'views', o.views, 'likes', o.likes,
                    'comments', o.comments, 'shares', o.shares, 'saves', o.saves,
                    'avg_watch_time', o.avg_watch_time, 'reach', o.reach
                  ) order by o.platform)
                  from organic_perf o where o.creative_id = c.creative_id
                ), '[]') as stats,
                coalesce((
                  select json_agg(json_build_object(
                    'platform', e.platform, 'error', e.error,
                    'occurrences', e.occurrences, 'last_seen', e.last_seen))
                  from sync_errors e
                  where e.creative_id = c.creative_id and e.resolved_at is null
                ), '[]') as errors
           from creatives c
          where c.brand_id = $1 and c.type = 'Others Say'
          order by c.created_at desc`,
        [brand]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // -------------------------------------------------------------------
  //  TEMPORARY manual-upload tool. Takes a raw MP4 body, runs it through
  //  the same Gemini Files-API flow as add-creative, and returns the
  //  descriptions without touching the database. Backs upload-test.html.
  //  Session-protected via the global requireAuth (path is under /api/).
  //  Safe to delete this route + the HTML page when no longer needed.
  // -------------------------------------------------------------------
  app.post('/api/describe-upload',
    express.raw({ type: () => true, limit: '200mb' }),
    async (req, res) => {
      if (!ai) return res.status(500).json({ error: 'Gemini is not configured (GEMINI_API_KEY missing).' });
      if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file received.' });

      let videoPath = null, geminiFile = null;
      try {
        videoPath = path.join(os.tmpdir(), `upload_${Date.now()}.mp4`);
        fs.writeFileSync(videoPath, req.body);

        geminiFile = await ai.files.upload({ file: videoPath, mimeType: 'video/mp4' });
        let state = await ai.files.get({ name: geminiFile.name });
        while (state.state === 'PROCESSING') {
          await new Promise(r => setTimeout(r, 3000));
          state = await ai.files.get({ name: geminiFile.name });
        }
        if (state.state === 'FAILED') throw new Error('Gemini processing failed.');

        // Same prompt and schema as the worker, so the test page shows exactly
        // what a real analysis would store, including format classification.
        const prompt = buildPrompt(null);

        const result = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: 'user', parts: [
            { fileData: { fileUri: geminiFile.uri, mimeType: 'video/mp4' } },
            { text: prompt }
          ]}],
          config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 16000 }
        });

        const a = JSON.parse(result.text.replace(/```json|```/g, '').trim());
        // Same accounting as the worker: thinking tokens bill at output rates.
        const u = result.usageMetadata || {};
        const inTok = u.promptTokenCount || 0;
        const outTok = u.candidatesTokenCount || 0;
        const think = u.thoughtsTokenCount || 0;
        const IN_RATE = Number(process.env.GEMINI_IN_RATE || 0.75) / 1e6;
        const OUT_RATE = Number(process.env.GEMINI_OUT_RATE || 3.75) / 1e6;
        const usage = {
          model: GEMINI_MODEL,
          input_tokens: inTok,
          output_tokens: outTok,
          thinking_tokens: think,
          total_tokens: u.totalTokenCount || (inTok + outTok + think),
          cost_usd: Number((inTok * IN_RATE + (outTok + think) * OUT_RATE).toFixed(6)),
        };
        console.log(`[describe-upload] in=${inTok} out=${outTok} thinking=${think} cost=$${usage.cost_usd.toFixed(4)}`);
        res.json({ success: true, analysis: a, usage });
      } catch (err) {
        console.error('[describe-upload]', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
      } finally {
        if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (geminiFile) { try { await ai.files.delete({ name: geminiFile.name }); } catch (e) {} }
      }
    });

  // -------------------------------------------------------------------
  //  Health check. Doubles as the free-tier keep-alive target.
  // -------------------------------------------------------------------
  app.get('/api/health', async (req, res) => {
    try {
      await query('select 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });
};

/**
 * link-check.js — server side of the link rules.
 *
 * Adds the two things the browser cannot do:
 *   1. follow short and share links to where they actually land
 *   2. check the post is not already a creative, including ones still being
 *      analysed in the queue and not yet written to the table
 *
 * The rules themselves live in public/js/links.js so the browser and server
 * can never disagree about what a valid link is.
 */
const L = require('./public/js/links.js');

const FIELDS = ['ig', 'fb', 'tt'];

// A desktop browser UA. TikTok serves its redirect to real browsers and a
// bare request to bots; without this vt.tiktok.com often does not resolve.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function followRedirect(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(8000),
  });
  // Only the final URL matters. Drain nothing and let the socket close.
  try { await res.body?.cancel(); } catch (e) { /* ignore */ }
  return res.url;
}

/**
 * Validate one field, following a short or share link once if needed.
 * Returns { ok, url, id } or { ok:false, error }.
 */
async function checkField(field, raw) {
  const first = L.validate(field, raw);
  if (first.ok || !first.needsResolve) return first;

  let landed;
  try {
    landed = await followRedirect(String(raw).trim());
  } catch (e) {
    return { ok: false, error: `Could not open this ${L.LABEL[field]} link. `
      + 'Open the post in a browser and copy the link from the address bar.' };
  }

  const second = L.validate(field, landed);
  if (second.ok) return second;

  // Meta does not redirect share links for anonymous requests: Facebook
  // answers 400 and stays on the same URL. So a share link that is still a
  // share link after following it will never resolve from a server.
  if (second.needsResolve) {
    return { ok: false, error: `${L.LABEL[field]} share links cannot be read. `
      + 'Open the post, then copy the link from the address bar instead of using Share.' };
  }

  // Meta often sends anonymous requests to a login wall instead of the post.
  // Say so plainly rather than reporting the login page's URL as the problem.
  if (/login|checkpoint|accounts\//i.test(landed)) {
    return { ok: false, error: `${L.LABEL[field]} would not show this post without signing in. `
      + 'Open the post, then copy the link from the address bar.' };
  }
  return { ok: false, error: second.error
    || `This ${L.LABEL[field]} link did not lead to a trackable post.` };
}

/**
 * Find an existing creative already holding this post.
 * Checks the table and, because rows are only written when analysis
 * finishes, jobs still sitting in the queue.
 */
async function findDuplicate(query, field, id, { excludeId, pendingJobs }) {
  let sql, arg;
  if (field === 'ig') {
    sql = `select creative_id, brand_id from creatives
           where (ig_shortcode = $1
                  or ig_link ~ ('instagram\\.com/(reel|reels|p|tv)/' || $1 || '([/?]|$)'))
             and creative_id is distinct from $2
           limit 1`;
  } else if (field === 'tt') {
    sql = `select creative_id, brand_id from creatives
           where (tiktok_item_id = $1 or tt_link ~ ('/video/' || $1 || '([/?]|$)'))
             and creative_id is distinct from $2
           limit 1`;
  } else {
    sql = `select creative_id, brand_id from creatives
           where fb_link ~ ('/' || $1 || '([/?]|$)')
             and creative_id is distinct from $2
           limit 1`;
  }
  arg = [id, excludeId || null];

  const { rows } = await query(sql, arg);
  if (rows.length) return { creativeId: rows[0].creative_id, brand: rows[0].brand_id, pending: false };

  for (const j of pendingJobs || []) {
    const d = j && j.data;
    if (!d || !d[field]) continue;
    const r = L.validate(field, d[field]);
    if (r.ok && r.id === id) return { creativeId: d.creativeId, brand: d.brand, pending: true };
  }
  return null;
}

async function readPendingJobs(app) {
  try {
    const q = app.get('mediaQueue');
    if (q && typeof q.getJobs === 'function') {
      return await q.getJobs(['waiting', 'active', 'delayed', 'paused']);
    }
  } catch (e) {
    console.error('[link-check] could not read pending jobs:', e.message);
  }
  return [];
}

/**
 * Check every supplied field.
 * input: { ig, fb, tt }  (empty or missing = platform not used)
 * returns { ok, fields: { ig: {ok,url,id} | {ok:false,error}, ... }, links: {ig,fb,tt} }
 * links holds the normalised URLs to store, only when ok is true.
 */
async function checkLinks(app, query, input, { excludeId } = {}) {
  const pendingJobs = await readPendingJobs(app);
  const fields = {};
  const links = {};
  const seenIds = {};

  await Promise.all(FIELDS.map(async (f) => {
    const raw = input[f];
    if (!raw || !String(raw).trim()) return;
    fields[f] = await checkField(f, raw);
  }));

  for (const f of FIELDS) {
    const r = fields[f];
    if (!r || !r.ok) continue;

    const dup = await findDuplicate(query, f, r.id, { excludeId, pendingJobs });
    if (dup) {
      fields[f] = { ok: false, error: dup.pending
        ? `This post is already being added as ${dup.creativeId}. Wait for it to finish.`
        : `This post is already in the system as ${dup.creativeId}`
          + (dup.brand ? ` (${dup.brand}).` : '.') };
      continue;
    }
    seenIds[f] = r.id;
    links[f] = r.url;
  }

  const ok = Object.values(fields).every(r => r.ok);
  return { ok, fields, links };
}

module.exports = { checkLinks, checkField };

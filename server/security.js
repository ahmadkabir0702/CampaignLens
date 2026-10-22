// =====================================================================
//  Security controls shared by every route.
//
//    headers()         browser protections on every response
//    sameOrigin()      refuses state-changing requests from other sites
//    Limiter           counts attempts per key over a window (login, password)
//    revalidate()      re-reads each signed-in account once a minute, so a
//                      deactivated account, a changed password or removed
//                      brand access takes effect without waiting for the
//                      person to sign out
//    sendError()       the message a person sees for a failed request:
//                      ours when we refused it, a generic one when it broke
//    cleanName()       validates short names typed by people (campaigns,
//                      creators) before they are stored
//
//  See docs/security.md for what each control is for.
// =====================================================================
const crypto = require('crypto');

const PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// ---------------------------------------------------------------------
//  Headers
//
//  Inline handlers (onclick="...") are used throughout the front end, so
//  scripts still allow 'unsafe-inline'. What the policy does buy: scripts
//  only from this site, requests only over HTTPS, no framing
//  (clickjacking), no plugins, and forms only post here.
// ---------------------------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // Thumbnails and pre-test heatmaps come from platform and vendor CDNs.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  // Pre-test videos go from the browser straight to the scoring service's
  // storage, at an address it hands out per upload, so any HTTPS address
  // is allowed here. Images already load from any HTTPS address, so this
  // opens nothing new for data leaving the page.
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function headers() {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // The browser default: other sites see only our address, never the page.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Signed-in pages and API answers are never kept by shared caches.
    if (req.path.startsWith('/api/') || req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.removeHeader('X-Powered-By');
    next();
  };
}

// ---------------------------------------------------------------------
//  Cross-site request check
//
//  The session cookie is SameSite=Lax, which already stops most cross-site
//  posts. This is the second layer: a browser always sends Origin on a
//  cross-site POST, so one that names another site is refused. Requests
//  with neither Origin nor Referer (n8n, curl) carry no session cookie and
//  are judged by their own token or by the login check.
// ---------------------------------------------------------------------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOrigin({ exempt = () => false } = {}) {
  const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || exempt(req.path)) return next();
    const self = `${req.protocol}://${req.get('host')}`;
    const ok = (o) => o === self || extra.includes(o);
    const origin = req.get('origin');
    if (origin) {
      if (ok(origin)) return next();
      return refuse(req, res);
    }
    const referer = req.get('referer');
    if (referer) {
      let o = null;
      try { o = new URL(referer).origin; } catch (e) { /* unreadable */ }
      if (o && ok(o)) return next();
      return refuse(req, res);
    }
    next();
  };
}

function refuse(req, res) {
  console.warn(`[security] cross-site ${req.method} ${req.path} refused (origin ${req.get('origin') || req.get('referer') || 'none'})`);
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Request refused.' });
  return res.status(403).send('Request refused.');
}

// ---------------------------------------------------------------------
//  Attempt counting
//
//  In memory: one instance runs the app. A restart clears the counts,
//  which only ever makes it more lenient, never locks anyone out.
// ---------------------------------------------------------------------
class Limiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    const t = setInterval(() => this.prune(), Math.min(windowMs, 60000));
    if (t.unref) t.unref();
  }
  recent(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  blocked(key) { return this.recent(key).length >= this.max; }
  /** Seconds until the oldest counted attempt leaves the window. */
  retryAfter(key) {
    const list = this.recent(key);
    if (!list.length) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - Date.now()) / 1000));
  }
  hit(key) { const list = this.recent(key); list.push(Date.now()); this.hits.set(key, list); }
  reset(key) { this.hits.delete(key); }
  prune() { for (const k of [...this.hits.keys()]) this.recent(k); }
}

const MIN = 60 * 1000;
// Most logins are shared by a team, often from one office network, so a
// lock on the login itself would let one person's typos lock out the rest.
// Three counts instead, all of wrong passwords only:
//   one browser on one login   5 in 15 minutes, then that browser waits
//   the login as a whole      20 in 15 minutes: a guessing attack, so the
//                             login waits for everyone
//   one network address       50 in 15 minutes, across all logins
const loginByDevice = new Limiter({ max: 5, windowMs: 15 * MIN });
const loginByUser = new Limiter({ max: 20, windowMs: 15 * MIN });
const loginByIp = new Limiter({ max: 50, windowMs: 15 * MIN });
// Wrong current passwords on the change-password form, per browser.
const pwChangeByUser = new Limiter({ max: 5, windowMs: 15 * MIN });

/** One browser on one login: the username, the address and the browser. */
function deviceKey(req, user) {
  const ua = crypto.createHash('sha1').update(String(req.get('user-agent') || '')).digest('hex').slice(0, 12);
  return `${String(user || '').toLowerCase()}|${req.ip || ''}|${ua}`;
}

// ---------------------------------------------------------------------
//  Session checks
//
//  Brands, role and flags are copied into the session at sign-in. Once a
//  minute they are read again, so:
//    - a deactivated account is signed out
//    - a password changed elsewhere signs out every other session
//      (pwAt below; set at sign-in and when this session changes it)
//    - brand access and section flags follow the database
//  and a session is never older than MAX_SESSION_MS, however active.
// ---------------------------------------------------------------------
const RECHECK_MS = 60 * 1000;
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

function revalidate({ query, brandsForUser, loadFeatures }) {
  return async (req, res, next) => {
    const s = req.session;
    if (!s || !s.user) return next();
    const now = Date.now();
    // Sessions from before this check existed start their clock now.
    if (!s.authAt) s.authAt = now;
    if (now - s.authAt > MAX_SESSION_MS) return end(req, res, 'expired');
    if (s.checkedAt && now - s.checkedAt < RECHECK_MS) return next();
    try {
      const { rows } = await query(
        `select is_active, role, password_changed_at, org from app_users where username = $1`, [s.user]);
      const u = rows[0];
      if (!u || u.is_active !== true) return end(req, res, 'inactive');
      // pwAt is the password's change time when this session signed in (or
      // changed it). A different value means it was changed somewhere else.
      const changed = u.password_changed_at ? new Date(u.password_changed_at).getTime() : 0;
      if (s.pwAt === undefined) s.pwAt = changed;
      else if (changed !== s.pwAt) return end(req, res, 'password changed');
      const access = await brandsForUser(s.user);
      if (!access || !access.brands.length) return end(req, res, 'no brands');
      s.brands = access.brands;
      s.isInternal = access.isInternal;
      if (!s.brands.includes(s.activeBrand)) s.activeBrand = s.brands[0];
      s.role = u.role || null;
      s.org = u.org || null;
      try { s.features = await loadFeatures(s.user); } catch (e) { /* keep the last flags */ }
      s.checkedAt = now;
    } catch (e) {
      // A database hiccup should not sign everyone out. The next request
      // tries again; the stored access stays as it was.
      console.warn('[security] could not re-check session:', e.message);
    }
    next();
  };
}

function end(req, res, why) {
  const user = req.session && req.session.user;
  console.log(`[security] session for ${user} ended: ${why}`);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    res.redirect('/login?error=ended');
  });
}

// ---------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------
function statusOf(err) {
  if (err && err.status) return err.status;
  const m = String((err && err.message) || '');
  if (m.startsWith('Access denied') || m === 'No brand access on session') return 403;
  if (m === 'brand_id is required') return 400;
  return 500;
}

/** Ours (4xx) are shown as written; anything else is logged, not shown. */
function sendError(res, tag, err) {
  const status = statusOf(err);
  if (status >= 500) {
    console.error(`[${tag}]`, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
    // Kept for the admin page too. Loaded here, not at the top, so this
    // file has no database dependency of its own.
    try { require('./ops').logError(tag, err, res.req); } catch (e) { /* never a second error */ }
    return res.status(status).json({ error: 'Something went wrong. Try again.' });
  }
  return res.status(status).json({ error: err.message });
}

// ---------------------------------------------------------------------
//  Names people type
// ---------------------------------------------------------------------
/** Trimmed, single-spaced, no control characters or angle brackets. */
function cleanName(v, { max = 120, label = 'Name' } = {}) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) { const e = new Error(`${label} is required.`); e.status = 400; throw e; }
  if (s.length > max) { const e = new Error(`${label} must be ${max} characters or fewer.`); e.status = 400; throw e; }
  if (/[<>]/.test(s)) { const e = new Error(`${label} cannot contain < or >.`); e.status = 400; throw e; }
  return s;
}

/** Constant-time comparison of two secrets. */
function secretEquals(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  PROD, headers, sameOrigin, Limiter, loginByDevice, loginByUser, loginByIp, pwChangeByUser, deviceKey,
  revalidate, sendError, cleanName, secretEquals, MAX_SESSION_MS,
};

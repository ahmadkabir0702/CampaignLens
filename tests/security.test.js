// Security helpers: names, secrets, attempt limits, the cross-site check
// and what an error shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const SEC = require('../server/security');

test('cleanName trims, collapses spaces and refuses markup', () => {
  assert.equal(SEC.cleanName('  Glow   Week\t2026 '), 'Glow Week 2026');
  assert.throws(() => SEC.cleanName('<img src=x onerror=alert(1)>'), /cannot contain/);
  assert.throws(() => SEC.cleanName('   '), /required/);
  assert.throws(() => SEC.cleanName('x'.repeat(121)), /120 characters/);
  assert.equal(SEC.cleanName('Line\nbreak'), 'Line break');
});

test('secretEquals needs the exact secret', () => {
  assert.equal(SEC.secretEquals('abc123', 'abc123'), true);
  assert.equal(SEC.secretEquals('abc124', 'abc123'), false);
  assert.equal(SEC.secretEquals('abc', 'abc123'), false);
  assert.equal(SEC.secretEquals('', ''), false, 'an unset secret never matches');
  assert.equal(SEC.secretEquals(undefined, undefined), false);
});

test('Limiter blocks at the limit and clears on reset', () => {
  const L = new SEC.Limiter({ max: 3, windowMs: 60000 });
  for (let i = 0; i < 2; i++) L.hit('k');
  assert.equal(L.blocked('k'), false);
  L.hit('k');
  assert.equal(L.blocked('k'), true);
  assert.ok(L.retryAfter('k') > 0);
  assert.equal(L.blocked('other'), false, 'keys are separate');
  L.reset('k');
  assert.equal(L.blocked('k'), false);
});

test('deviceKey separates browsers on one login', () => {
  const req = (ua, ip = '1.2.3.4') => ({ ip, get: (h) => (h === 'user-agent' ? ua : undefined) });
  assert.notEqual(SEC.deviceKey(req('A'), 'ul.lux'), SEC.deviceKey(req('B'), 'ul.lux'));
  assert.equal(SEC.deviceKey(req('A'), 'UL.LUX'), SEC.deviceKey(req('A'), 'ul.lux'));
});

function run(mw, { method = 'POST', path = '/api/campaigns', origin, referer, host = 'lens.example' } = {}) {
  const headers = { origin, referer, host };
  const req = { method, path, protocol: 'https', get: (h) => headers[h.toLowerCase()] };
  const out = { next: false, status: null };
  const res = { status(s) { out.status = s; return this; }, json() { return this; }, send() { return this; } };
  mw(req, res, () => { out.next = true; });
  return out;
}

test('sameOrigin refuses posts from other sites and allows our own', () => {
  const mw = SEC.sameOrigin({ exempt: (p) => p === '/api/sov/runs' });
  assert.equal(run(mw, { origin: 'https://lens.example' }).next, true);
  assert.equal(run(mw, { origin: 'https://evil.example' }).status, 403);
  assert.equal(run(mw, { referer: 'https://evil.example/page' }).status, 403);
  assert.equal(run(mw, { referer: 'https://lens.example/page' }).next, true);
  assert.equal(run(mw, {}).next, true, 'no Origin or Referer: not a browser, judged by its token');
  assert.equal(run(mw, { method: 'GET', origin: 'https://evil.example' }).next, true, 'reads are not refused');
  assert.equal(run(mw, { path: '/api/sov/runs', origin: 'https://evil.example' }).next, true, 'token routes are exempt');
});

test('sendError shows our refusals and hides faults', () => {
  const res = () => ({ code: null, body: null, req: null,
    status(s) { this.code = s; return this; }, json(b) { this.body = b; return this; } });
  const denied = Object.assign(new Error('Access denied for this brand.'), { status: 403 });
  const r1 = res(); SEC.sendError(r1, 't', denied);
  assert.equal(r1.code, 403); assert.equal(r1.body.error, 'Access denied for this brand.');

  const orig = console.error; console.error = () => {};
  const r2 = res(); SEC.sendError(r2, 't', new Error('relation "secret_table" does not exist'));
  console.error = orig;
  assert.equal(r2.code, 500);
  assert.doesNotMatch(r2.body.error, /secret_table/);
});

test('the content policy lets pre-test videos upload to the scoring service', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; }, removeHeader() {} };
  SEC.headers()({ path: '/', secure: true }, res, () => {});
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /connect-src 'self' https:/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/, 'scripts still only from this site');
  assert.match(csp, /frame-ancestors 'none'/);
});

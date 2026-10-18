/**
 * Pre-testing API client (Brainsuite ACE Social Media Video).
 *
 * Users never see the vendor's name: every message an error can carry to
 * the screen says "the scoring service" instead. Env vars, table names and
 * this module keep the vendor name, because nobody sees them.
 *
 * Two apps, picked by the placement being tested:
 *   Meta & TikTok  ACE_VIDEO_SMV_PRO_UNILEVER_V2  (tiktok, facebook_*, instagram_*)
 *   YouTube        ACE_VIDEO_SMV_PRO_UNILEVER     (youtube, youtube_shorts)
 *
 * The only file that holds the client secret or talks to Brainsuite. The
 * browser never sees either; it only ever receives the one-file upload form
 * for its own pre-test.
 *
 * Flow (proven end to end with the Lux test, job fd048113, 12 Oct 2026):
 *   token -> announce job -> announce asset (upload form, valid 5 min)
 *   -> upload file to S3 (204) -> start job (uses one test of quota)
 *   -> poll GET job until Succeeded / Failed / Stale (Lux took ~5 min).
 *
 * Needs on the service:
 *   BRAINSUITE_CLIENT_ID, BRAINSUITE_CLIENT_SECRET
 * Optional:
 *   BRAINSUITE_TOOL_VARIANT          default ACE_VIDEO_SMV_PRO_UNILEVER_V2 (Meta & TikTok)
 *   BRAINSUITE_YOUTUBE_TOOL_VARIANT  default ACE_VIDEO_SMV_PRO_UNILEVER   (YouTube)
 *   BRAINSUITE_API_BASE      default https://api.brainsuite.ai
 *   BRAINSUITE_AUTH_URL      default https://auth.brainsuite.ai/oauth2/token
 */
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const API_BASE = (process.env.BRAINSUITE_API_BASE || 'https://api.brainsuite.ai').replace(/\/+$/, '');
const AUTH_URL = process.env.BRAINSUITE_AUTH_URL || 'https://auth.brainsuite.ai/oauth2/token';
const VARIANT = process.env.BRAINSUITE_TOOL_VARIANT || 'ACE_VIDEO_SMV_PRO_UNILEVER_V2';
const YOUTUBE_VARIANT = process.env.BRAINSUITE_YOUTUBE_TOOL_VARIANT || 'ACE_VIDEO_SMV_PRO_UNILEVER';

function isYouTube(channel) {
  return channel === 'youtube' || channel === 'youtube_shorts';
}

// The API path for the app that scores this placement.
function appPath(channel) {
  return `/v1/jobs/ACE_VIDEO/${isYouTube(channel) ? YOUTUBE_VARIANT : VARIANT}`;
}

// The asset id we announce. One asset per job, so a fixed name is enough,
// and re-announcing the same id is how Brainsuite hands out a fresh upload form.
const ASSET_ID = 'video';

function configured() {
  return !!(process.env.BRAINSUITE_CLIENT_ID && process.env.BRAINSUITE_CLIENT_SECRET);
}

class BrainsuiteError extends Error {
  constructor(message, { status = null, body = null, retryAt = null, detail = null } = {}) {
    super(message);
    this.name = 'BrainsuiteError';
    this.status = status;
    this.body = body;
    this.retryAt = retryAt;   // Date, set on 429
    this.detail = detail;     // Brainsuite's own words, fit to show a user
  }
}

// ── Token ────────────────────────────────────────────────────────────────────
// Tokens last 24 hours. One is kept per process and refreshed an hour early,
// so the web routes and the in-process worker share it.
let token = null;
let tokenExpires = 0;
let tokenPending = null;

async function fetchToken() {
  if (!configured()) throw new BrainsuiteError('Pre-testing is not connected on this server (BRAINSUITE_CLIENT_ID / BRAINSUITE_CLIENT_SECRET).');
  const basic = Buffer.from(
    `${process.env.BRAINSUITE_CLIENT_ID}:${process.env.BRAINSUITE_CLIENT_SECRET}`, 'latin1'
  ).toString('base64');
  try {
    const res = await axios.post(AUTH_URL, 'grant_type=client_credentials', {
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    });
    const ttl = Number(res.data.expires_in || 86400);
    token = res.data.access_token;
    tokenExpires = Date.now() + Math.max(60, ttl - 3600) * 1000;
    return token;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    throw new BrainsuiteError(`Could not sign in to the scoring service${status ? ` (HTTP ${status})` : ''}`, {
      status, body: err.response ? err.response.data : null,
    });
  }
}

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExpires) return token;
  if (!tokenPending) tokenPending = fetchToken().finally(() => { tokenPending = null; });
  return tokenPending;
}

// ── Requests ─────────────────────────────────────────────────────────────────
function describe(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 300);
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail.map(d => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ').slice(0, 300);
  }
  if (data.message) return String(data.message);
  return JSON.stringify(data).slice(0, 300);
}

async function call(method, path, body, { retried = false } = {}) {
  const t = await getToken();
  try {
    const res = await axios({
      method, url: API_BASE + path,
      headers: { Authorization: `Bearer ${t}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      data: body,
      timeout: 60000,
      maxContentLength: 50 * 1024 * 1024,
    });
    return res.data;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const data = err.response ? err.response.data : null;
    // A token can be revoked or rotated before it expires. Fetch a new one once.
    if (status === 401 && !retried) {
      await getToken(true);
      return call(method, path, body, { retried: true });
    }
    if (status === 429) {
      const h = err.response.headers || {};
      const reset = h['x-ratelimit-reset'] ? new Date(h['x-ratelimit-reset']) : null;
      const retryAt = reset && !isNaN(reset) ? reset : new Date(Date.now() + 60000);
      throw new BrainsuiteError('The scoring service is busy. Trying again shortly.', { status, body: data, retryAt });
    }
    throw new BrainsuiteError(
      `The scoring service did not respond as expected${status ? ` (HTTP ${status})` : ''}: ${describe(data) || err.message}`,
      { status, body: data, detail: describe(data) || null }
    );
  }
}

// ── The job lifecycle ────────────────────────────────────────────────────────
async function announceJob(channel) {
  const job = await call('post', `${appPath(channel)}/announce`);
  if (!job || !job.id) throw new BrainsuiteError('The scoring service did not return a test id.');
  return job;
}

// Returns { assetId, name, uploadUrl, fields }. Valid for 5 minutes; call
// again with the same job to get a fresh one.
async function announceAsset(channel, bsJobId, fileName) {
  const a = await call('post', `${appPath(channel)}/${bsJobId}/assets`, { assetId: ASSET_ID, name: fileName });
  if (!a || !a.uploadUrl || !a.fields) throw new BrainsuiteError('The scoring service did not return an upload form.');
  return a;
}

// Streams a file from disk to the S3 form. Fields first, file last: S3
// ignores anything after the file part.
async function uploadFile(asset, filePath, fileName) {
  const form = new FormData();
  for (const [k, v] of Object.entries(asset.fields)) form.append(k, String(v));
  const size = fs.statSync(filePath).size;
  form.append('file', fs.createReadStream(filePath), { filename: fileName, knownLength: size });
  try {
    const res = await axios.post(asset.uploadUrl, form, {
      headers: form.getHeaders({ 'Content-Length': form.getLengthSync() }),
      maxBodyLength: Infinity, maxContentLength: Infinity,
      timeout: 30 * 60 * 1000,
      validateStatus: s => s >= 200 && s < 300,
    });
    return res.status;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    throw new BrainsuiteError(`The video upload failed${status ? ` (HTTP ${status})` : ''}: ${describe(err.response && err.response.data) || err.message}`, { status });
  }
}

// Uses one test of quota.
async function startJob(channel, bsJobId, input) {
  return call('post', `${appPath(channel)}/${bsJobId}/start`, { input });
}

async function getJob(channel, bsJobId) {
  return call('get', `${appPath(channel)}/${bsJobId}`);
}

module.exports = {
  configured, getToken, announceJob, announceAsset, uploadFile, startJob, getJob,
  BrainsuiteError, ASSET_ID, VARIANT, YOUTUBE_VARIANT, isYouTube,
};

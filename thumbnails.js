/**
 * thumbnails.js — keep a permanent copy of each creative's thumbnail.
 *
 * The thumbnail link a platform returns is signed and dies within hours, so
 * storing the link is useless. Instead the image is downloaded once at add
 * time and put in Supabase Storage, which gives a stable public URL.
 *
 * Needs two environment variables on the service that runs the worker:
 *   SUPABASE_URL               e.g. https://abcdefgh.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  Settings > API Keys > Secret keys (sb_secret_...),
 *                              or the legacy service_role key. Never the
 *                              publishable or anon key.
 * and a public bucket called "thumbnails" (created by the migration).
 *
 * Failure here must never fail the creative: a missing thumbnail is a
 * cosmetic gap, a failed add is not. Every path returns null on error.
 */
const axios = require('axios');
const path = require('path');

const BUCKET = 'thumbnails';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;

function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Supabase shows the Data API endpoint as https://xxx.supabase.co/rest/v1,
// which is easy to paste in by mistake. Storage lives elsewhere on the same
// host, so trim any path back to the project root.
function baseUrl() {
  const raw = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return raw.replace(/\/(rest|storage|auth|realtime)\/v\d.*$/, '');
  }
}

// Only what the file's own bytes say it is. Platforms return .heic links that
// are really JPEG, and vice versa, so the extension in the URL is not trusted.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.length > 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') return { ext: 'heic', mime: 'image/heic' };
  return null;
}

async function download(url) {
  try {
    const res = await axios({
      url, method: 'GET', responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5,
      maxContentLength: MAX_BYTES, headers: { 'user-agent': UA },
    });
    return Buffer.from(res.data);
  } catch (e) {
    const code = e.response && e.response.status;
    throw new Error(`download from the platform failed${code ? ` (HTTP ${code})` : ''}: ${e.message}`);
  }
}

async function upload(objectPath, buf, mime) {
  const base = baseUrl();
  // upsert so re-analysing a creative replaces its thumbnail rather than failing
  const target = `${base}/storage/v1/object/${BUCKET}/${objectPath}`;
  try {
  await axios({
    url: target,
    method: 'POST', data: buf, timeout: 30000,
    headers: {
      // Both headers, so this works with the new sb_secret_ keys and the
      // legacy service_role JWT alike.
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime,
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000',
    },
    maxBodyLength: MAX_BYTES,
  });
  } catch (e) {
    const code = e.response && e.response.status;
    const body = e.response && e.response.data;
    const detail = body && (body.message || body.error) ? ` ${body.message || body.error}` : '';
    if (code === 404) {
      throw new Error(`upload to Supabase failed (404). The "${BUCKET}" bucket does not exist, `
        + `or SUPABASE_URL is wrong. URL used: ${target}`);
    }
    if (code === 400 || code === 401 || code === 403) {
      throw new Error(`upload to Supabase rejected (HTTP ${code}).${detail} `
        + 'Check SUPABASE_SERVICE_ROLE_KEY is the secret key, not the publishable one.');
    }
    throw new Error(`upload to Supabase failed${code ? ` (HTTP ${code})` : ''}: ${e.message}${detail}`);
  }
  return `${base}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/**
 * Download the platform's thumbnail and store it. Returns the permanent
 * public URL, or null if anything goes wrong.
 */
async function storeThumbnail(creativeId, sourceUrl) {
  if (!sourceUrl) return null;
  if (!configured()) {
    console.warn('[thumbnails] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; thumbnail not stored');
    return null;
  }
  try {
    const buf = await download(sourceUrl);
    const kind = sniff(buf);
    if (!kind) { console.warn(`[thumbnails] ${creativeId}: not an image, skipped`); return null; }
    // HEIC does not display in browsers. Keep it only if nothing else is possible.
    const safeId = String(creativeId).replace(/[^A-Za-z0-9_-]/g, '_');
    const objectPath = `${safeId}.${kind.ext}`;
    const publicUrl = await upload(objectPath, buf, kind.mime);
    // Cache-bust so a replaced thumbnail shows immediately in the Hub.
    return `${publicUrl}?v=${Date.now()}`;
  } catch (e) {
    console.error(`[thumbnails] ${creativeId}: ${e.message}`);
    return null;
  }
}

module.exports = { storeThumbnail, configured, _sniff: sniff };

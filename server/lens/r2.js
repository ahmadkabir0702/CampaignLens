/**
 * Temporary storage for pre-test videos (Cloudflare R2, S3 compatible).
 *
 * The browser uploads the video once, straight to a private bucket, using a
 * link that only this server can make. The worker then fetches it, sends it
 * to the scoring service, runs Gemini and the sound checks, and deletes it.
 * Nothing in the bucket is public and nothing is meant to stay: a lifecycle
 * rule on the bucket deletes anything older than a day as a backstop.
 *
 * Needs on the service (all four, or pre-tests keep the old direct upload):
 *   R2_ACCOUNT_ID         Cloudflare account id
 *   R2_ACCESS_KEY_ID      an R2 API token's access key, scoped to this bucket only
 *   R2_SECRET_ACCESS_KEY  and its secret
 *   R2_BUCKET             e.g. campaignlens-pretests
 *
 * Security:
 *   - Object names are random and made here, never taken from the user.
 *   - An upload link works for one object, one content type and one exact
 *     size, and expires after UPLOAD_TTL_S.
 *   - The browser never sees a key. The token can reach this bucket only.
 */
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const UPLOAD_TTL_S = 15 * 60;
const MAX_BYTES = 500 * 1024 * 1024;
const TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' };

let client = null;

function configured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

function s3() {
  if (client) return client;
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}

const bucket = () => process.env.R2_BUCKET;

// The file's extension decides its type; anything else is refused.
function typeFor(fileName) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  return TYPES[ext] ? { ext, type: TYPES[ext] } : null;
}

/** A random object name for one pre-test. */
function newKey(ext) {
  return `pretests/${crypto.randomUUID()}.${ext}`;
}

/**
 * A short-lived link the browser PUTs the file to. The size and type are
 * part of the signature, so the link cannot be used for a bigger or
 * different file.
 */
async function uploadLink(key, contentType, bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) throw new Error('Videos must be 500 MB or smaller.');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: bytes });
  const url = await getSignedUrl(s3(), cmd, {
    expiresIn: UPLOAD_TTL_S,
    // Signed, so the browser must send exactly these.
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return { method: 'PUT', url, headers: { 'Content-Type': contentType }, expiresIn: UPLOAD_TTL_S };
}

/** Size of an uploaded object, or null if it is not there. */
async function head(key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { bytes: Number(r.ContentLength || 0), type: r.ContentType || null };
  } catch (e) {
    if (e && (e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
    throw e;
  }
}

/** Streams an object to a local file. Refuses anything over the limit. */
async function download(key, destPath) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (Number(r.ContentLength || 0) > MAX_BYTES) throw new Error('The uploaded file is over 500 MB.');
  await pipeline(r.Body, fs.createWriteStream(destPath));
  return destPath;
}

async function remove(key) {
  if (!key) return;
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

module.exports = { configured, typeFor, newKey, uploadLink, head, download, remove, MAX_BYTES, UPLOAD_TTL_S };

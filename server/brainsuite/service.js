/**
 * Brainsuite in Campaign Lens: pre-tests and background creative scoring.
 *
 * Quota rule: a test is only ever started by a person (a pre-test) or by a
 * new creative being added. Nothing here starts a test again on its own. A
 * started job is only ever polled.
 *
 * Settings (env, changeable without a deploy):
 *   PRETEST_TTL_HOURS            how long a pre-test report lasts (default 72)
 *   BS_DAILY_CAP                 tests started per day, both kinds (default 40)
 *   BS_PRETEST_MONTHLY_PER_USER  pre-tests per person per month (default 20)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const client = require('./client');
const store = require('./store');
const { summarise, mediaFrom } = require('./summary');
const { buildBriefing, channelForPlatform, CHANNELS } = require('./briefing');
const { enqueue, getConnection } = require('./queue');
const { query } = require('../../db');

const TTL_HOURS = Number(process.env.PRETEST_TTL_HOURS || 72);
const DAILY_CAP = Number(process.env.BS_DAILY_CAP || 40);
const MONTHLY_PER_USER = Number(process.env.BS_PRETEST_MONTHLY_PER_USER || 20);

// Lux: Scheduled for ~1 minute, Created for ~3.5, done at 5. First look at
// 90 seconds, then every 45 seconds for an hour, then every 5 minutes, and
// give up after a day.
const FIRST_POLL_MS = Number(process.env.BS_FIRST_POLL_MS || 90 * 1000);
const POLL_MS = Number(process.env.BS_POLL_MS || 45 * 1000);
const SLOW_POLL_MS = 5 * 60 * 1000;
const SLOW_AFTER_MS = 60 * 60 * 1000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A start that Brainsuite clearly refused (bad briefing, no file). Anything
// else (a timeout, a 5xx, a dropped connection) may have started the test,
// so it is treated as started and polled: polling shows what really happened,
// and a test is never started twice.
function refused(e) {
  return !!(e && e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
}

// Each poll is its own job with a unique id, retried a few times if the
// check itself errors (a database or Redis blip), so a chain does not die.
function queuePoll(rowId, delay) {
  return enqueue('poll', { rowId }, {
    delay, jobId: `poll-${rowId}-${Date.now()}`,
    attempts: 5, backoff: { type: 'exponential', delay: 30 * 1000 },
  });
}

// ── Quota ────────────────────────────────────────────────────────────────────
async function checkQuota({ kind, username }) {
  const today = await store.startedToday();
  if (today >= DAILY_CAP) {
    throw new HttpError(429, `Today's Brainsuite limit of ${DAILY_CAP} tests has been reached. Try again tomorrow.`);
  }
  if (kind === 'pretest' && username) {
    const mine = await store.pretestsThisMonth(username);
    if (mine >= MONTHLY_PER_USER) {
      throw new HttpError(429, `You have used your ${MONTHLY_PER_USER} pre-tests for this month.`);
    }
  }
}

function safeFileName(name) {
  const base = String(name || 'video.mp4').split(/[\\/]/).pop();
  const ext = (base.match(/\.(mp4|mov|m4v|webm|avi)$/i) || ['.mp4'])[0].toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return `${stem || 'video'}${ext}`;
}

// ── Brainsuite status -> ours ─────────────────────────────────────────────────
function statusFor(bsStatus) {
  if (bsStatus === 'Succeeded') return 'succeeded';
  if (bsStatus === 'Failed' || bsStatus === 'Stale') return 'failed';
  if (bsStatus === 'Created' || bsStatus === 'Started') return 'analysing';
  return 'queued';
}

// ── Pre-tests ────────────────────────────────────────────────────────────────
/**
 * Step 1 of 3. Checks everything that could stop the test BEFORE anything is
 * uploaded, then announces the job and hands the browser a one-file upload
 * form. The video goes from the browser straight to Brainsuite.
 */
async function createPretest({ brandId, username, fields }) {
  if (!client.configured()) throw new HttpError(503, 'Brainsuite is not connected on this server yet.');
  const brand = await store.brandInfo(brandId);
  if (!brand) throw new HttpError(404, 'Brand not found.');

  const fileBytes = Number(fields.file_size || 0);
  if (!fields.file_name) throw new HttpError(400, 'Choose a video file.');
  if (fileBytes > 500 * 1024 * 1024) throw new HttpError(400, 'Videos must be 500 MB or smaller.');
  const assetName = String(fields.asset_name || '').trim();
  if (!assetName) throw new HttpError(400, 'Give the asset a name.');

  let briefing;
  try {
    briefing = buildBriefing({
      channel: fields.channel,
      projectName: [fields.campaign, assetName].filter(Boolean).join(' · '),
      assetName,
      brandName: brand.name,
      businessGroup: fields.business_group || brand.bs_business_group,
      category: fields.category || brand.bs_category,
      contentType: fields.content_type,
      language: fields.language || brand.bs_language,
      keyMessage: fields.key_message,
    });
  } catch (e) { throw new HttpError(400, e.message); }

  await checkQuota({ kind: 'pretest', username });

  const fileName = safeFileName(fields.file_name);
  const bsJob = await client.announceJob();
  const asset = await client.announceAsset(bsJob.id, fileName);
  const row = await store.insertJob({
    bsJobId: bsJob.id, kind: 'pretest', brandId, requestedBy: username, status: 'uploading',
    channel: briefing.channel, briefing, assetName, fileName, fileBytes: fileBytes || null,
  });
  return { row, upload: { url: asset.uploadUrl, fields: asset.fields } };
}

// The upload form is only valid for 5 minutes. Re-announcing the same asset
// returns a fresh one.
async function freshUpload(row) {
  if (row.status !== 'uploading') throw new HttpError(409, 'This pre-test is no longer waiting for its upload.');
  const asset = await client.announceAsset(row.bs_job_id, row.file_name);
  return { url: asset.uploadUrl, fields: asset.fields };
}

// Step 3 of 3, after the browser's upload succeeded. Uses one test of quota.
async function startPretest(row) {
  if (row.status !== 'uploading') throw new HttpError(409, 'This pre-test has already been started.');
  await checkQuota({ kind: 'pretest', username: row.requested_by });
  // Claim it first, so a double click or a retried request cannot start it twice.
  const claimed = await store.claimForStart(row.id);
  if (!claimed) throw new HttpError(409, 'This pre-test has already been started.');
  try {
    await client.startJob(row.bs_job_id, row.briefing);
  } catch (e) {
    if (refused(e)) {
      // 422 = Brainsuite did not like the briefing or never got the file.
      const why = (e.detail || e.message).slice(0, 300);
      await store.updateJob(row.id, { status: 'failed', started_at: null, error: `Brainsuite could not start the test: ${why}` });
      throw new HttpError(502, `Brainsuite could not start the test: ${why}`);
    }
    console.error(`[brainsuite] start ${row.id} unclear, polling to find out: ${e.message}`);
  }
  // If this enqueue fails, the hourly sweep restarts polling.
  await queuePoll(row.id, FIRST_POLL_MS).catch(e => console.error(`[brainsuite] poll not queued for ${row.id}: ${e.message}`));
  return claimed;
}

// The person who ran it, or an internal user, can end it early.
async function removePretest(row) {
  if (row.status === 'uploading') {
    return store.updateJob(row.id, { status: 'failed', error: 'Cancelled before the upload finished' });
  }
  await store.deleteResult(row.id);
  return store.updateJob(row.id, { status: 'expired', expires_at: new Date() });
}

// ── Polling ──────────────────────────────────────────────────────────────────
/** Checks one test once. Returns the delay before the next check, or null. */
async function pollOnce(rowId) {
  const row = await store.getJob(rowId);
  if (!row || !row.bs_job_id) return null;
  if (!['queued', 'analysing'].includes(row.status)) return null;

  const age = Date.now() - new Date(row.started_at || row.created_at).getTime();
  await store.bumpPoll(rowId);
  const fail = error => store.updateIfRunning(rowId, { status: 'failed', completed_at: new Date(), error: String(error).slice(0, 500) });

  let result;
  try {
    result = await client.getJob(row.bs_job_id);
  } catch (e) {
    if (e.status === 429 && e.retryAt) return Math.max(5000, e.retryAt.getTime() - Date.now());
    if (e.status === 404) { await fail('Brainsuite no longer has this test'); return null; }
    console.error(`[brainsuite] poll ${rowId}: ${e.message}`);
    if (age > GIVE_UP_MS) { await fail('Timed out waiting for Brainsuite'); return null; }
    return 2 * 60 * 1000;
  }

  // A start that timed out on our side but never reached Brainsuite leaves
  // the job Announced. It will not start on its own, and it used no quota.
  if (result.status === 'Announced' && age > 10 * 60 * 1000) {
    await fail('Brainsuite did not start the test. Run it again.');
    return null;
  }

  const status = statusFor(result.status);
  if (status === 'succeeded') {
    let summary;
    try { summary = summarise(result, row.channel); } catch (e) {
      await fail(`Could not read the Brainsuite result: ${e.message}`);
      return null;
    }
    const expiresAt = row.kind === 'pretest' ? new Date(Date.now() + TTL_HOURS * 3600 * 1000) : null;
    const saved = await store.completeWithResult(rowId, summary, result.weblink || null, expiresAt);
    if (saved) {
      // Images in the result are fresh right now; prime the cache for whoever opens it first.
      cacheMedia(row.bs_job_id, mediaFrom(result)).catch(() => {});
      console.log(`[brainsuite] ${row.kind} ${rowId} scored ${summary.total.score} (${summary.total.rating})`);
    }
    return null;
  }
  if (status === 'failed') {
    await fail(result.error || `Brainsuite marked the test ${result.status}`);
    return null;
  }
  if (row.status !== status) await store.updateIfRunning(rowId, { status });
  if (age > GIVE_UP_MS) { await fail('Timed out waiting for Brainsuite'); return null; }
  return age > SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS;
}

// ── Media on demand ──────────────────────────────────────────────────────────
// Brainsuite's links last an hour. Cached for 50 minutes, so a report opened
// ten times in that hour asks Brainsuite once.
const MEDIA_TTL_S = 50 * 60;

async function cacheMedia(bsJobId, media) {
  const r = getConnection();
  if (r) await r.set(`bs:media:${bsJobId}`, JSON.stringify(media), 'EX', MEDIA_TTL_S);
}

async function mediaFor(row) {
  const r = getConnection();
  if (r) {
    const hit = await r.get(`bs:media:${row.bs_job_id}`);
    if (hit) return JSON.parse(hit);
  }
  let result;
  try {
    result = await client.getJob(row.bs_job_id);
  } catch (e) {
    if (e.status === 404) return { montage: null, stills: [], heatmovie: null, gone: true };
    throw e;
  }
  const media = mediaFrom(result);
  await cacheMedia(row.bs_job_id, media);
  return media;
}

// ── Creatives ────────────────────────────────────────────────────────────────
function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function tomorrowAt1am() {
  // 01:00 Asia/Colombo (UTC+5:30) tomorrow.
  const now = new Date();
  const colombo = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const next = Date.UTC(colombo.getUTCFullYear(), colombo.getUTCMonth(), colombo.getUTCDate() + 1, 1, 0) - 5.5 * 3600 * 1000;
  return Math.max(60 * 1000, next - now.getTime());
}

/**
 * Score a creative from a video already on disk. Called by the creative
 * worker with the file it downloaded for Gemini, so nothing is downloaded
 * twice. Never throws: a Brainsuite problem must not fail the creative.
 */
async function scoreCreative({ creativeId, brandId, type, platform, campaign, filePath, attempt = 0 }) {
  try {
    if (!client.configured() || !getConnection()) return { skipped: 'not configured' };
    const brand = await store.brandInfo(brandId);
    if (!brand || !brand.bs_auto_score) return { skipped: 'brand not switched on' };

    const existing = await store.activeForCreative(creativeId);
    if (existing) return { skipped: 'already scored or running', id: existing.id };

    const channel = channelForPlatform(platform);
    const fileName = safeFileName(path.basename(filePath));
    const fileBytes = fs.statSync(filePath).size;
    const fileSha = await sha256(filePath);
    const base = { kind: 'creative', creativeId, brandId, channel, fileName, fileBytes, fileSha256: fileSha };

    let briefing;
    try {
      briefing = buildBriefing({
        channel, projectName: campaign, assetName: creativeId, brandName: brand.name,
        businessGroup: brand.bs_business_group, category: brand.bs_category,
        contentType: type, language: brand.bs_language,
      });
    } catch (e) {
      await store.insertJob({ ...base, status: 'skipped', error: e.message });
      return { skipped: e.message };
    }

    // The same file was scored before for this brand, placement and content
    // origin (a re-add, or a variant that is byte for byte the original):
    // reuse it, no quota.
    const same = await store.findByHash(fileSha, { brandId, channel, contentOrigin: briefing.contentOrigin });
    if (same) {
      const row = await store.insertJob({
        ...base, status: 'succeeded', briefing, reusedFrom: same.id,
        bsJobId: null, startedAt: null, completedAt: new Date(),
      });
      await store.saveResult(row.id, same.summary, same.weblink);
      return { reused: same.id, id: row.id };
    }

    try { await checkQuota({ kind: 'creative' }); } catch (e) {
      await store.insertJob({ ...base, briefing, status: 'skipped', error: 'Daily Brainsuite limit reached. Will try again tomorrow.' });
      await enqueue('retry-upload', { creativeId, attempt: 0 }, { delay: tomorrowAt1am(), jobId: `bs-retry-${creativeId}-${Date.now()}` });
      return { skipped: 'daily cap' };
    }

    let row = null;
    let startCalled = false;
    try {
      const bsJob = await client.announceJob();
      row = await store.insertJob({ ...base, briefing, bsJobId: bsJob.id, status: 'uploading' });
      const asset = await client.announceAsset(bsJob.id, fileName);
      await client.uploadFile(asset, filePath, fileName);
      startCalled = true;
      try {
        await client.startJob(bsJob.id, briefing);
      } catch (e) {
        if (refused(e)) throw e;
        console.error(`[brainsuite] ${creativeId}: start unclear, polling to find out: ${e.message}`);
      }
      // From here the test counts as started: it is only ever polled, never
      // started again. If these writes fail, the hourly sweep picks it up.
      await store.updateJob(row.id, { status: 'queued', started_at: new Date() });
      await queuePoll(row.id, FIRST_POLL_MS);
      return { started: row.id };
    } catch (e) {
      console.error(`[brainsuite] ${creativeId}: ${e.message}`);
      if (startCalled && !refused(e)) return { started: row && row.id, warning: e.message };
      if (row) await store.updateJob(row.id, { status: 'failed', error: (e.detail || e.message).slice(0, 500) }).catch(() => {});
      // Before a start, a failure downloads the video again later, up to 3 tries.
      if (!startCalled && attempt < 2) {
        await enqueue('retry-upload', { creativeId, attempt: attempt + 1 },
          { delay: (attempt + 1) * 10 * 60 * 1000, jobId: `bs-retry-${creativeId}-${attempt + 1}` }).catch(() => {});
      }
      return { failed: e.message };
    }
  } catch (e) {
    console.error(`[brainsuite] ${creativeId}: scoring skipped: ${e.message}`);
    return { failed: e.message };
  }
}

/** Downloads a creative's video again and scores it. Used after a failed upload or a full day. */
async function retryCreativeUpload({ creativeId, attempt = 0 }) {
  const { rows } = await query(
    `select creative_id, brand_id, type, campaign, ig_link, tt_link, fb_link, content_type
       from creatives where creative_id = $1`, [creativeId]);
  const c = rows[0];
  if (!c) return { skipped: 'creative no longer exists' };
  if (c.content_type === 'Photo') return { skipped: 'photo' };
  const link = c.ig_link || c.tt_link || c.fb_link;
  if (!link) return { skipped: 'no link' };

  // Same download path the creative worker uses (ScrapeCreators).
  const { resolveMediaUrl, streamToFile } = require('../../worker');
  const platform = link.includes('instagram.com') ? 'instagram' : link.includes('tiktok.com') ? 'tiktok' : 'facebook';
  const filePath = path.join(os.tmpdir(), `bs_retry_${creativeId.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`);
  try {
    const meta = await resolveMediaUrl(link);
    if (meta.kind === 'photo') return { skipped: 'photo' };
    await streamToFile(meta.download_url, filePath);
    return await scoreCreative({
      creativeId, brandId: c.brand_id, type: c.type, platform, campaign: c.campaign, filePath, attempt,
    });
  } finally {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* temp file */ }
  }
}

// Hourly: clear expired pre-test reports, close abandoned uploads, and
// restart polling for any running test whose poll chain went quiet.
async function expireNow() {
  const expired = await store.expirePretests();
  const abandoned = await store.failAbandonedUploads();
  const stalled = await store.stalledPolls();
  for (const id of stalled) await queuePoll(id, 1000);
  if (expired || abandoned || stalled.length) {
    console.log(`[brainsuite] expired ${expired} pre-test report(s), closed ${abandoned} abandoned upload(s), restarted ${stalled.length} poll(s)`);
  }
  return { expired, abandoned, restarted: stalled.length };
}

function settings() {
  return {
    configured: client.configured(),
    queue: !!getConnection(),
    ttlHours: TTL_HOURS, dailyCap: DAILY_CAP, monthlyPerUser: MONTHLY_PER_USER,
    channels: CHANNELS,
  };
}

module.exports = {
  HttpError, createPretest, freshUpload, startPretest, removePretest,
  pollOnce, queuePoll, mediaFor, scoreCreative, retryCreativeUpload, expireNow, settings,
  statusFor, safeFileName,
};

/**
 * Brainsuite tables (server/012_brainsuite.sql). Plain queries, no logic.
 */
const { query } = require('../../db');

const TZ = 'Asia/Colombo';

async function brandInfo(brandId) {
  const { rows } = await query(
    `select brand_id, name, bs_business_group, bs_category, bs_language, bs_auto_score
       from brands where brand_id = $1`, [brandId]);
  return rows[0] || null;
}

async function insertJob(j) {
  const { rows } = await query(
    `insert into brainsuite_jobs
       (bs_job_id, kind, creative_id, brand_id, requested_by, status, channel, briefing,
        asset_name, file_name, file_bytes, file_sha256, reused_from, error, started_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [j.bsJobId || null, j.kind, j.creativeId || null, j.brandId, j.requestedBy || null,
     j.status || 'uploading', j.channel, JSON.stringify(j.briefing || {}),
     j.assetName || null, j.fileName || null, j.fileBytes || null, j.fileSha256 || null,
     j.reusedFrom || null, j.error || null, j.startedAt || null, j.completedAt || null]);
  return rows[0];
}

async function getJob(id) {
  const { rows } = await query(`select * from brainsuite_jobs where id = $1`, [id]);
  return rows[0] || null;
}

// Only the columns named are written.
async function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getJob(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const vals = keys.map(k => (k === 'briefing' ? JSON.stringify(fields[k]) : fields[k]));
  const { rows } = await query(`update brainsuite_jobs set ${sets} where id = $1 returning *`, [id, ...vals]);
  return rows[0] || null;
}

async function bumpPoll(id) {
  const { rows } = await query(
    `update brainsuite_jobs set poll_count = poll_count + 1, last_polled_at = now()
      where id = $1 returning poll_count`, [id]);
  return rows[0] ? rows[0].poll_count : 0;
}

// Claims an uploaded pre-test for starting, so two /start requests at once
// cannot both start it. Returns null if someone else got there first.
async function claimForStart(id) {
  const { rows } = await query(
    `update brainsuite_jobs set status = 'queued', started_at = now()
      where id = $1 and status = 'uploading' returning *`, [id]);
  return rows[0] || null;
}

// Marks a running test succeeded and stores its summary in one statement,
// only if it is still running. A report the user deleted meanwhile stays deleted.
async function completeWithResult(id, summary, weblink, expiresAt) {
  const { rows } = await query(
    `with done as (
       update brainsuite_jobs set status = 'succeeded', completed_at = now(), error = null, expires_at = $4
        where id = $1 and status in ('queued','analysing') returning id)
     insert into brainsuite_results (job_id, total_score, total_rating, summary, weblink)
     select id, $2, $3, $5, $6 from done
     on conflict (job_id) do update set total_score = excluded.total_score,
       total_rating = excluded.total_rating, summary = excluded.summary, weblink = excluded.weblink
     returning job_id`,
    [id, summary.total.score, summary.total.rating, expiresAt, JSON.stringify(summary), weblink || null]);
  return rows.length > 0;
}

// Only moves a test that is still running, for the same reason.
async function updateIfRunning(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await query(
    `update brainsuite_jobs set ${sets} where id = $1 and status in ('queued','analysing') returning *`,
    [id, ...keys.map(k => fields[k])]);
  return rows[0] || null;
}

// Running tests whose poll chain has gone quiet (a lost job, a failed enqueue,
// a deploy at the wrong moment). The hourly job restarts their polling.
async function stalledPolls() {
  const { rows } = await query(
    `select id from brainsuite_jobs
      where status in ('queued','analysing') and bs_job_id is not null
        and coalesce(last_polled_at, started_at, created_at) < now() - interval '15 minutes'`);
  return rows.map(r => r.id);
}

async function saveResult(jobId, summary, weblink) {
  await query(
    `insert into brainsuite_results (job_id, total_score, total_rating, summary, weblink)
     values ($1,$2,$3,$4,$5)
     on conflict (job_id) do update set total_score = excluded.total_score,
       total_rating = excluded.total_rating, summary = excluded.summary, weblink = excluded.weblink`,
    [jobId, summary.total.score, summary.total.rating, JSON.stringify(summary), weblink || null]);
}

async function getResult(jobId) {
  const { rows } = await query(`select * from brainsuite_results where job_id = $1`, [jobId]);
  return rows[0] || null;
}

// ── Quota ────────────────────────────────────────────────────────────────────
async function pretestsStartedToday() {
  const { rows } = await query(
    `select count(*)::int as n from brainsuite_jobs
      where kind = 'pretest'
        and started_at >= (date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}')`);
  return rows[0].n;
}

// A succeeded test of the exact same file, briefed the same way, to reuse
// instead of spending quota. Same brand (the category and brand name feed the
// scores), same placement and same content origin (Brand or Creator), and
// always the original test, never a copy of one.
async function findByHash(sha, { brandId, channel, contentOrigin }) {
  const { rows } = await query(
    `select j.*, r.summary, r.weblink from brainsuite_jobs j
       join brainsuite_results r on r.job_id = j.id
      where j.file_sha256 = $1 and j.status = 'succeeded' and j.reused_from is null
        and j.bs_job_id is not null and j.brand_id = $2 and j.channel = $3
        and j.briefing->>'contentOrigin' = $4
      order by j.completed_at desc limit 1`, [sha, brandId, channel, contentOrigin]);
  return rows[0] || null;
}

// A test already running or done for this creative, so a retried worker job
// never starts a second one.
async function activeForCreative(creativeId) {
  const { rows } = await query(
    `select * from brainsuite_jobs
      where creative_id = $1 and kind = 'creative'
        and (status in ('queued','analysing','succeeded')
             -- an upload cut off by a deploy is not "running" after an hour
             or (status = 'uploading' and created_at > now() - interval '1 hour'))
      order by created_at desc limit 1`, [creativeId]);
  return rows[0] || null;
}

async function latestForCreative(creativeId) {
  const { rows } = await query(
    `select j.*, r.summary, r.weblink, r.total_score, r.total_rating
       from brainsuite_jobs j left join brainsuite_results r on r.job_id = j.id
      where j.creative_id = $1 and j.kind = 'creative'
      order by (j.status = 'succeeded') desc, j.created_at desc limit 1`, [creativeId]);
  return rows[0] || null;
}

async function listPretests(brandId, limit = 100) {
  const { rows } = await query(
    `select j.id, j.status, j.channel, j.asset_name, j.file_name, j.requested_by, j.error,
            j.created_at, j.started_at, j.completed_at, j.expires_at, j.briefing,
            coalesce(u.display_name, j.requested_by) as requested_by_name,
            r.total_score, r.total_rating
       from brainsuite_jobs j
       left join brainsuite_results r on r.job_id = j.id
       left join app_users u on u.username = j.requested_by
      where j.brand_id = $1 and j.kind = 'pretest'
      order by j.created_at desc limit $2`, [brandId, limit]);
  return rows;
}

// Pre-tests whose report has run out of time: the summary goes, the row stays.
async function expirePretests() {
  const { rows } = await query(
    `with gone as (
       update brainsuite_jobs set status = 'expired'
        where kind = 'pretest' and status = 'succeeded' and expires_at < now()
        returning id)
     delete from brainsuite_results where job_id in (select id from gone)
     returning job_id`);
  return rows.length;
}

// Uploads that never finished: the browser closed or the upload failed. These
// were never started, so they used no quota.
async function failAbandonedUploads() {
  const { rows } = await query(
    `update brainsuite_jobs set status = 'failed', error = 'Upload did not finish'
      where status = 'uploading' and created_at < now() - interval '24 hours'
      returning id`);
  return rows.length;
}

async function deleteResult(jobId) {
  await query(`delete from brainsuite_results where job_id = $1`, [jobId]);
}

async function usage() {
  const { rows } = await query(
    `select j.brand_id, b.name as brand_name, j.kind,
            count(*) filter (where j.started_at is not null)::int as started,
            count(*) filter (where j.status = 'succeeded' or j.status = 'expired')::int as finished,
            count(*) filter (where j.status = 'failed')::int as failed,
            count(*) filter (where j.reused_from is not null)::int as reused
       from brainsuite_jobs j left join brands b on b.brand_id = j.brand_id
      where j.created_at >= (date_trunc('month', now() at time zone '${TZ}') at time zone '${TZ}')
      group by j.brand_id, b.name, j.kind order by b.name, j.kind`);
  return rows;
}

module.exports = {
  brandInfo, insertJob, getJob, updateJob, bumpPoll, saveResult, getResult,
  claimForStart, completeWithResult, updateIfRunning, stalledPolls,
  pretestsStartedToday, findByHash, activeForCreative, latestForCreative,
  listPretests, expirePretests, failAbandonedUploads, deleteResult, usage,
};

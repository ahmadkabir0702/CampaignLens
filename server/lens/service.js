/**
 * Sound and Funnel fit for tracked creatives and pre-tests.
 *
 * Tracked creatives: the creative worker calls runForVideo / runForStatic
 * right after its own analysis, with the file it already downloaded and the
 * analysis it already paid for. No extra download, no extra Gemini call.
 *
 * Pre-tests: processPretest (queue 'pretests') does the whole job from the
 * uploaded file: send it to the scoring service, analyse it, run the checks,
 * delete the file.
 *
 * The funnel reads the Pre-test Score when there is one. That arrives about
 * five minutes after the analysis, so refreshFunnel runs again when it does.
 * Nothing here ever fails a creative or a pre-test: a problem is logged and
 * stored on the row.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./store');
const ffmpeg = require('./ffmpeg');
const { scoreSound, refreshSound, scoreFunnel } = require('./score');
const { query } = require('../../db');

const TTL_HOURS = Number(process.env.PRETEST_TTL_HOURS || 72);

async function brandName(brandId) {
  const { rows } = await query(`select name from brands where brand_id = $1`, [brandId]);
  return rows[0] ? rows[0].name : null;
}

/** Sound and funnel from a video on disk and its analysis. */
async function checksFor({ ref, filePath, analysis, isStatic = false, duration = null }) {
  const a = store.slimAnalysis(analysis) || {};
  let loud = null;
  if (!isStatic && filePath) {
    const info = await ffmpeg.probe(filePath);
    duration = duration || info.duration || (a.duration ? Number(a.duration) : null);
    if (info.hasAudio) loud = await ffmpeg.loudness(filePath);
  }
  const [bs, objective] = await Promise.all([store.pretestSummary(ref), store.objectiveFor(ref)]);
  const meta = { duration, isStatic };
  const sound = scoreSound({ a, loud, bs, meta });
  const funnel = scoreFunnel({ a, bs, sound, meta, objective });
  return { a, sound, funnel };
}

/** Tracked creative, video. Called by the creative worker. Never throws. */
async function runForVideo({ creativeId, brandId, filePath, analysis, duration }) {
  const ref = { kind: 'creative', creativeId, brandId };
  try {
    const { a, sound, funnel } = await checksFor({ ref, filePath, analysis, duration });
    await store.save(ref, { analysis: a, sound, funnel });
    return { ok: true, intent: funnel.intent, sound: sound && sound.score };
  } catch (e) {
    console.error(`[lens] ${creativeId}: ${e.message}`);
    await store.save(ref, { status: 'failed', error: e.message.slice(0, 300) }).catch(() => {});
    return { failed: e.message };
  }
}

/** Tracked creative, photo or carousel: funnel only. Never throws. */
async function runForStatic({ creativeId, brandId, analysis }) {
  const ref = { kind: 'creative', creativeId, brandId };
  try {
    const { a, funnel } = await checksFor({ ref, analysis, isStatic: true });
    await store.save(ref, { analysis: a, sound: null, funnel });
    return { ok: true, intent: funnel.intent };
  } catch (e) {
    console.error(`[lens] ${creativeId}: ${e.message}`);
    return { failed: e.message };
  }
}

/**
 * Re-work the funnel once the Pre-test Score has arrived. Called by the
 * scoring poll. The scored checks replace the analysis' own reading where
 * both exist, in the funnel and in the one Sound check they cover (works
 * with the sound off). A pre-test's report is only shown after this has run,
 * so nobody sees the numbers move.
 */
async function refreshFunnel(ref) {
  try {
    const row = await store.get(ref);
    if (!row || row.status !== 'succeeded' || !row.analysis) return null;
    const [bs, objective] = await Promise.all([store.pretestSummary(ref), store.objectiveFor(ref)]);
    if (!bs) return null;
    const a = row.analysis;
    const sound = refreshSound(row.sound, bs, a);
    const funnel = scoreFunnel({ a, bs, sound, objective, meta: { duration: a.duration ? Number(a.duration) : null, isStatic: !a.duration } });
    await store.saveFunnel(row.id, funnel, sound !== row.sound ? sound : null);
    return funnel;
  } catch (e) {
    console.error(`[lens] refresh ${ref.creativeId || ref.pretestId}: ${e.message}`);
    return null;
  }
}

// ── Pre-tests ────────────────────────────────────────────────────────────────
/**
 * One pre-test, from the uploaded file. Steps, each skipped on a retry once
 * done:
 *   1. fetch the file from temporary storage and check it is a video
 *   2. send it to the scoring service and start the test (uses quota)
 *   3. analyse it with Gemini, run Sound and Funnel fit
 *   4. delete the file (also done by the bucket's one-day rule)
 */
async function processPretest(job, ai) {
  const bsStore = require('../brainsuite/store');
  const bsService = require('../brainsuite/service');
  const r2 = require('./r2');
  const rowId = job.data.rowId;
  let row = await bsStore.getJob(rowId);
  if (!row || row.kind !== 'pretest' || !row.upload_key) return { skipped: 'not an uploaded pre-test' };
  if (['failed', 'expired'].includes(row.status)) {
    await r2.remove(row.upload_key).catch(() => {});
    return { skipped: row.status };
  }

  const ext = path.extname(row.upload_key) || '.mp4';
  const tmp = path.join(os.tmpdir(), `pretest_${rowId}${ext}`);
  const ref = { kind: 'pretest', pretestId: rowId, brandId: row.brand_id };
  try {
    await job.updateProgress({ step: 'fetching' }).catch(() => {});
    await r2.download(row.upload_key, tmp);
    let info;
    try { info = await ffmpeg.probe(tmp); } catch (e) {
      await bsService.failUploadedPretest(row, 'The file is not a video that can be read. Export it as MP4 and try again.');
      await r2.remove(row.upload_key).catch(() => {});
      return { failed: e.message };
    }
    if (!info.hasVideo) {
      await bsService.failUploadedPretest(row, 'The file has no video track.');
      await r2.remove(row.upload_key).catch(() => {});
      return { failed: 'no video' };
    }

    // 2. The scoring service. Quota is used once, here.
    if (!row.bs_uploaded_at) {
      await job.updateProgress({ step: 'scoring' }).catch(() => {});
      const out = await bsService.sendUploadedPretest(row, tmp);
      if (out.refused) {
        await r2.remove(row.upload_key).catch(() => {});
        return { failed: out.refused };
      }
      row = await bsStore.getJob(rowId);
    }

    // 3. Sound and Funnel fit. A problem here never stops the Pre-test Score.
    const existing = await store.get(ref);
    if (!existing || existing.status !== 'succeeded') {
      await job.updateProgress({ step: 'analysing' }).catch(() => {});
      try {
        if (!ai) throw new Error('Video analysis is not connected on this server.');
        const { analyseVideo, deriveTimelineMetrics } = require('../../worker');
        const name = await brandName(row.brand_id);
        const a = await analyseVideo(ai, tmp, info.duration, name);
        const d = deriveTimelineMetrics(a.timeline_attrs);
        const analysis = { ...a, product_screen_pct: d.productPct, time_to_product_s: d.timeToProduct, duration: info.duration || a.duration };
        const { a: slim, sound, funnel } = await checksFor({ ref, filePath: tmp, analysis, duration: info.duration });
        await store.save(ref, {
          analysis: slim, sound, funnel,
          costUsd: a._usage ? a._usage.cost_usd : null,
          expiresAt: new Date(Date.now() + (TTL_HOURS + 24) * 3600 * 1000),
        });
      } catch (e) {
        console.error(`[lens] pre-test ${rowId}: ${e.message}`);
        // The last attempt records the failure; earlier ones let the queue retry.
        if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
          await store.save(ref, { status: 'failed', error: e.message.slice(0, 300) }).catch(() => {});
        } else {
          throw e;
        }
      }
    }

    await r2.remove(row.upload_key).catch(e => console.warn(`[lens] could not delete ${row.upload_key}: ${e.message}`));
    return { ok: true };
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* temp file */ }
  }
}

/** After the last attempt failed: close the pre-test and delete the file. */
async function pretestGaveUp(rowId, err) {
  const bsStore = require('../brainsuite/store');
  const bsService = require('../brainsuite/service');
  const r2 = require('./r2');
  const row = await bsStore.getJob(rowId);
  if (!row) return;
  if (!row.bs_uploaded_at) await bsService.failUploadedPretest(row, `The video could not be processed: ${String(err && err.message || err).slice(0, 200)}`);
  await r2.remove(row.upload_key).catch(() => {});
}

module.exports = { runForVideo, runForStatic, refreshFunnel, processPretest, pretestGaveUp, checksFor };

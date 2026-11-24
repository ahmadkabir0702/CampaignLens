/**
 * The `pretests` queue: one job per uploaded pre-test (server/lens/service.js
 * processPretest). Kept apart from `creative-downloads` and `brainsuite` so a
 * burst of pre-tests never holds up newly added creatives or score polling,
 * and limited to PRETEST_CONCURRENCY at a time (default 2) so a burst cannot
 * swamp the server.
 *
 * Started wherever the creative worker runs, with its Gemini client.
 */
const { getConnection } = require('../brainsuite/queue');

const QUEUE_NAME = 'pretests';
let queue = null;
let worker = null;

function getQueue() {
  if (queue) return queue;
  const conn = getConnection();
  if (!conn) return null;
  const { Queue } = require('bullmq');
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

async function enqueuePretest(rowId) {
  const q = getQueue();
  if (!q) throw new Error('Redis is not configured, so pre-tests cannot be queued.');
  return q.add('pretest', { rowId }, {
    jobId: `pretest-${rowId}`,
    attempts: 3, backoff: { type: 'exponential', delay: 60 * 1000 },
    removeOnComplete: 200, removeOnFail: 500,
  });
}

function startPretestWorker(ai) {
  if (worker) return worker;
  const conn = getConnection();
  if (!conn) return null;
  const service = require('./service');
  const { Worker } = require('bullmq');
  worker = new Worker(QUEUE_NAME, job => service.processPretest(job, ai), {
    connection: conn,
    concurrency: Number(process.env.PRETEST_CONCURRENCY || 2),
    // Fetch, upload to the scoring service and a Gemini analysis of a large file.
    lockDuration: 20 * 60 * 1000,
    stalledInterval: 30 * 1000,
    maxStalledCount: 2,
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    console.error(`[lens] pre-test ${job.data.rowId} failed (attempt ${job.attemptsMade}/${job.opts.attempts || 1}): ${err.message}`);
    if (job.attemptsMade >= (job.opts.attempts || 1)) service.pretestGaveUp(job.data.rowId, err).catch(() => {});
  });
  console.log('[lens] pre-test worker active');
  return worker;
}

async function closePretestWorker() {
  if (!worker) return;
  try { await worker.close(); } catch (e) { /* already closed */ }
}

module.exports = { enqueuePretest, startPretestWorker, closePretestWorker };

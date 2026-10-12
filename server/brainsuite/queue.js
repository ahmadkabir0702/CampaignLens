/**
 * The `brainsuite` queue. Kept apart from `creative-downloads` so a slow
 * Brainsuite day never holds up Gemini analysis, and the reverse.
 *
 * Three kinds of job:
 *   poll          checks one test once. If it is not done, it queues the next
 *                 check with a delay instead of waiting, so nothing sits idle
 *                 and a deploy loses nothing: the next check is in Redis.
 *   retry-upload  downloads a creative's video again when its first upload
 *                 to Brainsuite failed (or the daily cap was full).
 *   expire        hourly: clears pre-test reports past PRETEST_TTL_HOURS.
 *
 * The queue (producer) starts in every process that has REDIS_URL. The
 * worker (consumer) starts wherever the creative worker runs: inside the web
 * service by default, or in `node worker.js` when that is split out.
 */
const QUEUE_NAME = 'brainsuite';

let connection = null;
let queue = null;
let worker = null;

function getConnection() {
  if (!process.env.REDIS_URL) return null;
  if (!connection) {
    const IORedis = require('ioredis');
    connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', e => console.error('[brainsuite] redis:', e.message));
  }
  return connection;
}

function getQueue() {
  if (queue) return queue;
  const conn = getConnection();
  if (!conn) return null;
  const { Queue } = require('bullmq');
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

async function enqueue(name, data, opts = {}) {
  const q = getQueue();
  if (!q) throw new Error('Redis is not configured, so Brainsuite jobs cannot be queued.');
  return q.add(name, data, { removeOnComplete: 200, removeOnFail: 500, ...opts });
}

function startBrainsuiteWorker() {
  if (worker) return worker;
  const conn = getConnection();
  if (!conn) {
    console.log('[brainsuite] REDIS_URL not set — Brainsuite worker not started.');
    return null;
  }
  const service = require('./service');
  const { Worker } = require('bullmq');

  worker = new Worker(QUEUE_NAME, async (job) => {
    if (job.name === 'poll') {
      const next = await service.pollOnce(job.data.rowId);
      if (next) await service.queuePoll(job.data.rowId, next);
      return { next };
    }
    if (job.name === 'retry-upload') return service.retryCreativeUpload(job.data);
    if (job.name === 'expire') return service.expireNow();
    throw new Error(`Unknown Brainsuite job: ${job.name}`);
  }, {
    connection: conn,
    concurrency: Number(process.env.BS_WORKER_CONCURRENCY || 4),
    // A retry-upload downloads and re-uploads a video; give it room.
    lockDuration: 15 * 60 * 1000,
    stalledInterval: 30 * 1000,
    // Polite to Brainsuite: at most 10 calls every 10 seconds from this queue.
    limiter: { max: 10, duration: 10000 },
  });

  worker.on('failed', (job, err) => {
    if (job) console.error(`[brainsuite] ${job.name} ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`);
  });

  // Hourly clean-up. One scheduler id, so restarts never stack copies.
  const q = getQueue();
  const every = 60 * 60 * 1000;
  const p = typeof q.upsertJobScheduler === 'function'
    ? q.upsertJobScheduler('brainsuite-expire', { every }, { name: 'expire', data: {} })
    : q.add('expire', {}, { repeat: { every }, jobId: 'brainsuite-expire', removeOnComplete: true });
  p.catch(e => console.error('[brainsuite] could not schedule expiry:', e.message));

  console.log('[brainsuite] worker active');
  return worker;
}

// Called by worker.js's shutdown before the process exits, so a deploy lets a
// running poll or retry-upload finish instead of cutting it off.
async function closeBrainsuiteWorker() {
  if (!worker) return;
  try { await worker.close(); } catch (e) { /* already closed */ }
}

module.exports = { getQueue, getConnection, enqueue, startBrainsuiteWorker, closeBrainsuiteWorker };

/**
 * media-queue.js — background video download queue (BullMQ + Redis)
 *
 * This was previously written into creatives.js, which overwrote the module
 * that builds the dashboard payload. It lives in its own file now.
 *
 * Opt-in: without REDIS_URL there is no queue, and add-creative writes the
 * row directly. The queue has no HTTP routes of its own; the old upload and
 * job-status routes were removed (they were unused and showed any brand's
 * jobs to any signed-in account).
 */

function mountMediaQueue(app) {
  if (!process.env.REDIS_URL) {
    console.log('[media-queue] REDIS_URL not set, no analysis queue.');
    return null;
  }

  const { Queue } = require('bullmq');
  const IORedis = require('ioredis');

  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    // Fail fast instead of queueing commands while Redis is unreachable, so
    // add-creative answers with an error rather than hanging.
    enableOfflineQueue: false,
    connectTimeout: 10000,
  });
  connection.on('error', e => console.error('[media-queue] redis:', e.message));

  const downloadQueue = new Queue('creative-downloads', { connection });
  // routes.js reaches the queue through this rather than importing it, so the
  // add-creative route works unchanged when Redis is absent.
  app.set('mediaQueue', downloadQueue);
  console.log('[media-queue] queue ready');
  return downloadQueue;
}

module.exports = { mountMediaQueue };

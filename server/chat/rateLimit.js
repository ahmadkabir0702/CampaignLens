/**
 * Ask Lens - rate limiting
 *
 * Two windows per user: hourly and daily. Counted in Postgres rather
 * than memory so the limit holds across Render restarts and any future
 * second instance.
 */

const S = require('./schema.config');
const { getPool } = require('./db');

function windowStart(kind, now = new Date()) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  if (kind === 'day') d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Increments both windows and returns { allowed, reason, retryAfter }.
 * Fails open: if the counter table is unreachable, the message goes
 * through. The Anthropic spend cap is the real backstop.
 */
async function consume(userId, opts = {}) {
  const pool = opts.pool || getPool();
  const now = new Date();

  try {
    const checks = [
      { kind: 'hour', limit: S.rateLimit.perHour },
      { kind: 'day', limit: S.rateLimit.perDay },
    ];

    for (const { kind, limit } of checks) {
      const start = windowStart(kind, now);
      const { rows } = await pool.query(
        `insert into chat_rate_limit (user_id, window_kind, window_start, count)
         values ($1, $2, $3, 1)
         on conflict (user_id, window_kind, window_start)
           do update set count = chat_rate_limit.count + 1
         returning count`,
        [userId, kind, start],
      );
      const count = rows[0].count;
      if (count > limit) {
        return {
          allowed: false,
          reason: kind === 'hour'
            ? `You've hit the hourly limit of ${limit} questions. Try again shortly.`
            : `You've hit the daily limit of ${limit} questions.`,
          retryAfter: kind === 'hour' ? 3600 : 86400,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    console.error('[rateLimit] failing open:', err.message);
    return { allowed: true };
  }
}

/** Cleanup for cron. Windows older than two days are dead weight. */
async function prune(opts = {}) {
  const pool = opts.pool || getPool();
  await pool.query(`delete from chat_rate_limit where window_start < now() - interval '2 days'`);
}

module.exports = { consume, prune };

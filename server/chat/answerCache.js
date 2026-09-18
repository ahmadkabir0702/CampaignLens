/**
 * Ask Lens - shared answer cache
 *
 * Shared across all users, because every main-login user sees the same
 * brand data. One person asking "what's the top creative" warms it for
 * the whole team.
 *
 * Keyed on snapshot version, so it invalidates itself the moment the
 * n8n pipeline refreshes the underlying data. No TTL needed.
 *
 * Only single-turn questions are cached. Once a conversation has
 * history, the answer depends on that history and is not shareable.
 */

const crypto = require('crypto');
const { getPool } = require('./db');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'please', 'me', 'my', 'our', 'we',
  'i', 'you', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'so',
  'just', 'hey', 'hi', 'ok', 'okay', 'show', 'tell', 'give', 'whats',
]);

/**
 * Normalise a question so trivially different phrasings share a key.
 * "What's the best performing post?" and "best performing post"
 * collapse to the same string.
 */
function normalise(question) {
  return String(question)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()              // word order should not create a cache miss
    .join(' ')
    .trim();
}

function keyFor({ brand, rangeDays, snapshotVersion, question }) {
  const norm = normalise(question);
  const raw = [brand, rangeDays, snapshotVersion, norm].join('|');
  return { key: crypto.createHash('sha256').update(raw).digest('hex'), norm };
}

async function get(params, opts = {}) {
  if (params.hasHistory) return null;
  const pool = opts.pool || getPool();
  const { key } = keyFor(params);
  try {
    const { rows } = await pool.query(
      `update chat_answer_cache
         set hit_count = hit_count + 1, last_hit_at = now()
       where key = $1
       returning answer, records`,
      [key],
    );
    if (!rows.length) return null;
    return { answer: rows[0].answer, records: rows[0].records || {} };
  } catch (err) {
    console.error('[answerCache.get]', err.message);
    return null; // a cache failure must never break the chat
  }
}

async function put(params, { answer, records }, opts = {}) {
  if (params.hasHistory) return;
  if (!answer || answer.length < 20) return;       // do not cache refusals or stubs
  const pool = opts.pool || getPool();
  const { key, norm } = keyFor(params);
  try {
    await pool.query(
      `insert into chat_answer_cache (key, brand, snapshot_ver, question_norm, answer, records)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (key) do nothing`,
      [key, params.brand, params.snapshotVersion, norm, answer, JSON.stringify(records || {})],
    );
  } catch (err) {
    console.error('[answerCache.put]', err.message);
  }
}

module.exports = { get, put, normalise, keyFor };

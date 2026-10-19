// =====================================================================
//  pg-session-store.js — sign-in sessions kept in Postgres
//
//  Sessions used to live in Redis, alongside the video analysis and
//  pre-test queues. Redis is memory only: when it filled up it could drop
//  sessions to make room, and people were signed out every few minutes.
//  Postgres keeps them on disk, so they survive restarts and are never
//  dropped for space.
//
//  Load is small by design:
//    - reading a session is one lookup by primary key, and a session read
//      in the last CACHE_MS is served from memory, so a page load that
//      fires twenty requests reads it once;
//    - the expiry is pushed forward at most once every TOUCH_EVERY_MS per
//      session, however often someone clicks, rather than on every request;
//    - expired rows are deleted every PRUNE_EVERY_MS;
//    - it has its own pool of two connections, so a slow dashboard query
//      can never hold up the sign-in check, and vice versa.
// =====================================================================
const { Pool } = require('pg');

const TABLE = 'app_sessions';
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 15 * 60 * 1000;
const CACHE_MS = 30 * 1000;

module.exports = function makePgSessionStore(session) {
  const Store = session.Store;

  class PgSessionStore extends Store {
    constructor({ ttlMs }) {
      super();
      this.ttlMs = ttlMs;
      this.lastTouch = new Map();
      this.cache = new Map();
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      this.pool.on('error', (e) => console.error('[session] pg idle client error:', e.message));
      this.ready = this.pool.query(
        `create table if not exists ${TABLE} (
           sid    text primary key,
           sess   jsonb not null,
           expire timestamptz not null
         );
         create index if not exists ${TABLE}_expire on ${TABLE} (expire);
         alter table ${TABLE} enable row level security;`)
        .catch((e) => console.error('[session] could not create table:', e.message));
      this.pruner = setInterval(() => this.prune(), PRUNE_EVERY_MS);
      if (this.pruner.unref) this.pruner.unref();
    }

    expiryFor(sess) {
      const ms = sess && sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + this.ttlMs;
      return new Date(ms);
    }

    get(sid, cb) {
      const hit = this.cache.get(sid);
      if (hit && Date.now() - hit.at < CACHE_MS) {
        // A copy, so changes made during a request reach the database
        // through set() and not by editing the cached object.
        return cb(null, JSON.parse(hit.json));
      }
      this.ready.then(() => this.pool.query(
        `select sess from ${TABLE} where sid = $1 and expire > now()`, [sid]))
        .then(({ rows }) => {
          const sess = rows.length ? rows[0].sess : null;
          if (sess) this.cache.set(sid, { json: JSON.stringify(sess), at: Date.now() });
          else this.cache.delete(sid);
          cb(null, sess);
        })
        .catch((e) => cb(e));
    }

    set(sid, sess, cb) {
      this.lastTouch.set(sid, Date.now());
      this.cache.set(sid, { json: JSON.stringify(sess), at: Date.now() });
      this.ready.then(() => this.pool.query(
        `insert into ${TABLE} (sid, sess, expire) values ($1, $2, $3)
         on conflict (sid) do update set sess = excluded.sess, expire = excluded.expire`,
        [sid, JSON.stringify(sess), this.expiryFor(sess)]))
        .then(() => cb && cb(null))
        .catch((e) => cb && cb(e));
    }

    // Called on every request because the cookie is rolling. Only goes to
    // the database when this session's expiry has not been pushed forward
    // in the last five minutes; eight hours of sign-in does not need
    // minute-by-minute precision.
    touch(sid, sess, cb) {
      const last = this.lastTouch.get(sid) || 0;
      if (Date.now() - last < TOUCH_EVERY_MS) return cb && cb(null);
      this.lastTouch.set(sid, Date.now());
      this.ready.then(() => this.pool.query(
        `update ${TABLE} set expire = $2 where sid = $1`, [sid, this.expiryFor(sess)]))
        .then(() => cb && cb(null))
        .catch((e) => cb && cb(e));
    }

    destroy(sid, cb) {
      this.lastTouch.delete(sid);
      this.cache.delete(sid);
      this.ready.then(() => this.pool.query(`delete from ${TABLE} where sid = $1`, [sid]))
        .then(() => cb && cb(null))
        .catch((e) => cb && cb(e));
    }

    prune() {
      this.pool.query(`delete from ${TABLE} where expire < now()`)
        .catch((e) => console.warn('[session] prune failed:', e.message));
      // The touch memory is only an optimisation; dropping it costs one
      // extra write per session, so it is simply cleared.
      if (this.lastTouch.size > 5000) this.lastTouch.clear();
      const now = Date.now();
      for (const [sid, v] of this.cache) if (now - v.at > CACHE_MS) this.cache.delete(sid);
    }
  }

  return PgSessionStore;
};

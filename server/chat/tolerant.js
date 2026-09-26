/**
 * Ask Lens - reads that survive a missed database step
 *
 * If code that reads a new column deploys before the migration that adds it,
 * Postgres refuses the whole query and the chat goes down. That happened once.
 *
 * This runs the query as written. If Postgres says a selected column does not
 * exist, it logs a clear warning, drops that one column from the select list
 * and tries again. The chat keeps working without that field until the
 * migration runs. Only ever removes a column from the select list; any other
 * error is raised as normal.
 */

const warned = new Set();

async function queryTolerant(pool, sql, params) {
  let text = sql;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const m = err && err.code === '42703' && /column "?([\w.]+)"? does not exist/.exec(err.message || '');
      if (!m) throw err;
      const col = m[1].replace(/"/g, '');
      const bare = col.split('.').pop();
      const esc = col.replace(/\./g, '\\.');
      const before = text;
      // remove "col," or ", col" as a selected column, qualified or not
      text = text.replace(new RegExp(`\\b${esc}\\s*,\\s*`), '');
      if (text === before) text = text.replace(new RegExp(`,\\s*\\b${esc}\\b`), '');
      if (text === before && col !== bare) {
        text = text.replace(new RegExp(`\\b(\\w+\\.)?${bare}\\s*,\\s*`), '');
      }
      if (text === before) throw err; // could not remove it safely: surface the real error
      if (!warned.has(bare)) {
        warned.add(bare);
        console.warn(`[ask-lens] database column "${bare}" is missing; run the latest migration. Continuing without it.`);
      }
    }
  }
  throw new Error('queryTolerant: too many missing columns');
}

module.exports = { queryTolerant };

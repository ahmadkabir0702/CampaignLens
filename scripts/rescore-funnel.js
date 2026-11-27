#!/usr/bin/env node
/**
 * Work out every stored Funnel fit again with the current rule: each
 * objective score is the Pre-test Score weighted for that objective.
 *
 * Reads what is already stored (the analysis, Sound and the Pre-test Score
 * summary). No download, no Gemini call, no scoring quota. Creatives and
 * pre-tests with no Pre-test Score lose their old analysis-only numbers and
 * keep what they are built for. Safe to run more than once. From the Render shell:
 *   node scripts/rescore-funnel.js --dry          count only
 *   node scripts/rescore-funnel.js --brand=lux    one brand
 *   node scripts/rescore-funnel.js                everything
 */
require('dotenv').config();
const { query, pool } = require('../db');
const lensStore = require('../server/lens/store');
const { scoreFunnel, refreshSound } = require('../server/lens/score');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

(async () => {
  const params = [];
  let where = `status = 'succeeded' and analysis is not null`;
  if (args.brand) { params.push(args.brand); where += ` and brand_id = $1`; }
  const { rows } = await query(`select id, kind, creative_id, pretest_id, brand_id, analysis, sound from lens_checks where ${where}`, params);
  console.log(`${rows.length} to work out again`);
  if (args.dry) { await pool.end(); return; }
  let scored = 0, without = 0, failed = 0;
  for (const r of rows) {
    try {
      const ref = r.kind === 'pretest' ? { kind: 'pretest', pretestId: r.pretest_id, brandId: r.brand_id } : { kind: 'creative', creativeId: r.creative_id, brandId: r.brand_id };
      const [bs, objective] = await Promise.all([lensStore.pretestSummary(ref), lensStore.objectiveFor(ref)]);
      const a = r.analysis;
      const sound = bs ? refreshSound(r.sound, bs, a) : r.sound;
      const funnel = scoreFunnel({ a, bs, sound, objective, meta: { duration: a.duration ? Number(a.duration) : null, isStatic: !a.duration } });
      await lensStore.saveFunnel(r.id, funnel, sound !== r.sound ? sound : null);
      if (funnel.basis === 'full') scored++; else without++;
    } catch (e) { failed++; console.error(`${r.id}: ${e.message}`); }
  }
  console.log(`Done: ${scored} with objective scores, ${without} without a Pre-test Score, ${failed} failed`);
  await pool.end();
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

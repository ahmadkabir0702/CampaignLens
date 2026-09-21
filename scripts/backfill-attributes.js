#!/usr/bin/env node
/**
 * Backfill the creative attribute columns over existing creatives.
 *
 * Re-runs the classifier on every creative with attrs_version = 0, using the
 * exact same download and analyse path as the live pipeline, so backfilled and
 * new creatives are directly comparable. Only the attribute columns change.
 * Safe to stop and restart: it picks up where it left off.
 *
 * Run from the Render shell:
 *   node scripts/backfill-attributes.js --dry            count only, no Gemini calls
 *   node scripts/backfill-attributes.js --brand=lux      one brand
 *   node scripts/backfill-attributes.js --limit=5        a small batch
 *   node scripts/backfill-attributes.js                  everything left
 *
 * Costs Gemini video analysis per creative. Do one brand first and check the
 * spread it prints before running the rest.
 */

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { query, pool } = require('../db');
const { classifyExisting } = require('../worker');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

async function main() {
  const where = ['(attrs_version is null or attrs_version = 0)', "coalesce(tt_link, ig_link, fb_link) is not null"];
  const params = [];
  if (args.brand) { params.push(args.brand); where.push(`brand_id = $${params.length}`); }
  const limit = args.limit ? `limit ${Number(args.limit)}` : '';

  const { rows } = await query(
    `select creative_id, brand_id, ig_link, fb_link, tt_link, duration_s
     from creatives where ${where.join(' and ')}
     order by date desc nulls last ${limit}`, params);

  if (args.dry) {
    const { rows: byBrand } = await query(
      `select brand_id, count(*)::int as to_classify
       from creatives
       where (attrs_version is null or attrs_version = 0)
         and coalesce(tt_link, ig_link, fb_link) is not null
       group by brand_id order by to_classify desc`);
    console.table(byBrand);
    console.log(`Total: ${byBrand.reduce((s, r) => s + r.to_classify, 0)} creatives. No Gemini calls made.`);
    return;
  }

  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set.'); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`Classifying ${rows.length} creatives${args.brand ? ` for ${args.brand}` : ''}...`);
  let done = 0, failed = 0, spent = 0;
  for (const row of rows) {
    try {
      const r = await classifyExisting(ai, row);
      done += 1;
      if (r.cost_usd) spent += r.cost_usd;
      console.log(`  ${done}/${rows.length} ${row.creative_id}: ${r.hook_device} / ${r.content_intent}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${row.creative_id}: ${err.message}`);
    }
  }
  console.log(`\nDone. ${done} classified, ${failed} failed, about $${spent.toFixed(2)} in Gemini.`);

  // The spread shows immediately whether the classifier is skewed.
  const { rows: spread } = await query(
    `select hook_device, count(*)::int as creatives
     from creatives where attrs_version = 1 ${args.brand ? 'and brand_id = $1' : ''}
     group by hook_device order by creatives desc`, args.brand ? [args.brand] : []);
  console.log('\nHook device spread:');
  console.table(spread);
  const top = spread[0];
  const total = spread.reduce((s, r) => s + r.creatives, 0);
  if (top && total >= 10 && top.creatives / total > 0.5) {
    console.log(`WARNING: "${top.hook_device}" is ${Math.round(top.creatives / total * 100)}% of creatives.`);
    console.log('The classifier may be defaulting to it. Check a few by eye before running more brands.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (pool && pool.end) pool.end(); });

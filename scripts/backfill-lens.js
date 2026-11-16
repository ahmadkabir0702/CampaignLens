#!/usr/bin/env node
/**
 * Backfill Sound and Funnel fit over creatives added before they existed.
 *
 * Two ways:
 *   quick (default)  Funnel fit only, from what each creative already has:
 *                    its stored analysis columns and its Pre-test Score.
 *                    No download, no Gemini call, no cost. Reasons to buy,
 *                    offers and Sound are missing, so it is a rougher read.
 *   --full           Downloads each video again and runs the full analysis,
 *                    Sound included, exactly like a newly added creative.
 *                    About $0.06 of Gemini per video.
 *
 * Only creatives without a result are touched, so it is safe to stop and
 * restart. Run from the Render shell:
 *   node scripts/backfill-lens.js --dry                 count only
 *   node scripts/backfill-lens.js --brand=lux           quick, one brand
 *   node scripts/backfill-lens.js --full --limit=5      full, a small batch
 *   node scripts/backfill-lens.js --full --brand=lux    full, one brand
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { query, pool } = require('../db');
const lensStore = require('../server/lens/store');
const lens = require('../server/lens/service');
const { scoreFunnel } = require('../server/lens/score');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

async function todo() {
  const where = [`not exists (select 1 from lens_checks l where l.kind = 'creative' and l.creative_id = c.creative_id and l.status = 'succeeded')`];
  const params = [];
  if (args.brand) { params.push(args.brand); where.push(`c.brand_id = $${params.length}`); }
  const limit = args.limit ? `limit ${Number(args.limit)}` : '';
  const { rows } = await query(
    `select c.creative_id, c.brand_id, c.content_type, c.duration_s, c.ig_link, c.fb_link, c.tt_link,
            c.format, c.product_role, c.content_intent, c.narrative_structure, c.hook_device, c.hook_pace,
            c.opens_with_product, c.opens_with_face, c.has_text_overlay, c.logo_first_3s, c.captions,
            c.voiceover, c.music, c.cta, c.language, c.timeline_attrs, c.time_to_product_s, c.product_screen_pct,
            b.name as brand_name
       from creatives c join brands b on b.brand_id = c.brand_id
      where ${where.join(' and ')}
      order by c.date desc nulls last ${limit}`, params);
  return rows;
}

async function quick(row) {
  const isStatic = row.content_type === 'Photo' || row.content_type === 'Carousel';
  const analysis = { ...row, duration: row.duration_s ? Number(row.duration_s) : null,
    product_screen_pct: row.product_screen_pct == null ? null : Number(row.product_screen_pct) };
  const ref = { kind: 'creative', creativeId: row.creative_id, brandId: row.brand_id };
  const a = lensStore.slimAnalysis(analysis);
  const bs = await lensStore.pretestSummary(ref);
  const funnel = scoreFunnel({ a, bs, sound: null, meta: { duration: a.duration, isStatic } });
  await lensStore.save(ref, { analysis: a, funnel });
  return funnel;
}

async function full(ai, row) {
  const { resolveMediaUrl, streamToFile, analyseVideo, attributeColumns } = require('../worker');
  const link = row.tt_link || row.ig_link || row.fb_link;
  if (!link) throw new Error('no link');
  const meta = await resolveMediaUrl(link);
  if (meta.kind && meta.kind !== 'video') return quick(row);   // photos: nothing to listen to
  const file = path.join(os.tmpdir(), `lens_backfill_${row.creative_id.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`);
  try {
    await streamToFile(meta.download_url, file);
    const hint = typeof meta.duration === 'number' ? meta.duration : (row.duration_s ? Number(row.duration_s) : null);
    const a = await analyseVideo(ai, file, hint, row.brand_name);
    const at = attributeColumns(a);
    const r = await lens.runForVideo({ creativeId: row.creative_id, brandId: row.brand_id, filePath: file, duration: hint,
      analysis: { ...a, product_screen_pct: at.product_screen_pct, time_to_product_s: at.time_to_product_s } });
    if (r.failed) throw new Error(r.failed);
    return { cost: a._usage ? a._usage.cost_usd : 0 };
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* temp */ }
  }
}

async function main() {
  const rows = await todo();
  if (args.dry) {
    const by = {};
    for (const r of rows) by[r.brand_id] = (by[r.brand_id] || 0) + 1;
    console.table(by);
    console.log(`Total: ${rows.length} creatives without Funnel fit. Nothing changed.`);
    return;
  }
  let ai = null;
  if (args.full) {
    if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set.'); process.exit(1); }
    const { GoogleGenAI } = require('@google/genai');
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  console.log(`${args.full ? 'Full' : 'Quick'} backfill of ${rows.length} creatives${args.brand ? ` for ${args.brand}` : ''}...`);
  let done = 0, failed = 0, spent = 0;
  const intents = {};
  for (const row of rows) {
    try {
      if (args.full) {
        const r = await full(ai, row);
        spent += (r && r.cost) || 0;
      } else {
        const f = await quick(row);
        intents[f.intent] = (intents[f.intent] || 0) + 1;
      }
      done += 1;
      if (done % 10 === 0) console.log(`  ${done} done${args.full ? `, $${spent.toFixed(2)} so far` : ''}`);
    } catch (e) {
      failed += 1;
      console.warn(`  ${row.creative_id}: ${e.message}`);
    }
  }
  console.log(`Done: ${done}, failed: ${failed}${args.full ? `, Gemini about $${spent.toFixed(2)}` : ''}.`);
  if (!args.full) console.table(intents);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool && pool.end && pool.end());

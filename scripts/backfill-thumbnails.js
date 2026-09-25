#!/usr/bin/env node
/**
 * Backfill thumbnails for creatives added before thumbnails were stored.
 *
 * For each creative with no thumbnail_url, fetches the post from
 * ScrapeCreators (one credit), downloads the thumbnail, stores it in Supabase
 * Storage and saves the permanent URL. No Gemini, no video download.
 * Safe to stop and restart: it only touches creatives still missing one.
 *
 * Run from the Render shell:
 *   node scripts/backfill-thumbnails.js --dry           count only
 *   node scripts/backfill-thumbnails.js --brand=ponds   one brand
 *   node scripts/backfill-thumbnails.js --limit=10      a small batch
 *   node scripts/backfill-thumbnails.js                 everything left
 *
 * Cost: one ScrapeCreators credit per creative.
 */

require('dotenv').config();
const axios = require('axios');
const { query, pool } = require('../db');
const { storeThumbnail, configured } = require('../thumbnails');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const KEY = process.env.SCRAPECREATORS_API_KEY;
const ENDPOINT = {
  ig: 'https://api.scrapecreators.com/v1/instagram/post',
  tt: 'https://api.scrapecreators.com/v2/tiktok/video',
  fb: 'https://api.scrapecreators.com/v1/facebook/post',
};

// Same preference order as the worker: the video Gemini analysed.
function pickLink(row) {
  if (row.ig_link) return ['ig', row.ig_link];
  if (row.tt_link) return ['tt', row.tt_link];
  if (row.fb_link) return ['fb', row.fb_link];
  return [null, null];
}

// Candidate thumbnail URLs, best first. A list rather than one URL because
// TikTok lists .heic covers before the .jpeg, and no browser shows HEIC.
function thumbFrom(platform, body) {
  if (platform === 'ig') {
    const m = (body && body.data && body.data.xdt_shortcode_media) || {};
    return [m.thumbnail_src, m.display_url].filter(Boolean);
  }
  if (platform === 'tt') {
    const v = (body && body.aweme_detail && body.aweme_detail.video) || {};
    const urls = []
      .concat((v.cover && v.cover.url_list) || [])
      .concat((v.origin_cover && v.origin_cover.url_list) || [])
      .concat((v.dynamic_cover && v.dynamic_cover.url_list) || [])
      .filter(Boolean);
    const good = urls.filter(u => /\.(jpe?g|png|webp)(\?|$)/i.test(u));
    return good.concat(urls.filter(u => !good.includes(u)));
  }
  if (platform === 'fb') {
    const v = (body && body.video) || {};
    return [v.thumbnail, body && body.image_url].filter(Boolean);
  }
  return [];
}

async function main() {
  if (!KEY) throw new Error('SCRAPECREATORS_API_KEY is not set.');
  if (!configured()) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');

  const where = ['thumbnail_url is null', 'coalesce(ig_link, tt_link, fb_link) is not null'];
  const params = [];
  if (args.brand) { params.push(args.brand); where.push(`brand_id = $${params.length}`); }
  const limit = args.limit ? `limit ${Number(args.limit)}` : '';

  const { rows } = await query(
    `select creative_id, brand_id, ig_link, fb_link, tt_link
       from creatives where ${where.join(' and ')}
      order by date desc nulls last ${limit}`, params);

  console.log(`${rows.length} creative(s) without a thumbnail${args.brand ? ` for ${args.brand}` : ''}.`);
  if (args.dry || !rows.length) return;

  let done = 0, failed = 0;
  for (const row of rows) {
    const [platform, link] = pickLink(row);
    try {
      const { data, status } = await axios.get(ENDPOINT[platform], {
        params: { url: link }, headers: { 'x-api-key': KEY },
        timeout: 60000, validateStatus: () => true,
      });
      if (status >= 400 || !data || data.success === false) {
        throw new Error((data && (data.error || data.message)) || `HTTP ${status}`);
      }
      const src = thumbFrom(platform, data);
      if (!src.length) throw new Error('no thumbnail in response');
      const url = await storeThumbnail(row.creative_id, src);
      if (!url) throw new Error('could not store');
      await query(`update creatives set thumbnail_url = $2 where creative_id = $1`, [row.creative_id, url]);
      done++;
      console.log(`  ok  ${row.creative_id}`);
    } catch (e) {
      failed++;
      console.log(`  --  ${row.creative_id}: ${e.message}`);
    }
  }
  console.log(`\nstored ${done}, failed ${failed}. Failed ones are usually deleted or private posts.`);
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());

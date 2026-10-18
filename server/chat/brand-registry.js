/**
 * Ask Lens — where the brand list comes from
 *
 * It used to be a hand-written array in schema.config.js. Six brands were
 * added in October and nobody edited that array, so assertBrand() THREW on
 * every one of them: the chat did not answer vaguely about Signal or Rexona,
 * it rejected the question outright. The same array also drives the prewarm
 * loop, so those six never got a snapshot built either.
 *
 * The brands table already knows the answer. This reads it, and keeps
 * reading it, so onboarding a brand is enough on its own.
 *
 * It mutates the arrays on the schema object in place rather than replacing
 * them, because every consumer holds a reference to S.brands from require
 * time and would otherwise keep pointing at the old array forever.
 */

const { query } = require('./db');
const S = require('./schema.config');

// How often to re-read. Brands are onboarded a handful of times a year, so
// this is about not needing a restart, not about freshness.
const REFRESH_MS = 10 * 60 * 1000;

let lastLoadedAt = null;

function titleCase(slug) {
  return String(slug).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function refreshBrands() {
  const { rows } = await query(
    `select brand_id, name from brands where is_active = true order by brand_id`
  );
  if (!rows.length) {
    // An empty result is far more likely to be a broken query or a database
    // blip than a client with no brands. Keeping the previous list is the
    // safe failure: a stale list still answers, an empty one rejects
    // everything, which is the exact bug this module exists to fix.
    console.warn('[chat/brands] brands table returned no active rows — keeping the previous list');
    return S.brands;
  }

  const slugs = rows.map(r => r.brand_id);
  const labels = {};
  for (const r of rows) labels[r.brand_id] = r.name || titleCase(r.brand_id);

  const added = slugs.filter(s => !S.brands.includes(s));
  const removed = S.brands.filter(s => !slugs.includes(s));

  // In place: see the note at the top.
  S.brands.length = 0;
  S.brands.push(...slugs);
  for (const k of Object.keys(S.brandLabels)) delete S.brandLabels[k];
  Object.assign(S.brandLabels, labels);

  lastLoadedAt = new Date();
  if (added.length || removed.length) {
    console.log(`[chat/brands] ${slugs.length} active`
      + (added.length ? ` · added ${added.join(', ')}` : '')
      + (removed.length ? ` · dropped ${removed.join(', ')}` : ''));
  }
  return S.brands;
}

// Called once at boot. Never rejects: a chat that answers for the brands in
// the config beats a server that will not start.
async function startBrandRegistry() {
  try {
    await refreshBrands();
  } catch (e) {
    console.error('[chat/brands] initial load failed, using the config list:', e.message);
  }
  const t = setInterval(() => {
    refreshBrands().catch(e => console.warn('[chat/brands] refresh failed:', e.message));
  }, REFRESH_MS);
  t.unref?.();
  return S.brands;
}

function brandRegistryStatus() {
  return { count: S.brands.length, brands: [...S.brands], lastLoadedAt };
}

module.exports = { refreshBrands, startBrandRegistry, brandRegistryStatus };

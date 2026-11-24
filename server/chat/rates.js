/**
 * Ask Lens - CQR Good rate, Hook Good rate and Hold Good rate.
 *
 * The figures come from server/cqr-rollup.js, the same code Media Summary
 * reads, so the assistant and the page can never disagree. This file only
 * turns them into records the markers can point at.
 *
 * Record ids carry everything needed to work the figure out again, so a
 * marker in an old answer still resolves:
 *
 *   rates:<from>:<to>:<campaign>:<platform>
 *     from, to   YYYY-MM-DD, or "all" for an open end
 *     campaign   "all", or the campaign name as a slug
 *     platform   combined | meta | tiktok
 *
 * e.g. rates:all:all:all:combined, rates:2026-01-01:2026-03-31:diwali-2026:meta
 */

const R = require('../cqr-rollup');

const PLATS = ['combined', 'meta', 'tiktok'];
const PLAT_LABEL = { combined: 'Meta and TikTok combined', meta: 'Meta', tiktok: 'TikTok' };
const ID_RE = /^rates:(all|\d{4}-\d{2}-\d{2}):(all|\d{4}-\d{2}-\d{2}):([a-z0-9-]{1,48}):(combined|meta|tiktok)$/;

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campaign';

function fmtDay(s) {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function rangeLabel(from, to) {
  if (!from && !to) return 'all time';
  if (from && to) return `${fmtDay(from)} to ${fmtDay(to)}`;
  return from ? `from ${fmtDay(from)}` : `up to ${fmtDay(to)}`;
}

const idFor = (from, to, camp, plat) => `rates:${from || 'all'}:${to || 'all'}:${camp}:${plat}`;

/** Campaign name to slug, unique within the brand. */
function slugMap(campaigns) {
  const used = new Set(['all']);
  const out = new Map();
  for (const c of campaigns) {
    let s = slugOf(c.name), base = s, n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    out.set(c.name, s);
  }
  return out;
}

/**
 * Every record for one brand and range: the brand overall and each
 * campaign, on each platform and combined.
 */
function recordsFrom(out) {
  const { from, to } = out;
  const when = rangeLabel(from, to);
  const records = {};
  const put = (campName, slug, block) => {
    for (const p of PLATS) {
      const id = idFor(from, to, slug, p);
      const scope = campName ? `${campName}, ${PLAT_LABEL[p]}, ${when}` : `All campaigns, ${PLAT_LABEL[p]}, ${when}`;
      records[id] = {
        id, kind: 'rates', name: scope, scope_label: scope,
        campaign: campName || null, platform: p, from, to, ...block[p],
      };
    }
  };
  put(null, 'all', out.overall);
  const slugs = slugMap(out.campaigns);
  for (const c of out.campaigns) put(c.name, slugs.get(c.name), c);
  return { records, slugs };
}

/** Resolve rates:... ids, for a marker that the answer's records did not carry. */
async function resolveIds(q, brand, ids) {
  const want = ids.map((id) => [id, ID_RE.exec(id)]).filter(([, m]) => m);
  const byRange = new Map();
  for (const [id, m] of want) {
    const key = `${m[1]}|${m[2]}`;
    if (!byRange.has(key)) byRange.set(key, []);
    byRange.get(key).push(id);
  }
  const out = {};
  for (const [key, list] of byRange) {
    const [f, t] = key.split('|');
    const res = await R.forBrand(q, brand, { from: f === 'all' ? null : f, to: t === 'all' ? null : t });
    const { records } = recordsFrom(res);
    for (const id of list) if (records[id]) out[id] = records[id];
  }
  return out;
}

const isRatesId = (id) => typeof id === 'string' && id.startsWith('rates:');

/** Compact figures for the model to reason with; the markers show them. */
function brief(r) {
  return {
    id: r.id, campaign: r.campaign || 'All campaigns', platform: r.platform,
    cqr_good_rate: r.cqr_good_rate, hook_good_rate: r.hook_good_rate, hold_good_rate: r.hold_good_rate,
    rated_share: r.rated_share, videos_rated: r.rated_n, videos: r.video_n,
    ...(r.paid_engagement_rate !== undefined ? {
      paid_engagement_rate: r.paid_engagement_rate, reach: r.reach, cost_per_engagement_lkr: r.cost_per_engagement,
      impressions_covered: r.eng_coverage, creatives_with_engagement: r.eng_creative_n, creatives: r.paid_creative_n,
    } : {}),
  };
}

/**
 * The paid_rates tool. Brand comes from the session. Campaign is a partial
 * match on the Campaign Lens campaign name.
 */
async function tool(args, ctx, q) {
  let res;
  try {
    res = await R.forBrand(q, ctx.brand, { from: args.from, to: args.to, period: args.period });
  } catch (e) {
    if (e.status === 400) return { result: { error: e.message }, records: {} };
    throw e;
  }
  const { records, slugs } = recordsFrom(res);
  const plats = args.platform && PLATS.includes(args.platform) ? [args.platform] : PLATS;
  let camps = [null];
  if (args.campaign) {
    const needle = String(args.campaign).toLowerCase();
    const hit = res.campaigns.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, 3);
    if (!hit.length) {
      return {
        result: { error: 'No campaign with paid delivery matches that name in this range.',
                  campaigns: res.campaigns.slice(0, 12).map((c) => c.name) },
        records: {},
      };
    }
    camps = hit.map((c) => c.name);
  }
  const rows = [];
  const keep = {};
  for (const c of camps) {
    for (const p of plats) {
      const id = idFor(res.from, res.to, c ? slugs.get(c) : 'all', p);
      if (!records[id]) continue;
      keep[id] = records[id];
      rows.push(brief(records[id]));
    }
  }
  const empty = rows.every((r) => !r.videos && !r.creatives);
  // Results stay small. Several campaigns on three platforms is too much,
  // so the platform split goes first and the combined rows stay.
  let shown = rows;
  if (JSON.stringify(rows).length > 1300) shown = rows.filter((r) => r.platform === 'combined');
  return {
    result: {
      range: rangeLabel(res.from, res.to),
      ...(res.reach && res.reach.status !== 'ok' ? { engagement_rate: res.reach.status === 'custom'
        ? 'Not available for this range: engagement rate is on true reach, which exists only for the periods all_time, this_year, last_30, this_month, last_month and single calendar months. Say so; do not estimate it.'
        : 'True reach for this period has not been fetched yet. Say engagement rate is not available yet.' } : {}),
      rows: shown,
      ...(shown.length < rows.length ? { trimmed: 'Only the combined rows are listed. Ask again with a platform for Meta or TikTok.' } : {}),
      note: empty
        ? 'No paid delivery in this range.'
        : 'Show each figure with [[metric:NAME|ID]] using the row id. NAME: cqr_good_rate, hook_good_rate, hold_good_rate, rated_share, paid_engagement_rate or cost_per_engagement. A null engagement figure means no engagement data for those days.',
    },
    records: keep,
  };
}

module.exports = { recordsFrom, resolveIds, isRatesId, tool, rangeLabel, ID_RE, slugOf };

/**
 * Engagement rate per creative, over its whole paid run on each platform.
 *
 *   engagement rate = engagements / true reach
 *
 * Reach is the number of different people who saw any of the creative's
 * ads on that platform, from the n8n Reach sync (paid_reach, period
 * 'lifetime'). Engagements are the sync's per-ad, per-day totals
 * (migration 046), added up over the same run.
 *
 * A rate is given only when every delivering day of the run has
 * engagement data: a creative whose early days were never read would
 * otherwise read low. Combined, for a creative on both platforms, is all
 * engagements over Meta reach plus TikTok reach, and only when both
 * platforms have a rate.
 *
 * Returns an empty map before 046 or 047 is run.
 */

const r2 = (v) => Math.round(v * 100) / 100;

async function forBrand(q, brandId) {
  let rows;
  try {
    ({ rows } = await q(
      `with e as (
         select 'meta'::text as platform, creative_id, sum(engagements)::numeric as eng,
                bool_and(engagements is not null) as complete
           from paid_meta
          where brand_id = $1 and creative_id is not null and coalesce(impressions, 0) > 0
          group by creative_id
         union all
         select 'tiktok'::text, creative_id, sum(engagements)::numeric, bool_and(engagements is not null)
           from paid_tiktok
          where brand_id = $1 and creative_id is not null and coalesce(impressions, 0) > 0
          group by creative_id
       )
       select e.platform, e.creative_id, e.eng, e.complete, r.reach
         from e
         left join paid_reach r
           on r.brand_id = $1 and r.platform = e.platform and r.creative_id = e.creative_id
          and r.campaign = '' and r.period = 'lifetime' and r.error is null`, [brandId]));
  } catch (e) {
    if (e && (e.code === '42703' || e.code === '42P01')) return new Map();
    throw e;
  }
  const out = new Map();
  for (const r of rows) {
    const reach = Number(r.reach) || 0;
    const eng = Number(r.eng) || 0;
    const rate = r.complete && reach > 0 ? r2((eng / reach) * 100) : null;
    if (!out.has(r.creative_id)) out.set(r.creative_id, {});
    out.get(r.creative_id)[r.platform] = { engagements: r.complete ? eng : null, reach: reach || null, rate };
  }
  for (const v of out.values()) {
    const plats = Object.values(v);
    const all = plats.length && plats.every((p) => p.rate !== null);
    const reach = plats.reduce((s, p) => s + (p.reach || 0), 0);
    const eng = plats.reduce((s, p) => s + (p.engagements || 0), 0);
    v.combined = { rate: all && reach > 0 ? r2((eng / reach) * 100) : null };
  }
  return out;
}

module.exports = { forBrand };

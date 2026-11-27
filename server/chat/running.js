/**
 * Running, for Ask Lens and its tools: the same rule as the Creative Hub
 * (paidExtras in creatives.js). A creative is running on a platform when
 * one of its ads delivered there in the last two days with an active status
 * that day. The lifetime views' is_active is any active day ever, so on its
 * own a paused ad would read as running for ever.
 */
const DAILY_FOR = { v_paid_meta_creative: 'v_paid_meta_scored', v_paid_tiktok_creative: 'v_paid_tiktok_scored' };

function runningExpr(view, P) {
  const daily = DAILY_FOR[view];
  if (!daily) return `${P.isActive}`;
  return `exists (select 1 from ${daily} d
             where d.creative_id = ${view}.${P.creativeId} and d.brand_id = ${view}.${P.brand}
               and d.date >= current_date - 2 and coalesce(d.impressions, 0) > 0
               and upper(coalesce(d.ad_status, '')) in ('ACTIVE', 'ENABLE'))`;
}

module.exports = { runningExpr };

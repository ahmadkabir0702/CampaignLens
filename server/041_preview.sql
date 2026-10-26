-- =====================================================================
--  041 preview: what "never harder than the brand's own results" would
--  do to every brand's ratings. Read only: changes nothing.
--
--  For each brand, on each bar (paid hook, paid hold, organic Brand Say
--  retention, creator bar), worked out from its own rated creatives:
--    Good:  at least half the brand's creatives must clear the Good line.
--           If fewer do, the brand's bar is scaled down until half do.
--    Poor:  no more than a quarter may fall below the Poor line. If more
--           do, it is scaled down until a quarter do. Poor always drops at
--           least as much as Good, so the Average band keeps its shape.
--  Hold and retention bars depend on video length, so each creative is
--  compared with the bar for its own length and the brand's creatives of
--  all lengths are pooled (8 needed; 5 for creator posts). A bar is only
--  ever lowered; a bar that is already easy is kept.
-- =====================================================================
with
-- ---------------- each rated value with the bar it is judged against ----
paid as (
  select v.brand_id, v.creative_id, c.type,
         'meta_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end as grp,
         'paid meta'::text as channel,
         v.hook_rate::numeric as hook, v.hold_rate::numeric as hold,
         v.duration_s::numeric as dur, v.cqr
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
   where v.cqr in ('Good', 'Average', 'Poor')
  union all
  select v.brand_id, v.creative_id, c.type,
         'tt_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end,
         'paid tiktok',
         v.hook_rate::numeric, v.hold_rate::numeric, v.duration_s::numeric, v.cqr
    from v_paid_tiktok_creative v join creatives c on c.creative_id = v.creative_id
   where v.cqr in ('Good', 'Average', 'Poor')
),
paid_b as (
  select p.*, hk.poor_lt as hk_p, hk.good_gte as hk_g, hd.poor_lt as hd_p, hd.good_gte as hd_g
    from paid p
    left join lateral thr(p.brand_id, p.grp, 'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(p.brand_id, p.grp, 'hold_rate', p.dur) as hd(poor_lt, good_gte) on true
),
bs as (
  select c.brand_id, s.creative_id, o.platform, o.platform || '_organic' as grp,
         (o.avg_watch_time / c.duration_s * 100)::numeric as ret, s.cqr,
         t.poor_lt as p, t.good_gte as g
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
    join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
    left join lateral thr(c.brand_id, o.platform || '_organic', 'retention_rate', c.duration_s::numeric) as t(poor_lt, good_gte) on true
   where c.type = 'Brand Say' and c.duration_s > 0 and o.avg_watch_time > 0
     and s.cqr in ('Good', 'Average', 'Poor')
),
os as (
  select c.brand_id, s.creative_id, o.platform, o.platform as grp,
         ((coalesce(o.likes, 0) + 2 * coalesce(o.comments, 0))::numeric / o.views * 100) as epv, s.cqr,
         b.poor_below as p, b.good_from as g
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
    join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
    left join lateral (select ob.poor_below, ob.good_from from cqr_os_benchmarks ob
                        where ob.platform = o.platform and (ob.brand_id = c.brand_id or ob.brand_id is null)
                        order by ob.brand_id nulls last limit 1) b on true
   where c.type = 'Others Say' and o.views > 0 and o.likes is not null
     and s.cqr in ('Good', 'Average', 'Poor')
),
-- ---------------- value as a share of its bar, one row per bar ----------
ratios as (
  select brand_id, grp, 'hook_rate'::text as metric, hook / hk_g as rg, hook / hk_p as rp, 8 as min_n
    from paid_b where hook > 0 and hk_g > 0 and hk_p > 0
  union all
  select brand_id, grp, 'hold_rate', hold / hd_g, hold / hd_p, 8
    from paid_b where hold > 0 and hd_g > 0 and hd_p > 0
  union all
  select brand_id, grp, 'retention_rate', ret / g, ret / p, 8
    from bs where ret > 0 and ret <= 100 and g > 0 and p > 0
  union all
  select brand_id, grp, 'creator', epv / g, epv / p, 5
    from os where epv > 0 and g > 0 and p > 0
),
factors as (
  select brand_id, grp, metric, count(*) as n,
         least(1, percentile_cont(0.50) within group (order by rg))::numeric as fg,
         least(1, percentile_cont(0.25) within group (order by rp),
                  percentile_cont(0.50) within group (order by rg))::numeric as fp
    from ratios
   group by brand_id, grp, metric, min_n
  having count(*) >= min_n
),
-- ---------------- ratings with the scaled bars --------------------------
paid_new as (
  select p.brand_id, p.channel, p.type, p.cqr as now_cqr,
         paid_cqr(
           band(p.hold, least(p.hd_p * coalesce(fh.fp, 1), p.hd_g * coalesce(fh.fg, 1)),
                        p.hd_g * coalesce(fh.fg, 1), 'No Hold Rate'),
           band(p.hook, least(p.hk_p * coalesce(fk.fp, 1), p.hk_g * coalesce(fk.fg, 1)),
                        p.hk_g * coalesce(fk.fg, 1), 'No Hook Rate')) as new_cqr
    from paid_b p
    left join factors fk on fk.brand_id = p.brand_id and fk.grp = p.grp and fk.metric = 'hook_rate'
    left join factors fh on fh.brand_id = p.brand_id and fh.grp = p.grp and fh.metric = 'hold_rate'
),
bs_new as (
  select b.brand_id, 'organic ' || b.platform as channel, 'Brand Say'::text as type, b.cqr as now_cqr,
         case when b.ret <  least(b.p * coalesce(f.fp, 1), b.g * coalesce(f.fg, 1)) then 'Poor'
              when b.ret >= b.g * coalesce(f.fg, 1) then 'Good'
              else 'Average' end as new_cqr
    from bs b
    left join factors f on f.brand_id = b.brand_id and f.grp = b.grp and f.metric = 'retention_rate'
),
os_new as (
  select o.brand_id, 'organic ' || o.platform as channel, 'Others Say'::text as type, o.cqr as now_cqr,
         case when o.epv <  least(o.p * coalesce(f.fp, 1), o.g * coalesce(f.fg, 1)) then 'Poor'
              when o.epv >= o.g * coalesce(f.fg, 1) then 'Good'
              else 'Average' end as new_cqr
    from os o
    left join factors f on f.brand_id = o.brand_id and f.grp = o.grp and f.metric = 'creator'
),
allr as (
  select * from paid_new union all select * from bs_new union all select * from os_new
)
select brand_id as brand, channel, type, count(*) as rated,
       count(*) filter (where now_cqr = 'Good')    as good_now,
       count(*) filter (where now_cqr = 'Average') as avg_now,
       count(*) filter (where now_cqr = 'Poor')    as poor_now,
       count(*) filter (where new_cqr = 'Good')    as good_after,
       count(*) filter (where new_cqr = 'Average') as avg_after,
       count(*) filter (where new_cqr = 'Poor')    as poor_after,
       count(*) filter (where new_cqr is distinct from now_cqr) as moved
  from allr
 group by 1, 2, 3
 order by 1, 2, 3;

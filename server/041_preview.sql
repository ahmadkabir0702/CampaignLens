-- =====================================================================
--  041 preview: what "never harder than the brand's own results" would
--  do to every brand's ratings. Read only: changes nothing.
--
--  Run this first. Each row is one brand, channel and type, with the
--  ratings now and the ratings after 041. Same rules as 041:
--    paid video and organic Brand Say: for each brand, Good can need no
--      more than the brand's own median, and Poor can start no higher
--      than the brand's own bottom quarter, for each bar (and each video
--      length for hold and retention). Needs 8 creatives, else unchanged.
--    creator posts (Others Say): the same, at the percentiles the creator
--      bars already use. Needs 5 posts.
--  A bar is only ever lowered. A bar that is already easy is kept.
-- =====================================================================
with
-- ---------------- paid video ----------------
paid as (
  select v.brand_id, v.creative_id, c.type,
         'meta_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end as grp,
         'paid meta'::text as channel,
         v.hook_rate::numeric as hook, v.hold_rate::numeric as hold,
         v.duration_s::numeric as dur, v.impressions, v.cqr
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
  union all
  select v.brand_id, v.creative_id, c.type,
         'tt_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end,
         'paid tiktok',
         v.hook_rate::numeric, v.hold_rate::numeric, v.duration_s::numeric, v.impressions, v.cqr
    from v_paid_tiktok_creative v join creatives c on c.creative_id = v.creative_id
),
gbands as (
  select platform as grp, metric, min_duration, max_duration
    from cqr_thresholds
   where brand_id is null and metric in ('hook_rate', 'hold_rate', 'retention_rate')
),
paid_vals as (
  select p.brand_id, b.grp, b.metric, b.min_duration, b.max_duration,
         case when b.metric = 'hook_rate' then p.hook else p.hold end as v
    from paid p
    join gbands b on b.grp = p.grp
     and (b.metric = 'hook_rate'
          or (b.metric = 'hold_rate' and p.dur >= coalesce(b.min_duration, 0)
              and (b.max_duration is null or p.dur < b.max_duration)))
   where p.cqr in ('Good', 'Average', 'Poor')
),
paid_caps as (
  select brand_id, grp, metric, min_duration, max_duration, count(*) as n,
         percentile_cont(0.25) within group (order by v)::numeric as cap_poor,
         percentile_cont(0.50) within group (order by v)::numeric as cap_good
    from paid_vals where v > 0
   group by 1, 2, 3, 4, 5
  having count(*) >= 8
),
paid_new as (
  select p.brand_id, p.channel, p.type, p.cqr as now_cqr,
         paid_cqr(
           band(p.hold, least(hd.poor_lt, hc.cap_poor, least(hd.good_gte, hc.cap_good)),
                        least(hd.good_gte, hc.cap_good), 'No Hold Rate'),
           band(p.hook, least(hk.poor_lt, kc.cap_poor, least(hk.good_gte, kc.cap_good)),
                        least(hk.good_gte, kc.cap_good), 'No Hook Rate')) as new_cqr
    from paid p
    left join lateral thr(p.brand_id, p.grp, 'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(p.brand_id, p.grp, 'hold_rate', p.dur) as hd(poor_lt, good_gte) on true
    left join lateral (select x.cap_poor, x.cap_good from paid_caps x
                        where x.brand_id = p.brand_id and x.grp = p.grp and x.metric = 'hook_rate'
                        limit 1) kc on true
    left join lateral (select x.cap_poor, x.cap_good from paid_caps x
                        where x.brand_id = p.brand_id and x.grp = p.grp and x.metric = 'hold_rate'
                          and p.dur >= coalesce(x.min_duration, 0)
                          and (x.max_duration is null or p.dur < x.max_duration)
                        limit 1) hc on true
   where p.cqr in ('Good', 'Average', 'Poor')
),
-- ---------------- organic Brand Say: retention ----------------
bs as (
  select c.brand_id, s.creative_id, o.platform, o.platform || '_organic' as grp,
         c.duration_s::numeric as dur,
         (o.avg_watch_time / c.duration_s * 100)::numeric as ret, s.cqr
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
    join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
   where c.type = 'Brand Say' and c.duration_s > 0 and o.avg_watch_time > 0
     and s.cqr in ('Good', 'Average', 'Poor')
),
bs_caps as (
  select b.brand_id, g.grp, g.min_duration, g.max_duration, count(*) as n,
         percentile_cont(0.25) within group (order by b.ret)::numeric as cap_poor,
         percentile_cont(0.50) within group (order by b.ret)::numeric as cap_good
    from bs b
    join gbands g on g.grp = b.grp and g.metric = 'retention_rate'
     and b.dur >= coalesce(g.min_duration, 0) and (g.max_duration is null or b.dur < g.max_duration)
   where b.ret <= 100
   group by 1, 2, 3, 4
  having count(*) >= 8
),
bs_new as (
  select b.brand_id, 'organic ' || b.platform as channel, 'Brand Say'::text as type, b.cqr as now_cqr,
         case when b.ret <  least(t.poor_lt, x.cap_poor, least(t.good_gte, x.cap_good)) then 'Poor'
              when b.ret >= least(t.good_gte, x.cap_good) then 'Good'
              else 'Average' end as new_cqr
    from bs b
    left join lateral thr(b.brand_id, b.grp, 'retention_rate', b.dur) as t(poor_lt, good_gte) on true
    left join lateral (select y.cap_poor, y.cap_good from bs_caps y
                        where y.brand_id = b.brand_id and y.grp = b.grp
                          and b.dur >= coalesce(y.min_duration, 0)
                          and (y.max_duration is null or b.dur < y.max_duration)
                        limit 1) x on true
),
-- ---------------- organic Others Say: creator bar ----------------
os as (
  select c.brand_id, s.creative_id, o.platform,
         ((coalesce(o.likes, 0) + 2 * coalesce(o.comments, 0))::numeric / o.views * 100) as epv, s.cqr
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
    join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
   where c.type = 'Others Say' and o.views > 0 and o.likes is not null
     and s.cqr in ('Good', 'Average', 'Poor')
),
os_caps as (
  select o.brand_id, o.platform, count(*) as n,
         percentile_cont(g.poor_pct) within group (order by o.epv)::numeric as cap_poor,
         percentile_cont(g.good_pct) within group (order by o.epv)::numeric as cap_good
    from os o join cqr_os_benchmarks g on g.platform = o.platform and g.brand_id is null
   group by o.brand_id, o.platform, g.poor_pct, g.good_pct
  having count(*) >= 5
),
os_new as (
  select o.brand_id, 'organic ' || o.platform as channel, 'Others Say'::text as type, o.cqr as now_cqr,
         case when o.epv <  least(b.poor_below, x.cap_poor, least(b.good_from, x.cap_good)) then 'Poor'
              when o.epv >= least(b.good_from, x.cap_good) then 'Good'
              else 'Average' end as new_cqr
    from os o
    left join lateral (select ob.poor_below, ob.good_from from cqr_os_benchmarks ob
                        where ob.platform = o.platform and (ob.brand_id = o.brand_id or ob.brand_id is null)
                        order by ob.brand_id nulls last limit 1) b on true
    left join os_caps x on x.brand_id = o.brand_id and x.platform = o.platform
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

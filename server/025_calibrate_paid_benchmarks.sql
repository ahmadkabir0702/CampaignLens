-- =====================================================================
--  025 — set the global paid benchmarks from your own results
--
--  The global hook and hold bars were not set from Sri Lankan data, and
--  the hold bars could not be met: hold is counted against all
--  impressions, so it is always lower than the hook rate, yet the global
--  hold bar for short videos (25%) was higher than the hook bar (10%).
--  Most creatives read Poor on hold whatever they did.
--
--  This sets every global paid band from the lifetime results of your own
--  creatives with at least 10,000 impressions:
--
--    Good  from the 60th percentile   (the top 40% clear it)
--    Poor  below the 25th percentile  (the bottom quarter)
--
--  Worked out separately for Meta and TikTok, Brand Say and Others Say,
--  and for hold, each video length. Where a group has fewer than 8
--  creatives, Brand Say and Others Say are pooled for it; if that is still
--  under 8, the band is left as it is.
--
--  Only the global rows change. Brand rows (Vaseline, Knorr, Sunsilk) are
--  not touched. The numbers are fixed once set; they do not drift as new
--  creatives come in. Run this again later to re-set them from newer data.
--
--  Run after 023. The result lists every band, old and new.
-- =====================================================================

begin;

drop table if exists _paid_rates;
create temp table _paid_rates as
  select 'meta'::text as plat,
         case when c.type = 'Others Say' then 'os' else 'bs' end as typ,
         v.hook_rate::numeric as hook, v.hold_rate::numeric as hold, v.duration_s::numeric as dur
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
   where v.impressions >= 10000
  union all
  select 'tt',
         case when c.type = 'Others Say' then 'os' else 'bs' end,
         v.hook_rate::numeric, v.hold_rate::numeric, v.duration_s::numeric
    from v_paid_tiktok_creative v join creatives c on c.creative_id = v.creative_id
   where v.impressions >= 10000;

drop table if exists _bands_old;
create temp table _bands_old as
  select platform, metric, min_duration, poor_lt, good_gte
    from cqr_thresholds
   where brand_id is null
     and platform in ('meta_paid_bs', 'meta_paid_os', 'tt_paid_bs', 'tt_paid_os');

-- One target per global row: which platform, type, metric and length.
drop table if exists _targets;
create temp table _targets as
  select t.platform || '|' || t.metric || '|' || coalesce(t.min_duration::text, '') as id,
         t.platform, t.metric, t.min_duration, t.max_duration,
         split_part(t.platform, '_', 1) as plat,
         split_part(t.platform, '_', 3) as typ
    from cqr_thresholds t
   where t.brand_id is null
     and t.platform in ('meta_paid_bs', 'meta_paid_os', 'tt_paid_bs', 'tt_paid_os')
     and t.metric in ('hook_rate', 'hold_rate');

drop table if exists _calc;
create temp table _calc as
with samples as (
  -- the creatives each band is set from, own type first
  select g.id, 'own' as scope, r.*
    from _targets g
    join _paid_rates r
      on r.plat = g.plat and r.typ = g.typ
     and (g.metric = 'hook_rate'
          or (r.dur >= coalesce(g.min_duration, 0)
              and (g.max_duration is null or r.dur < g.max_duration)))
  union all
  -- and both types together, as the fallback for a small group
  select g.id, 'pooled', r.*
    from _targets g
    join _paid_rates r
      on r.plat = g.plat
     and (g.metric = 'hook_rate'
          or (r.dur >= coalesce(g.min_duration, 0)
              and (g.max_duration is null or r.dur < g.max_duration)))
),
vals as (
  select s.id, s.scope,
         case when g.metric = 'hook_rate' then s.hook else s.hold end as v
    from samples s join _targets g on g.id = s.id
),
stats as (
  select id, scope, count(*) as n,
         percentile_cont(0.25) within group (order by v) as p25,
         percentile_cont(0.60) within group (order by v) as p60
    from vals where v > 0
   group by id, scope
)
select g.id,
       coalesce(o.n, 0) as n_own, coalesce(p.n, 0) as n_pooled,
       case when o.n >= 8 then 'own' when p.n >= 8 then 'pooled' else 'unchanged' end as basis,
       case when o.n >= 8 then o.p25 when p.n >= 8 then p.p25 end as p25,
       case when o.n >= 8 then o.p60 when p.n >= 8 then p.p60 end as p60
  from _targets g
  left join stats o on o.id = g.id and o.scope = 'own'
  left join stats p on p.id = g.id and p.scope = 'pooled';

update cqr_thresholds t
   set good_gte = round(c.p60::numeric, 1),
       poor_lt  = least(round(c.p25::numeric, 1), round(c.p60::numeric * 0.9, 1))
  from _calc c
 where t.brand_id is null
   and t.platform || '|' || t.metric || '|' || coalesce(t.min_duration::text, '') = c.id
   and c.basis <> 'unchanged' and c.p60 > 0;

commit;

select t.platform, t.metric,
       case when t.metric = 'hook_rate' then 'all lengths'
            when t.max_duration is null then coalesce(t.min_duration::text, '0') || 's and over'
            else coalesce(t.min_duration::text, '0') || ' to ' || t.max_duration::text || 's' end as length,
       c.basis as set_from, case c.basis when 'own' then c.n_own when 'pooled' then c.n_pooled end as creatives,
       o.poor_lt as old_poor_below, o.good_gte as old_good_from,
       t.poor_lt as new_poor_below, t.good_gte as new_good_from
  from cqr_thresholds t
  join _calc c on c.id = t.platform || '|' || t.metric || '|' || coalesce(t.min_duration::text, '')
  left join _bands_old o on o.platform = t.platform and o.metric = t.metric
                        and o.min_duration is not distinct from t.min_duration
 where t.brand_id is null
 order by t.platform, t.metric desc, t.min_duration nulls first;

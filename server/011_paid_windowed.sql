-- =====================================================================
--  011_paid_windowed.sql — the same rating, over windows of time
--
--  paid_meta and paid_tiktok already hold one row per ad per day, with
--  the 3-second views, the quartiles and the watch time. The lifetime
--  views roll that up and the roll-up hides decay two ways:
--
--    1. The lifetime CQR is (array_agg(cqr ORDER BY rank))[1], the BEST
--       single day the creative ever had. One Good day in week one keeps
--       it Good forever.
--    2. The lifetime rates are unweighted day averages, so seventy days
--       of history drown last week entirely.
--
--  This view applies the same grading to slices of time instead. Every
--  window is scored the same way as every other window, so "Good at
--  launch, Average now" is a real comparison and not an artefact of two
--  different methods.
--
--  Windows are relative to the creative's OWN run, not to today, so a
--  creative that stopped three weeks ago still has a readable final
--  week rather than an empty one. is_current says whether the last day
--  is recent enough to read as "now".
--
--  Safe to run more than once.
-- =====================================================================

create or replace view v_paid_windowed as
with daily as (
  select brand_id, creative_id, 'meta'::text as platform, date, impressions, spend, currency,
         hook_rate, hold_rate, duration_s, type, ad_status
    from v_paid_meta_scored
   where creative_id is not null
  union all
  select brand_id, creative_id, 'tiktok'::text, date, impressions, spend, currency,
         hook_rate, hold_rate, duration_s, type, ad_status
    from v_paid_tiktok_scored
   where creative_id is not null
),
bounds as (
  select creative_id, platform,
         min(date) as first_day,
         max(date) as last_day
    from daily
   group by creative_id, platform
),
sliced as (
  select d.*, b.first_day, b.last_day, w.name as window_name
    from daily d
    join bounds b on b.creative_id = d.creative_id and b.platform = d.platform
   cross join (values ('last_7'), ('prev_7'), ('first_7'), ('lifetime')) as w(name)
   where case w.name
           when 'last_7'  then d.date >  b.last_day - 7
           when 'prev_7'  then d.date <= b.last_day - 7 and d.date > b.last_day - 14
           when 'first_7' then d.date <  b.first_day + 7
           else true
         end
),
agg as (
  select brand_id, creative_id, platform, window_name,
         max(type)                as type,
         max(duration_s)          as duration_s,
         min(date)                as from_date,
         max(date)                as to_date,
         max(last_day)            as last_day,
         count(*)                 as days,
         sum(impressions)         as impressions,
         sum(to_lkr(spend, currency, date)) as spend,
         bool_or(upper(ad_status) = any (array['ACTIVE','ENABLE'])) as is_active,
         -- Averaged the same way the lifetime views do it, so the only
         -- thing that differs between a window and the lifetime figure
         -- is which days went into it.
         avg(hook_rate) filter (where hook_rate > 0) as hook_rate,
         avg(hold_rate) filter (where hold_rate > 0) as hold_rate
    from sliced
   group by brand_id, creative_id, platform, window_name
)
select a.brand_id,
       a.creative_id,
       a.platform,
       a.window_name,
       a.from_date,
       a.to_date,
       a.days,
       a.impressions,
       a.spend,
       a.is_active,
       a.duration_s,
       a.hook_rate,
       a.hold_rate,
       -- Fresh enough to read as "now". Two days of slack covers a
       -- pipeline that has not run yet this morning.
       (a.last_day >= current_date - 2) as is_current,
       band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q,
       case when a.duration_s is null then 'No Duration'
            else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
       paid_cqr(
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate')
       ) as cqr
  from agg a
  left join lateral thr(a.brand_id,
         case a.platform when 'meta' then 'meta_paid' else 'tt_paid' end
           || case when a.type = 'Others Say' then '_os' else '_bs' end,
         'hook_rate') as hk(poor_lt, good_gte) on true
  left join lateral thr(a.brand_id,
         case a.platform when 'meta' then 'meta_paid' else 'tt_paid' end
           || case when a.type = 'Others Say' then '_os' else '_bs' end,
         'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true;

comment on view v_paid_windowed is
  'One row per creative, platform and time window (last_7, prev_7, first_7, lifetime), graded with the same band/thr/paid_cqr functions as the daily rows. Windows are relative to the creative own run, not to today; is_current says whether the last day is recent.';

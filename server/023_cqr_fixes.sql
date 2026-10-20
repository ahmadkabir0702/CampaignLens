-- =====================================================================
--  023 — CQR fixes
--
--  1. Paid CQR is rated on the creative's overall result, not its best day.
--     The lifetime views used to grade every day separately and keep the
--     best one, so one Good day kept a creative Good for good. Rates are now
--     weighted by impressions across the whole run and graded once. Under
--     10,000 impressions the rating reads 'Low Delivery' instead of a grade.
--     v_paid_windowed uses the same weighting, so a window and the lifetime
--     figure are worked out the same way.
--
--  2. 43 benchmark rows that no rule reads are moved to
--     cqr_thresholds_retired (kept, not lost):
--       engagement_rate and avg_watch_time rows (nothing rates on them)
--       ig_os / fb_os / tt_os retention rows (Others Say is rated against
--         cqr_os_benchmarks, not these)
--       meta_paid / tt_paid without _bs or _os (the views only read the
--         suffixed rows)
--
--  3. Global benchmarks get a real Average band. The Good marks are kept
--     where they were; Poor now starts at about 70% of Good instead of one
--     point below it. Organic Brand Say retention gets video-length bands,
--     the same lengths the paid hold rate uses. Brand rows (Vaseline, Knorr)
--     are not touched.
--
--  4. Photo and carousel benchmarks, set for Sri Lanka, with Instagram
--     carousels held to a slightly higher mark than single photos.
--
--  5. cqr_history gets a reason column. The rule change is recorded once as
--     'rule change' so the nightly job does not read it as every creative
--     moving rating overnight.
--
--  The last result is a before and after count of ratings.
--  Safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  Ratings as they stand, for the comparison at the end
-- ---------------------------------------------------------------------
drop table if exists _cqr_before;
create temp table _cqr_before as
  select 'paid'::text as channel, 'meta'::text as platform, c.type, v.creative_id, v.cqr
    from v_paid_meta_creative v left join creatives c on c.creative_id = v.creative_id
   where v.creative_id is not null
  union all
  select 'paid', 'tiktok', c.type, v.creative_id, v.cqr
    from v_paid_tiktok_creative v left join creatives c on c.creative_id = v.creative_id
   where v.creative_id is not null
  union all
  select 'organic', s.platform, s.type, s.creative_id, s.cqr
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
   where coalesce(c.content_type, 'Video') not in ('Photo', 'Carousel');


-- ---------------------------------------------------------------------
--  2. Retire the rows no rule reads
-- ---------------------------------------------------------------------
create table if not exists cqr_thresholds_retired as
  select t.*, now() as retired_at, ''::text as retired_why from cqr_thresholds t where false;

with gone as (
  delete from cqr_thresholds
   where metric in ('engagement_rate', 'avg_watch_time')
      or (metric = 'retention_rate' and platform in ('ig_os', 'fb_os', 'tt_os'))
      or platform in ('meta_paid', 'tt_paid')
  returning *
)
insert into cqr_thresholds_retired
select g.*, now(),
       case
         when g.metric in ('engagement_rate', 'avg_watch_time') then 'No rule rates on this metric'
         when g.platform in ('ig_os', 'fb_os', 'tt_os') then 'Others Say organic is rated against cqr_os_benchmarks'
         else 'Paid views read the _bs and _os rows only'
       end
  from gone g;

comment on table cqr_thresholds_retired is
  'Benchmark rows taken out of cqr_thresholds by migration 023 because no rating rule read them. Kept for reference; copy a row back to use it.';


-- ---------------------------------------------------------------------
--  3. Global benchmarks (brand_id null). Brand rows are left alone.
-- ---------------------------------------------------------------------
delete from cqr_thresholds
 where brand_id is null
   and (   (platform in ('meta_paid_bs', 'meta_paid_os', 'tt_paid_bs', 'tt_paid_os')
            and metric in ('hook_rate', 'hold_rate'))
        or (platform in ('ig_organic', 'fb_organic', 'tt_organic') and metric = 'retention_rate'));

insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select null, p.platform, v.metric, v.min_d, v.max_d, v.poor_lt, v.good_gte
  from (values ('_bs'), ('_os')) as s(sfx)
 cross join lateral (values ('meta_paid' || s.sfx), ('tt_paid' || s.sfx)) as p(platform)
 cross join lateral (
   select * from (values
     -- Meta: hook is 3-second views per impression
     ('meta', 'hook_rate', null::numeric, null::numeric,  7.0, 10.0),
     ('meta', 'hold_rate',  0,  10, 17.5, 25.0),
     ('meta', 'hold_rate', 10,  15, 13.0, 19.0),
     ('meta', 'hold_rate', 15,  60, 10.5, 15.0),
     ('meta', 'hold_rate', 60, null,  5.0,  7.0),
     -- TikTok: hook is 2-second views per impression
     ('tt',   'hook_rate', null, null, 21.0, 30.0),
     ('tt',   'hold_rate',  0,  10, 10.5, 15.0),
     ('tt',   'hold_rate', 10,  15,  8.5, 12.0),
     ('tt',   'hold_rate', 15,  60,  7.0, 10.0),
     ('tt',   'hold_rate', 60, null,  5.0,  7.0)
   ) as x(plat, metric, min_d, max_d, poor_lt, good_gte)
   where p.platform like x.plat || '%'
 ) v;

-- Organic Brand Say: average watch time as a share of the video's length.
-- A short video is easier to watch through, so its mark is higher.
insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte) values
  (null, 'ig_organic', 'retention_rate',  0,   15, 17.5, 25),
  (null, 'ig_organic', 'retention_rate', 15,   30, 12.5, 18),
  (null, 'ig_organic', 'retention_rate', 30,   60, 10.5, 15),
  (null, 'ig_organic', 'retention_rate', 60, null,  7.0, 10),
  (null, 'fb_organic', 'retention_rate',  0,   15, 17.5, 25),
  (null, 'fb_organic', 'retention_rate', 15,   30, 14.0, 20),
  (null, 'fb_organic', 'retention_rate', 30,   60, 11.0, 16),
  (null, 'fb_organic', 'retention_rate', 60, null,  8.5, 12),
  (null, 'tt_organic', 'retention_rate',  0,   15, 10.5, 15),
  (null, 'tt_organic', 'retention_rate', 15,   30,  7.0, 10),
  (null, 'tt_organic', 'retention_rate', 30,   60,  5.5,  8),
  (null, 'tt_organic', 'retention_rate', 60, null,  4.0,  6);


-- ---------------------------------------------------------------------
--  4. Photo and carousel benchmarks
--
--  content_type null applies to photos and carousels alike; a row for
--  'Carousel' or 'Photo' wins over it. Brand rows win over global ones.
--
--    Brand Say   (likes + comments + shares + saves) per person reached,
--                or per view where there is no reach
--    Others Say  (likes + 2 x comments) per view, or per follower where
--                the post has no public views
-- ---------------------------------------------------------------------
alter table static_thresholds add column if not exists content_type text;
drop index if exists static_thresholds_key;
create unique index static_thresholds_key
  on static_thresholds (coalesce(brand_id, ''), platform, creative_type, basis, coalesce(content_type, ''));

delete from static_thresholds where brand_id is null;
insert into static_thresholds (brand_id, platform, creative_type, basis, content_type, good_gte, poor_lt) values
  (null, 'ig', 'Brand Say',  'reach',     null,       3,   1),
  (null, 'ig', 'Brand Say',  'reach',     'Carousel', 4,   1.5),
  (null, 'ig', 'Brand Say',  'views',     null,       2,   0.7),
  (null, 'ig', 'Brand Say',  'views',     'Carousel', 2.5, 1),
  (null, 'fb', 'Brand Say',  'reach',     null,       2,   0.5),
  (null, 'fb', 'Brand Say',  'views',     null,       1.5, 0.4),
  (null, 'tt', 'Brand Say',  'reach',     null,       5,   2),
  (null, 'tt', 'Brand Say',  'views',     null,       4,   1.5),
  (null, 'ig', 'Others Say', 'followers', null,       1.5, 0.4),
  (null, 'ig', 'Others Say', 'followers', 'Carousel', 2,   0.5),
  (null, 'ig', 'Others Say', 'views',     null,       3,   0.8),
  (null, 'fb', 'Others Say', 'followers', null,       0.3, 0.05),
  (null, 'fb', 'Others Say', 'views',     null,       2,   0.5),
  (null, 'tt', 'Others Say', 'followers', null,       2,   0.5),
  (null, 'tt', 'Others Say', 'views',     null,       5,   2);

comment on column static_thresholds.content_type is
  'Photo or Carousel for a row that applies to one of them; null for both.';


-- ---------------------------------------------------------------------
--  1. Paid CQR on the overall result
--
--  Rates are weighted by impressions, so a day with 200 impressions counts
--  for less than a day with 200,000. The rating is then worked out once,
--  from those rates, against the same thresholds as before.
-- ---------------------------------------------------------------------
create or replace view v_paid_meta_creative as
with agg as (
  select s.brand_id,
         s.creative_id,
         sum(to_lkr(s.spend, s.currency, s.date)) as spend,
         sum(s.spend)                             as spend_raw,
         max(s.currency)                          as currency,
         max(s.reach)                             as reach,
         sum(s.impressions)                       as impressions,
         sum(s.hook_rate * s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0), 0) as hook_rate,
         sum(s.hold_rate * s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0), 0) as hold_rate,
         sum(s.vtr_percent * s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0), 0) as vtr,
         sum(s.avg_watch_time * s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0), 0) as avg_watch_time,
         sum(s.w25 * s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0), 0) as w25,
         sum(s.w50 * s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0), 0) as w50,
         sum(s.w75 * s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0), 0) as w75,
         sum(s.w100 * s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0), 0) as w100,
         max(s.duration_s)                        as duration_s,
         max(s.type)                              as type,
         bool_or(upper(s.ad_status) = any (array['ACTIVE', 'ENABLE'])) as is_active
    from v_paid_meta_scored s
   group by s.brand_id, s.creative_id
),
graded as (
  select a.*,
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q
    from agg a
    left join lateral thr(a.brand_id,
           'meta_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(a.brand_id,
           'meta_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true
)
select g.brand_id, g.creative_id, g.spend, g.spend_raw, g.currency, g.reach, g.impressions,
       g.hook_rate, g.hold_rate, g.vtr, g.avg_watch_time, g.w25, g.w50, g.w75, g.w100,
       g.duration_s, g.is_active, g.hold_q, g.hook_q,
       case when paid_cqr(g.hold_q, g.hook_q) in ('Good', 'Average', 'Poor')
             and coalesce(g.impressions, 0) < 10000 then 'Low Delivery'
            else paid_cqr(g.hold_q, g.hook_q) end as cqr,
       r.recommendation, r.action_status, r.actioned_by, r.action_date, r.agency,
       r.verdict, r.working, r.not_working, r.action, r.action_type, r.priority,
       r.evidence, r.confidence
  from graded g
  left join recommendations r on r.creative_id = g.creative_id and r.platform = 'meta';

comment on view v_paid_meta_creative is
  'One row per creative on Meta. Rates are impression-weighted over the whole run and graded once (migration 023). Under 10,000 impressions the cqr reads Low Delivery.';

create or replace view v_paid_tiktok_creative as
with agg as (
  select s.brand_id,
         s.creative_id,
         sum(to_lkr(s.spend, s.currency, s.date)) as spend,
         sum(s.spend)                             as spend_raw,
         max(s.currency)                          as currency,
         max(s.reach)                             as reach,
         sum(s.impressions)                       as impressions,
         sum(s.hook_rate * s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0), 0) as hook_rate,
         sum(s.hold_rate * s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0), 0) as hold_rate,
         sum(s.vtr_percent * s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0), 0) as vtr,
         sum(s.avg_watch_time * s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0), 0) as avg_watch_time,
         sum(s.w25 * s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0), 0) as w25,
         sum(s.w50 * s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0), 0) as w50,
         sum(s.w75 * s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0), 0) as w75,
         sum(s.w100 * s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0), 0) as w100,
         max(s.duration_s)                        as duration_s,
         max(s.type)                              as type,
         bool_or(upper(s.ad_status) = any (array['ACTIVE', 'ENABLE'])) as is_active
    from v_paid_tiktok_scored s
   group by s.brand_id, s.creative_id
),
graded as (
  select a.*,
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q
    from agg a
    left join lateral thr(a.brand_id,
           'tt_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(a.brand_id,
           'tt_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true
)
select g.brand_id, g.creative_id, g.spend, g.spend_raw, g.currency, g.reach, g.impressions,
       g.hook_rate, g.hold_rate, g.vtr, g.avg_watch_time, g.w25, g.w50, g.w75, g.w100,
       g.duration_s, g.is_active, g.hold_q, g.hook_q,
       case when paid_cqr(g.hold_q, g.hook_q) in ('Good', 'Average', 'Poor')
             and coalesce(g.impressions, 0) < 10000 then 'Low Delivery'
            else paid_cqr(g.hold_q, g.hook_q) end as cqr,
       r.recommendation, r.action_status, r.actioned_by, r.action_date, r.agency,
       r.verdict, r.working, r.not_working, r.action, r.action_type, r.priority,
       r.evidence, r.confidence
  from graded g
  left join recommendations r on r.creative_id = g.creative_id and r.platform = 'tiktok';

comment on view v_paid_tiktok_creative is
  'One row per creative on TikTok. Rates are impression-weighted over the whole run and graded once (migration 023). Under 10,000 impressions the cqr reads Low Delivery.';

-- The windows, weighted the same way.
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
  select creative_id, platform, min(date) as first_day, max(date) as last_day
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
         -- Weighted by impressions, the same way the lifetime views do it.
         sum(hook_rate * impressions::numeric) filter (where hook_rate > 0 and impressions > 0)
           / nullif(sum(impressions::numeric) filter (where hook_rate > 0 and impressions > 0), 0) as hook_rate,
         sum(hold_rate * impressions::numeric) filter (where hold_rate > 0 and impressions > 0)
           / nullif(sum(impressions::numeric) filter (where hold_rate > 0 and impressions > 0), 0) as hold_rate
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


-- ---------------------------------------------------------------------
--  5. Record the rule change once, so it is not read as ratings moving
-- ---------------------------------------------------------------------
alter table cqr_history add column if not exists reason text;
comment on column cqr_history.reason is
  'Null for a rating that moved on its own. ''rule change'' for a row written when the rating rules or benchmarks changed; screens leave these out.';

insert into cqr_history
  (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
   hook_rate, hold_rate, impressions, spend, is_first, reason)
select c.creative_id, c.brand_id, c.channel, c.platform, c.cqr, c.cqr_lifetime,
       c.hook_rate, c.hold_rate, c.impressions, c.spend, (l.creative_id is null), 'rule change'
  from (
    select w.creative_id, w.brand_id, 'paid'::text as channel, w.platform,
           w.cqr, w.hook_rate, w.hold_rate, w.impressions, w.spend,
           coalesce(m.cqr, t.cqr) as cqr_lifetime
      from v_paid_windowed w
      left join v_paid_meta_creative   m on w.platform = 'meta'   and m.creative_id = w.creative_id
      left join v_paid_tiktok_creative t on w.platform = 'tiktok' and t.creative_id = w.creative_id
     where w.window_name = 'last_7' and w.impressions >= 1000
    union all
    select s.creative_id, c.brand_id, 'organic', s.platform,
           s.cqr, null, null, o.views, null, s.cqr
      from v_organic_scored s
      join creatives c on c.creative_id = s.creative_id
      join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
  ) c
  left join v_cqr_latest l
    on l.creative_id = c.creative_id and l.channel = c.channel and l.platform = c.platform
 where l.creative_id is not null
   and (l.cqr is distinct from c.cqr or l.cqr_lifetime is distinct from c.cqr_lifetime);

commit;


-- ---------------------------------------------------------------------
--  Before and after
-- ---------------------------------------------------------------------
with after as (
  select 'paid'::text as channel, 'meta'::text as platform, c.type, v.creative_id, v.cqr
    from v_paid_meta_creative v left join creatives c on c.creative_id = v.creative_id
   where v.creative_id is not null
  union all
  select 'paid', 'tiktok', c.type, v.creative_id, v.cqr
    from v_paid_tiktok_creative v left join creatives c on c.creative_id = v.creative_id
   where v.creative_id is not null
  union all
  select 'organic', s.platform, s.type, s.creative_id, s.cqr
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
   where coalesce(c.content_type, 'Video') not in ('Photo', 'Carousel')
),
counts as (
  select channel, platform, coalesce(type, 'Not in the Hub') as type, cqr, 'before' as wh from _cqr_before
  union all
  select channel, platform, coalesce(type, 'Not in the Hub'), cqr, 'after' from after
)
select channel, platform, type, coalesce(cqr, '(none)') as rating,
       count(*) filter (where wh = 'before') as before,
       count(*) filter (where wh = 'after')  as after
  from counts
 group by channel, platform, type, cqr
 order by channel desc, platform, type,
          case cqr when 'Good' then 0 when 'Average' then 1 when 'Poor' then 2 else 3 end, cqr;

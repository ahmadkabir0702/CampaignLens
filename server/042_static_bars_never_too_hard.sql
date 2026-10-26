-- =====================================================================
--  042: photo and carousel bars are never harder than the brand's own
--  results
--
--  041 applied the "never too hard" rule (26 Oct 2026) to video. Photos
--  and carousels are rated in the app (server/static-rating.js) against
--  static_thresholds, which still held the starting values from 022/023,
--  never checked against real posts. This applies the same rule to them:
--
--    Brand Say   engagement per reach (or per view where there is no reach)
--    Others Say  (likes + 2 x comments) per view (or per follower)
--
--  Per brand, platform and type, from its own rated posts (all bases and
--  both formats pooled, each post compared with the bar it is rated on):
--    Good: at least half must clear it, otherwise scaled down until half do.
--    Poor: no more than a quarter below it, otherwise scaled down until a
--          quarter are, and always by at least as much as Good.
--  Needs 8 rated posts. A bar is only ever lowered.
--
--  Stored as brand rows in static_thresholds, one for every basis and
--  format the brand can be rated on for that platform and type. Rows the
--  brand had before go to static_thresholds_retired. One-off fix to the
--  2026 bars, noted in cqr_bar_years and added to the 2026 copy.
--
--  Run server/042_preview.sql first. Safe to re-run.
-- =====================================================================

begin;

create table if not exists static_thresholds_retired as
  select t.*, now() as retired_at, ''::text as retired_why from static_thresholds t where false;

-- Every rated static, with the bar it is rated on now
drop table if exists _st_rated;
create temp table _st_rated as
with
st as (
  select c.brand_id, c.creative_id, c.type, c.content_type, o.platform,
         o.likes::numeric as likes, coalesce(o.comments, 0)::numeric as comments,
         nullif(o.views, 0)::numeric as views, nullif(o.reach, 0)::numeric as reach,
         nullif(o.followers, 0)::numeric as followers,
         case when coalesce(o.total_interactions, 0) > 0 then o.total_interactions::numeric
              else coalesce(o.likes, 0) + coalesce(o.comments, 0) + coalesce(o.shares, 0) + coalesce(o.saves, 0)
         end as eng,
         coalesce(o.time_posted, c.date::timestamptz) as posted
    from creatives c join organic_perf o on o.creative_id = c.creative_id
   where c.content_type in ('Photo', 'Carousel') and c.type in ('Brand Say', 'Others Say')
),
sig as (
  select s.*,
         case when s.type = 'Others Say' then
                case when s.views is not null then 'views' when s.followers is not null then 'followers' end
              else
                case when s.reach is not null then 'reach' when s.views is not null then 'views' end
         end as basis,
         case when s.type = 'Others Say' then
                (s.likes + 2 * s.comments) / coalesce(s.views, s.followers) * 100
              else s.eng / coalesce(s.reach, s.views) * 100
         end as v
    from st s
   where s.likes is not null
     and (s.posted is null or s.posted < now() - interval '24 hours')
)
select g.brand_id, g.creative_id, g.type, g.content_type, g.platform, g.basis, g.v,
       b.poor_lt as p, b.good_gte as gd,
       case when g.v >= b.good_gte then 'Good' when g.v < b.poor_lt then 'Poor' else 'Average' end as cqr
  from sig g
  cross join lateral (
    select t.poor_lt, t.good_gte from static_thresholds t
     where t.platform = g.platform and t.creative_type = g.type and t.basis = g.basis
       and (t.content_type is null or t.content_type = g.content_type)
       and (t.brand_id = g.brand_id or t.brand_id is null)
     order by (t.brand_id is null), (t.content_type is null)
     limit 1) b
 where g.basis is not null and g.v is not null;

drop table if exists _st_factors;
create temp table _st_factors as
select brand_id, platform, type, count(*) as n,
       least(1, percentile_cont(0.50) within group (order by v / gd))::numeric as fg,
       least(1, percentile_cont(0.25) within group (order by v / p),
                percentile_cont(0.50) within group (order by v / gd))::numeric as fp
  from _st_rated where v > 0 and gd > 0 and p > 0
 group by brand_id, platform, type
having count(*) >= 8;

delete from _st_factors where fg >= 1 and fp >= 1;

-- One brand row for every basis and format the brand can be rated on,
-- scaled from the bar it has for that combination now
drop table if exists _st_new;
create temp table _st_new as
with combos as (
  select distinct f.brand_id, f.platform, f.type, f.fg, f.fp, t.basis, t.content_type
    from _st_factors f
    join static_thresholds t on t.platform = f.platform and t.creative_type = f.type
                            and (t.brand_id is null or t.brand_id = f.brand_id)
),
cur as (
  select k.*, b.poor_lt as cur_poor, b.good_gte as cur_good
    from combos k
    cross join lateral (
      select t.poor_lt, t.good_gte from static_thresholds t
       where t.platform = k.platform and t.creative_type = k.type and t.basis = k.basis
         and (t.content_type is null or t.content_type = k.content_type)
         and (t.brand_id = k.brand_id or t.brand_id is null)
       order by (t.brand_id is null), (t.content_type is not distinct from k.content_type) desc
       limit 1) b
),
scaled as (
  select c.*,
         case when c.fg < 1 then round(floor(c.cur_good * c.fg * 100) / 100, 2) else c.cur_good end as new_good,
         case when c.fp < 1 then round(floor(c.cur_poor * c.fp * 100) / 100, 2) else c.cur_poor end as new_poor0
    from cur c
)
select brand_id, platform, type, basis, content_type, cur_poor, cur_good,
       least(new_poor0, new_good) as new_poor, new_good
  from scaled;

with gone as (
  delete from static_thresholds t
   using (select distinct brand_id, platform, type from _st_new) n
   where t.brand_id = n.brand_id and t.platform = n.platform and t.creative_type = n.type
  returning t.*
)
insert into static_thresholds_retired
select g.*, now(), 'Replaced by 042: a bar is never harder than the brand''s own results'
  from gone g;

insert into static_thresholds (brand_id, platform, creative_type, basis, content_type, good_gte, poor_lt)
select brand_id, platform, type, basis, content_type, new_good, new_poor
  from _st_new;

insert into cqr_bars_archive (year, source, row)
select 2026, 'static_thresholds', to_jsonb(t)
  from static_thresholds t
  join (select distinct brand_id, platform, type from _st_new) n
    on t.brand_id = n.brand_id and t.platform = n.platform and t.creative_type = n.type
 where exists (select 1 from cqr_bar_years where year = 2026);

update cqr_bar_years
   set note = coalesce(note, '') || ' Same rule for photos and carousels (042).'
 where year = 2026 and coalesce(note, '') not like '%(042)%';

insert into schema_migrations (name) values ('042_static_bars_never_too_hard.sql') on conflict (name) do nothing;

commit;

-- What moved

select r.brand_id as brand, r.platform, r.type, count(*) as rated,
       count(*) filter (where r.cqr = 'Good') as good_before,
       count(*) filter (where a.cqr = 'Good') as good_after,
       count(*) filter (where r.cqr = 'Poor') as poor_before,
       count(*) filter (where a.cqr = 'Poor') as poor_after,
       count(*) filter (where a.cqr is distinct from r.cqr) as moved
  from _st_rated r
  join lateral (
    select case when r.v >= t.good_gte then 'Good' when r.v < t.poor_lt then 'Poor' else 'Average' end as cqr
      from static_thresholds t
     where t.platform = r.platform and t.creative_type = r.type and t.basis = r.basis
       and (t.content_type is null or t.content_type = r.content_type)
       and (t.brand_id = r.brand_id or t.brand_id is null)
     order by (t.brand_id is null), (t.content_type is null)
     limit 1) a on true
 group by 1, 2, 3
having count(*) filter (where a.cqr is distinct from r.cqr) > 0
 order by 1, 2, 3;

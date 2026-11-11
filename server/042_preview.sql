-- =====================================================================
--  042 preview: the "never too hard" rule for photos and carousels.
--  Read only: changes nothing.
--
--  Statics are rated in the app (server/static-rating.js) against
--  static_thresholds. This works the rating out the same way here:
--    Brand Say   engagement per reach (or per view where there is no reach)
--    Others Say  (likes + 2 x comments) per view (or per follower)
--  Then the same rule as 041, per brand, platform and type: at least half
--  must clear Good, no more than a quarter may fall Poor, otherwise the
--  brand's bars are scaled down until they do. 8 rated posts needed.
-- =====================================================================
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
),
rated as (
  select g.*, b.poor_lt as p, b.good_gte as gd,
         case when g.v >= b.good_gte then 'Good' when g.v < b.poor_lt then 'Poor' else 'Average' end as now_cqr
    from sig g
    cross join lateral (
      select t.poor_lt, t.good_gte from static_thresholds t
       where t.platform = g.platform and t.creative_type = g.type and t.basis = g.basis
         and (t.content_type is null or t.content_type = g.content_type)
         and (t.brand_id = g.brand_id or t.brand_id is null)
       order by (t.brand_id is null), (t.content_type is null)
       limit 1) b
   where g.basis is not null and g.v is not null
),
factors as (
  select brand_id, platform, type, count(*) as n,
         least(1, percentile_cont(0.50) within group (order by v / gd))::numeric as fg,
         least(1, percentile_cont(0.25) within group (order by v / p),
                  percentile_cont(0.50) within group (order by v / gd))::numeric as fp
    from rated where v > 0 and gd > 0 and p > 0
   group by brand_id, platform, type
  having count(*) >= 8
),
after as (
  select r.*,
         case when r.v >= r.gd * coalesce(f.fg, 1) then 'Good'
              when r.v <  least(r.p * coalesce(f.fp, 1), r.gd * coalesce(f.fg, 1)) then 'Poor'
              else 'Average' end as new_cqr
    from rated r
    left join factors f on f.brand_id = r.brand_id and f.platform = r.platform and f.type = r.type
)
select brand_id as brand, platform, type, count(*) as rated,
       count(*) filter (where now_cqr = 'Good')    as good_now,
       count(*) filter (where now_cqr = 'Average') as avg_now,
       count(*) filter (where now_cqr = 'Poor')    as poor_now,
       count(*) filter (where new_cqr = 'Good')    as good_after,
       count(*) filter (where new_cqr = 'Average') as avg_after,
       count(*) filter (where new_cqr = 'Poor')    as poor_after,
       count(*) filter (where new_cqr is distinct from now_cqr) as moved
  from after
 group by 1, 2, 3
 order by 1, 2, 3;

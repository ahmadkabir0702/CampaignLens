-- =====================================================================
--  026 — Vaseline and Sunsilk paid bars, 20% above the market
--
--  Vaseline's own paid bars were set well above what its ads reach (a 40%
--  hook for Good on Meta, where the market's Good is about 14%), and
--  Sunsilk copied them. Most of their ads read Poor on hook or hold
--  whatever they did.
--
--  This keeps them on a higher bar than other brands, but one that can be
--  met: every paid hook and hold bar is the global bar (set from your own
--  results by 025) times 1.2. Change the factor below to make it harder or
--  easier.
--
--  Only their paid rows change. Their organic retention bars are kept.
--  The old rows are kept in cqr_thresholds_retired.
--
--  Run after 025. Safe to re-run; run it again after 025 is re-run so the
--  two stay in step.
-- =====================================================================

begin;

drop table if exists _premium;
create temp table _premium as
  select b.brand_id, 1.2::numeric as factor
    from (values ('vaseline'), ('sunsilk')) as b(brand_id);

with gone as (
  delete from cqr_thresholds t
   using _premium p
   where t.brand_id = p.brand_id
     and t.metric in ('hook_rate', 'hold_rate')
     and t.platform in ('meta_paid_bs', 'meta_paid_os', 'tt_paid_bs', 'tt_paid_os')
  returning t.*
)
insert into cqr_thresholds_retired
select g.*, now(), 'Replaced by 026: premium brand bar, global times a factor'
  from gone g;

insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select p.brand_id, g.platform, g.metric, g.min_duration, g.max_duration,
       round(g.poor_lt * p.factor, 1), round(g.good_gte * p.factor, 1)
  from cqr_thresholds g
 cross join _premium p
 where g.brand_id is null
   and g.metric in ('hook_rate', 'hold_rate')
   and g.platform in ('meta_paid_bs', 'meta_paid_os', 'tt_paid_bs', 'tt_paid_os');

commit;

-- How their ratings land now
select x.brand_id, x.platform, x.type,
       count(*) filter (where cqr = 'Good')    as good,
       count(*) filter (where cqr = 'Average') as average,
       count(*) filter (where cqr = 'Poor')    as poor
from (
  select v.brand_id, 'meta' as platform, c.type, v.cqr
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
  union all
  select v.brand_id, 'tiktok', c.type, v.cqr
    from v_paid_tiktok_creative v join creatives c on c.creative_id = v.creative_id
) x
where x.brand_id in (select brand_id from _premium)
  and cqr in ('Good', 'Average', 'Poor')
group by 1, 2, 3 order by 1, 2, 3;

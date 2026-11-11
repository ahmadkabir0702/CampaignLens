-- =====================================================================
--  033 — Home care benchmarks: Cif, Sunlight, Surf Excel
--
--  From the home care benchmark sheet (CQR_Benchmarks_4.xlsx), one set of
--  bars for all three brands. Where the sheet's number fits the way
--  Campaign Lens measures, it is used as given. Where it does not, the bar
--  is set at the same level the sheet asks for, on the measure Campaign
--  Lens uses. Throughout, Poor starts at Good / 1.5, as in the sheet.
--
--  PAID, Brand Say
--    Meta hook        Poor below 9, Good from 13.5. From the sheet.
--
--    TikTok hook      The sheet repeats Meta's 9 / 13.5, but TikTok counts
--                     a 2-second view, so its hook rates run two to three
--                     times Meta's and every TikTok ad would read Good.
--                     Set instead at the same level against the market as
--                     the Meta hook: the market's TikTok bar times
--                     (13.5 / the market's Meta Good).
--
--    Hold, both       The sheet's hold bars (15.75% to 28.5% for Good) are
--                     above its own hook bar and rise with video length.
--                     Campaign Lens counts hold against all impressions,
--                     so hold is always below hook, and a longer video is
--                     harder to hold, not easier. As written, no home
--                     care ad could reach Good on hold. Set instead from
--                     the market's hold bars (set from your own results by
--                     025), at the same level as the hook, by length.
--
--  PAID, Others Say
--    No home care rows. Creator ads stay on the bars every brand's
--    creators share, the same decision as 026 for Vaseline and Sunsilk.
--    The sheet's creator hook (Good from 52.5% on Meta) is about four
--    times its Brand Say hook; the last result shows how many creator ads
--    across all brands reach it today.
--
--  ORGANIC, Brand Say (average watch time as a share of the video length)
--    The sheet's bars (Good from 10%, 5%, 2% and 1% by length) read like a
--    watch-to-the-end rate. On average watch time they would rate almost
--    every post Good: 1% of a 60-second video is under one second. Set at
--    the market's Good by length, with the sheet's wider Average band.
--
--  ORGANIC, Others Say
--    Not changed. Creator posts are rated on likes and comments per view
--    against the brand's own creator bar (028), not on retention, so the
--    sheet's Others Say retention rows have nothing to apply to.
--
--  PHOTOS AND CAROUSELS
--    Not in the sheet. They keep the market bars.
--
--  Any home care rows already there are moved to cqr_thresholds_retired.
--  Safe to re-run; run it again after 025 is re-run so the bars follow.
--  The last result lists every bar next to the market's, then how home
--  care creatives are rated before and after.
-- =====================================================================

begin;

drop table if exists _hc_brands;
create temp table _hc_brands as
  select brand_id from (values ('cif'), ('sunlight'), ('surfexcel')) as b(brand_id);

-- Ratings as they stand, for the comparison at the end.
drop table if exists _hc_before;
create temp table _hc_before as
  select v.brand_id, 'Meta paid'::text as what, v.cqr
    from v_paid_meta_creative v where v.brand_id in (select brand_id from _hc_brands)
  union all
  select v.brand_id, 'TikTok paid', v.cqr
    from v_paid_tiktok_creative v where v.brand_id in (select brand_id from _hc_brands)
  union all
  select s.brand_id, s.platform || ' organic', s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id
   where s.brand_id in (select brand_id from _hc_brands)
     and s.type <> 'Others Say'
     and coalesce(c.content_type, 'Video') not in ('Photo', 'Carousel');

-- The level the sheet sets: its Meta Brand Say hook against the market's.
drop table if exists _hc_level;
create temp table _hc_level as
  select 13.5::numeric / t.good_gte as f, t.good_gte as market_meta_hook_good
    from cqr_thresholds t
   where t.brand_id is null and t.platform = 'meta_paid_bs' and t.metric = 'hook_rate'
   limit 1;

do $$
begin
  if not exists (select 1 from _hc_level where f > 0) then
    raise exception 'No market Meta Brand Say hook bar found. Nothing was changed.';
  end if;
end $$;

-- Old home care rows, kept.
with gone as (
  delete from cqr_thresholds t
   where t.brand_id in (select brand_id from _hc_brands)
     and t.metric in ('hook_rate', 'hold_rate', 'retention_rate')
  returning t.*
)
insert into cqr_thresholds_retired
select g.*, now(), 'Replaced by 033: home care benchmarks'
  from gone g;

-- Meta Brand Say hook: the sheet's numbers.
insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select b.brand_id, 'meta_paid_bs', 'hook_rate', null, null, 9.0, 13.5
  from _hc_brands b;

-- TikTok Brand Say hook, and Brand Say hold on both: the market's bar at
-- the sheet's level, by length.
insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select b.brand_id, g.platform, g.metric, g.min_duration, g.max_duration,
       round(g.good_gte * l.f / 1.5, 1), round(g.good_gte * l.f, 1)
  from cqr_thresholds g
 cross join _hc_level l
 cross join _hc_brands b
 where g.brand_id is null
   and (   (g.platform = 'tt_paid_bs' and g.metric = 'hook_rate')
        or (g.platform in ('meta_paid_bs', 'tt_paid_bs') and g.metric = 'hold_rate'));

-- Organic Brand Say retention: the market's Good, the sheet's spread.
insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select b.brand_id, g.platform, g.metric, g.min_duration, g.max_duration,
       round(g.good_gte / 1.5, 1), g.good_gte
  from cqr_thresholds g
 cross join _hc_brands b
 where g.brand_id is null
   and g.platform in ('ig_organic', 'fb_organic', 'tt_organic')
   and g.metric = 'retention_rate';

commit;

-- ---------------------------------------------------------------------
--  Result: the bars, then the ratings before and after, then the check on
--  the sheet's creator hook.
-- ---------------------------------------------------------------------
with bars as (
  select 1 as part,
         case t.platform
           when 'meta_paid_bs' then 'Meta paid' when 'tt_paid_bs' then 'TikTok paid'
           when 'ig_organic' then 'Instagram organic' when 'fb_organic' then 'Facebook organic'
           when 'tt_organic' then 'TikTok organic' end
         || ', ' || replace(t.metric, '_rate', '')
         || case when t.metric = 'hook_rate' then ''
                 when t.max_duration is null then ', ' || coalesce(t.min_duration, 0) || 's and over'
                 else ', ' || coalesce(t.min_duration, 0) || ' to ' || t.max_duration || 's' end as item,
         t.platform as k1, t.metric as k2, coalesce(t.min_duration, -1) as k3,
         'market ' || g.poor_lt || ' / ' || g.good_gte as before_,
         'home care ' || t.poor_lt || ' / ' || t.good_gte as after_
    from cqr_thresholds t
    left join cqr_thresholds g
      on g.brand_id is null and g.platform = t.platform and g.metric = t.metric
     and g.min_duration is not distinct from t.min_duration
   where t.brand_id = 'cif'
),
after_ as (
  select v.brand_id, 'Meta paid'::text as what, v.cqr
    from v_paid_meta_creative v where v.brand_id in (select brand_id from _hc_brands)
  union all
  select v.brand_id, 'TikTok paid', v.cqr
    from v_paid_tiktok_creative v where v.brand_id in (select brand_id from _hc_brands)
  union all
  select s.brand_id, s.platform || ' organic', s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id
   where s.brand_id in (select brand_id from _hc_brands)
     and s.type <> 'Others Say'
     and coalesce(c.content_type, 'Video') not in ('Photo', 'Carousel')
),
summ as (
  select x.brand_id, x.what, x.when_,
         'Good ' || count(*) filter (where cqr = 'Good')
         || ', Average ' || count(*) filter (where cqr = 'Average')
         || ', Poor ' || count(*) filter (where cqr = 'Poor')
         || ', other ' || count(*) filter (where cqr not in ('Good', 'Average', 'Poor') or cqr is null) as line
    from (select brand_id, what, cqr, 'before' as when_ from _hc_before
          union all
          select brand_id, what, cqr, 'after' from after_) x
   group by x.brand_id, x.what, x.when_
),
ratings as (
  select 2 as part, coalesce(a.brand_id, b.brand_id) || ', ' || coalesce(a.what, b.what) as item,
         coalesce(a.brand_id, b.brand_id) as k1, coalesce(a.what, b.what) as k2, 0 as k3,
         coalesce(b.line, 'none') as before_, coalesce(a.line, 'none') as after_
    from (select * from summ where when_ = 'after') a
    full join (select * from summ where when_ = 'before') b
      on a.brand_id = b.brand_id and a.what = b.what
),
creator_check as (
  select 3 as part, 'Creator ads, all brands, Meta hook 52.5 or more (the sheet''s creator Good)' as item,
         '' as k1, '' as k2, 0 as k3,
         count(*) || ' creator ads with 10,000+ impressions' as before_,
         count(*) filter (where v.hook_rate >= 52.5) || ' would reach Good' as after_
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
   where c.type = 'Others Say' and v.impressions >= 10000
)
select item, before_ as "before", after_ as "after"
  from (select * from bars union all select * from ratings union all select * from creator_check) z
 order by part, k1, k2 desc, k3;

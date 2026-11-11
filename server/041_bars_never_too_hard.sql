-- =====================================================================
--  041: a benchmark is never harder than the brand's own results
--
--  Decision (26 Oct 2026): a bar may be easy, but it must never be too
--  hard. The audit found brands where most creatives could not reach Good
--  (Sunsilk organic TikTok: 7 of 10 Poor; Pears creator posts on
--  Instagram: 0 of 11 Good), because the bar came from other brands or
--  from starting values, not from what the brand's own content does.
--
--  The rule, for every brand, worked out from its own rated creatives,
--  on each bar (paid hook, paid hold, organic Brand Say retention, and
--  the creator bar for Others Say posts):
--    Good: at least half the brand's creatives must clear the Good line.
--          If fewer do, the brand's bar is scaled down until half do.
--    Poor: no more than a quarter may fall below the Poor line. If more
--          do, it is scaled down until a quarter do. Poor always drops at
--          least as much as Good, so the Average band keeps its shape.
--  Hold and retention depend on video length, so each creative is
--  compared with the bar for its own length and the brand's creatives of
--  all lengths are pooled. Needs 8 rated creatives (5 creator posts),
--  otherwise the bar is left as it is.
--  A bar is only ever lowered. Where the brand's bar is already easier
--  than this, it is kept, so nothing here makes any rating worse.
--
--  How it is stored: a brand that needs a lower bar on a group gets its
--  own rows for that group (one per video length, same lengths as the
--  global rows), scaled down by the same factor. Rows it
--  had before go to cqr_thresholds_retired. Creator bars get a brand row
--  in cqr_os_benchmarks with basis 'capped (041)'.
--
--  This is a one-off fix to the 2026 benchmarks, noted in cqr_bar_years.
--  The new rows are added to the 2026 copy in cqr_bars_archive. Ratings
--  that move are recorded in cqr_history as 'rule change', so fatigue and
--  the rating history do not read them as the creatives changing.
--
--  Run server/041_preview.sql first to see the effect. Safe to re-run:
--  a second run finds nothing harder than the caps and changes nothing.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Ratings before, to record what moves
-- ---------------------------------------------------------------------
drop table if exists _r_before;
create temp table _r_before as
  select 'paid'::text as channel, 'meta'::text as platform, creative_id, brand_id, cqr
    from v_paid_meta_creative
  union all
  select 'paid', 'tiktok', creative_id, brand_id, cqr from v_paid_tiktok_creative
  union all
  select 'organic', s.platform, s.creative_id, c.brand_id, s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id;

-- ---------------------------------------------------------------------
-- How far each brand's bars need to come down: every rated value as a
-- share of the bar for its own length, pooled across lengths
-- ---------------------------------------------------------------------
drop table if exists _factors;
create temp table _factors as
with
paid as (
  select v.brand_id, 'meta_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end as grp,
         v.hook_rate::numeric as hook, v.hold_rate::numeric as hold, v.duration_s::numeric as dur
    from v_paid_meta_creative v join creatives c on c.creative_id = v.creative_id
   where v.cqr in ('Good', 'Average', 'Poor')
  union all
  select v.brand_id, 'tt_paid_' || case when c.type = 'Others Say' then 'os' else 'bs' end,
         v.hook_rate::numeric, v.hold_rate::numeric, v.duration_s::numeric
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
  select c.brand_id, o.platform || '_organic' as grp,
         (o.avg_watch_time / c.duration_s * 100)::numeric as ret,
         t.poor_lt as p, t.good_gte as g
    from v_organic_scored s
    join creatives c on c.creative_id = s.creative_id
    join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
    left join lateral thr(c.brand_id, o.platform || '_organic', 'retention_rate', c.duration_s::numeric) as t(poor_lt, good_gte) on true
   where c.type = 'Brand Say' and c.duration_s > 0 and o.avg_watch_time > 0
     and s.cqr in ('Good', 'Average', 'Poor')
),
os as (
  select c.brand_id, o.platform as grp,
         ((coalesce(o.likes, 0) + 2 * coalesce(o.comments, 0))::numeric / o.views * 100) as epv,
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
)
select brand_id, grp, metric, count(*) as n,
       least(1, percentile_cont(0.50) within group (order by rg))::numeric as fg,
       least(1, percentile_cont(0.25) within group (order by rp),
                percentile_cont(0.50) within group (order by rg))::numeric as fp
  from ratios
 group by brand_id, grp, metric, min_n
having count(*) >= min_n;

delete from _factors where fg >= 1 and fp >= 1;

-- ---------------------------------------------------------------------
-- Paid and Brand Say organic: the brand's own rows for each lowered
-- group, one per global video length band, scaled down
-- ---------------------------------------------------------------------
drop table if exists _new_rows;
create temp table _new_rows as
with per_band as (
  select f.brand_id, g.platform as grp, g.metric, g.min_duration, g.max_duration, f.fg, f.fp,
         cur.poor_lt as cur_poor, cur.good_gte as cur_good
    from _factors f
    join cqr_thresholds g on g.brand_id is null and g.platform = f.grp and g.metric = f.metric
    cross join lateral (
      select case when g.max_duration is null then coalesce(g.min_duration, 0) + 1
                  else (coalesce(g.min_duration, 0) + g.max_duration) / 2.0 end as rep
    ) r
    left join lateral (
      select t.poor_lt, t.good_gte
        from thr(f.brand_id, g.platform, g.metric, r.rep) as t(poor_lt, good_gte)
       where g.metric <> 'hook_rate'
      union all
      select t.poor_lt, t.good_gte
        from thr(f.brand_id, g.platform, g.metric) as t(poor_lt, good_gte)
       where g.metric = 'hook_rate'
       limit 1
    ) cur on true
   where f.metric in ('hook_rate', 'hold_rate', 'retention_rate')
),
scaled as (
  select pb.*,
         case when pb.fg < 1 then round(floor(pb.cur_good * pb.fg * 10) / 10, 1) else pb.cur_good end as new_good,
         case when pb.fp < 1 then round(floor(pb.cur_poor * pb.fp * 10) / 10, 1) else pb.cur_poor end as new_poor0
    from per_band pb
   where pb.cur_good is not null and pb.cur_poor is not null
)
select brand_id, grp, metric, min_duration, max_duration, fg, fp, cur_poor, cur_good,
       least(new_poor0, new_good) as new_poor, new_good
  from scaled;

-- Retire the brand's own rows for those groups, then write the new set.
with gone as (
  delete from cqr_thresholds t
   using (select distinct brand_id, grp, metric from _new_rows) n
   where t.brand_id = n.brand_id and t.platform = n.grp and t.metric = n.metric
  returning t.*
)
insert into cqr_thresholds_retired
select g.*, now(), 'Replaced by 041: a bar is never harder than the brand''s own results'
  from gone g;

insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select brand_id, grp, metric, min_duration, max_duration, new_poor, new_good
  from _new_rows;

-- ---------------------------------------------------------------------
-- Creator bars (Others Say): a brand row in cqr_os_benchmarks
-- ---------------------------------------------------------------------
drop table if exists _os_new;
create temp table _os_new as
select f.brand_id, f.grp as platform, f.n, g.poor_pct, g.good_pct,
       cur.poor_below as cur_poor, cur.good_from as cur_good,
       least(case when f.fp < 1 then round(floor(cur.poor_below * f.fp * 100) / 100, 2) else cur.poor_below end,
             case when f.fg < 1 then round(floor(cur.good_from  * f.fg * 100) / 100, 2) else cur.good_from end) as new_poor,
       case when f.fg < 1 then round(floor(cur.good_from * f.fg * 100) / 100, 2) else cur.good_from end as new_good
  from _factors f
  join cqr_os_benchmarks g on g.platform = f.grp and g.brand_id is null
  cross join lateral (select ob.poor_below, ob.good_from from cqr_os_benchmarks ob
                       where ob.platform = f.grp and (ob.brand_id = f.brand_id or ob.brand_id is null)
                       order by ob.brand_id nulls last limit 1) cur
 where f.metric = 'creator';

delete from cqr_os_benchmarks b using _os_new n
 where b.brand_id = n.brand_id and b.platform = n.platform;

insert into cqr_os_benchmarks (platform, brand_id, poor_pct, good_pct, poor_below, good_from, basis, posts, updated_at)
select platform, brand_id, poor_pct, good_pct, new_poor, new_good, 'capped (041)', n, now()
  from _os_new;

-- ---------------------------------------------------------------------
-- Keep the 2026 record straight
-- ---------------------------------------------------------------------
insert into cqr_bars_archive (year, source, row)
select 2026, 'cqr_thresholds', to_jsonb(t)
  from cqr_thresholds t
  join (select distinct brand_id, grp, metric from _new_rows) n
    on t.brand_id = n.brand_id and t.platform = n.grp and t.metric = n.metric
 where exists (select 1 from cqr_bar_years where year = 2026)
union all
select 2026, 'cqr_os_benchmarks', to_jsonb(b)
  from cqr_os_benchmarks b
  join _os_new n on n.brand_id = b.brand_id and n.platform = b.platform
 where exists (select 1 from cqr_bar_years where year = 2026);

update cqr_bar_years
   set note = coalesce(note, '') || ' One-off fix 26 Oct 2026: no brand bar harder than half its creatives reaching Good and a quarter falling Poor (041).'
 where year = 2026 and coalesce(note, '') not like '%(041)%';

-- ---------------------------------------------------------------------
-- Record each rating that moved as a rule change
-- ---------------------------------------------------------------------
drop table if exists _r_after;
create temp table _r_after as
  select 'paid'::text as channel, 'meta'::text as platform, creative_id, brand_id, cqr
    from v_paid_meta_creative
  union all
  select 'paid', 'tiktok', creative_id, brand_id, cqr from v_paid_tiktok_creative
  union all
  select 'organic', s.platform, s.creative_id, c.brand_id, s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id;

insert into cqr_history
  (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
   hook_rate, hold_rate, impressions, spend, is_first, reason)
select w.creative_id, w.brand_id, 'paid', w.platform, w.cqr, a.cqr,
       w.hook_rate, w.hold_rate, w.impressions, w.spend, false, 'rule change'
  from _r_after a
  join _r_before b using (channel, platform, creative_id)
  join v_paid_windowed w on w.creative_id = a.creative_id and w.platform = a.platform
                        and w.window_name = 'last_7'
 where a.channel = 'paid' and a.cqr is distinct from b.cqr
union all
select a.creative_id, a.brand_id, 'organic', a.platform, a.cqr, a.cqr,
       null, null, o.views, null, false, 'rule change'
  from _r_after a
  join _r_before b using (channel, platform, creative_id)
  join organic_perf o on o.creative_id = a.creative_id and o.platform = a.platform
 where a.channel = 'organic' and a.cqr is distinct from b.cqr;

insert into schema_migrations (name) values ('041_bars_never_too_hard.sql') on conflict (name) do nothing;

commit;

-- What moved, by brand
select a.brand_id as brand, a.channel || ' ' || a.platform as channel,
       count(*) filter (where b.cqr = 'Good')    as good_before,
       count(*) filter (where a.cqr = 'Good')    as good_after,
       count(*) filter (where b.cqr = 'Poor')    as poor_before,
       count(*) filter (where a.cqr = 'Poor')    as poor_after,
       count(*) filter (where a.cqr is distinct from b.cqr) as moved
  from _r_after a
  join _r_before b using (channel, platform, creative_id)
 where a.cqr in ('Good', 'Average', 'Poor') or b.cqr in ('Good', 'Average', 'Poor')
 group by 1, 2
having count(*) filter (where a.cqr is distinct from b.cqr) > 0
 order by 1, 2;

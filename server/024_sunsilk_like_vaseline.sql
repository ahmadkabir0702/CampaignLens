-- =====================================================================
--  024 — Sunsilk on Vaseline's benchmarks (optional)
--
--  Until now only Vaseline and Knorr had their own benchmarks; Sunsilk
--  was rated on the global ones. This gives Sunsilk the same video
--  benchmarks as Vaseline: paid hook and hold (Brand Say and Others Say)
--  and organic Brand Say retention, by video length.
--
--  Run after 023. Safe to re-run: it replaces Sunsilk's rows each time,
--  so if Vaseline's change, run it again to follow them.
-- =====================================================================

begin;

delete from cqr_thresholds where brand_id = 'sunsilk';

insert into cqr_thresholds (brand_id, platform, metric, min_duration, max_duration, poor_lt, good_gte)
select 'sunsilk', platform, metric, min_duration, max_duration, poor_lt, good_gte
  from cqr_thresholds
 where brand_id = 'vaseline'
   and (   (metric in ('hook_rate', 'hold_rate') and platform like '%\_paid\_%')
        or (metric = 'retention_rate' and platform like '%\_organic'));

commit;

select platform, metric, min_duration, max_duration, poor_lt, good_gte
  from cqr_thresholds where brand_id = 'sunsilk'
 order by platform, metric, min_duration nulls first;

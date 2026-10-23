-- =====================================================================
--  040 — Knorr's organic Brand Say benchmarks go back to the global ones
--
--  Knorr had its own organic retention bands (watch time as a share of the
--  video's length), and they could not be right:
--    - under 15 seconds, Good started at 3% (2.3% on TikTok). The global
--      bar is 25% (15% on TikTok), so almost any Knorr short video read Good.
--    - the bands rose with video length (Good at 3%, 16%, 20% on Instagram)
--      when retention always falls as videos get longer, and on TikTok fell
--      to 3.7% for 60 seconds and over.
--  They look like seconds of watch time typed in as percentages, for some
--  rows only. With no way to tell what was meant, Knorr is rated on the
--  global organic bands, like every brand except Vaseline and Sunsilk.
--
--  The 12 rows are moved to cqr_thresholds_retired (kept, not lost), and
--  are also in the 2026 copy in cqr_bars_archive. This is a one-off fix to
--  the 2026 benchmarks, noted in cqr_bar_years. Knorr ratings that move
--  because of it are recorded in cqr_history as 'rule change', so the
--  rating history and fatigue do not read them as the creatives changing.
--
--  To see the effect before running this, run the preview in the pull
--  request (it rolls back).
-- =====================================================================

begin;

-- Knorr's organic ratings before the change.
create temp table _knorr_before as
  select s.creative_id, s.platform, s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id
   where c.brand_id = 'knorr';

with gone as (
  delete from cqr_thresholds
   where brand_id = 'knorr' and metric = 'retention_rate'
     and platform in ('ig_organic', 'fb_organic', 'tt_organic')
  returning *
)
insert into cqr_thresholds_retired
select g.*, now(), 'Knorr organic bands looked like seconds entered as percentages (Good from 3% under 15s); Knorr uses the global bands (040)'
  from gone g;

update cqr_bar_years
   set note = coalesce(note, '') || ' One-off fix 23 Oct 2026: Knorr organic Brand Say bands retired, global bands used (040).'
 where year = 2026 and coalesce(note, '') not like '%(040)%';

-- Record each Knorr organic rating that moved as a rule change.
insert into cqr_history
  (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
   hook_rate, hold_rate, impressions, spend, is_first, reason)
select s.creative_id, 'knorr', 'organic', s.platform, s.cqr, s.cqr,
       null, null, o.views, null, false, 'rule change'
  from v_organic_scored s
  join creatives c on c.creative_id = s.creative_id and c.brand_id = 'knorr'
  join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
  join _knorr_before b on b.creative_id = s.creative_id and b.platform = s.platform
 where b.cqr is distinct from s.cqr;

insert into schema_migrations (name) values ('040_knorr_organic_bars.sql') on conflict (name) do nothing;

-- What moved, before the commit.
select b.platform, coalesce(b.cqr, 'none') as before, coalesce(s.cqr, 'none') as after, count(*) as creatives
  from _knorr_before b
  left join v_organic_scored s on s.creative_id = b.creative_id and s.platform = b.platform
 group by 1, 2, 3
 order by 1, 2, 3;

commit;

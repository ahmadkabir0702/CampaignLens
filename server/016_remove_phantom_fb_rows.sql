-- =====================================================================
--  016 — delete the phantom Facebook rows on Others Say creatives
--
--  SUPERSEDES 013 FOR PRODUCTION DATA. Do not run 013. See the note at
--  the bottom of this file for why it would fail.
--
--  THE BUG. worker.js wrote the first organic_perf row for every Others
--  Say creative with platform = 'fb', whatever platform the post was on:
--  the function took 'ig' | 'tt' | 'fb' and defaulted to 'fb', while the
--  job handed it 'instagram' | 'tiktok' | 'facebook', so neither branch
--  matched. The same line put the creator's Instagram or TikTok handle
--  into fb_handle.
--
--  WHAT THE DATA ACTUALLY LOOKS LIKE. 013 assumed the misfiled row was
--  the only copy of those numbers, and moved it to the right platform.
--  That is not the case. The sync has since written a correct ig or tt
--  row for every affected creative, so each one now carries BOTH:
--
--    SUNSILK_OS_RASHMI0010   fb 138354 views   ig 138354 views
--    LUX_OS_0012             fb   1254 views   tt   1254 views
--    PONDS_OS_DILINISEP20067 fb  27263 views   ig  27306 views
--
--  Same time_posted, the fb figure equal or slightly staler. The fb row
--  is an old snapshot of the real platform's numbers, not Facebook data.
--
--  WHY IT MATTERS. These creatives have no Facebook link at all, so every
--  figure in those rows is phantom Facebook reach. Anything that sums
--  organic_perf across platforms counts them twice, and Sunsilk alone
--  carries 280,940 invented Facebook views on one creative.
--
--  THE TEST. A creative with fb_link IS NULL cannot legitimately have an
--  fb row. That is proof rather than inference, which is what 013's
--  heuristic was missing. The delete additionally requires that a row for
--  the creative's real platform already exists, so it can never remove
--  the only copy of a number.
-- =====================================================================

-- ── 0. Read only. What is about to be deleted, and what survives. ────
select c.creative_id,
       c.fb_handle,
       o.platform, o.views, o.likes,
       case when o.platform = 'fb' then 'DELETE' else 'keep' end as action
  from creatives c
  join organic_perf o on o.creative_id = c.creative_id
 where c.type = 'Others Say'
   and c.fb_link is null
   and exists (select 1 from organic_perf x
                where x.creative_id = c.creative_id and x.platform = 'fb')
 order by c.creative_id, o.platform;

-- ── 1. The repair ────────────────────────────────────────────────────
begin;

create temporary table _phantom on commit drop as
select o.id, o.creative_id, o.views, o.likes
  from organic_perf o
  join creatives c on c.creative_id = o.creative_id
 where o.platform = 'fb'
   and c.type     = 'Others Say'
   and c.fb_link is null                       -- no Facebook post exists
   -- Never delete the only copy: the creative's real platform must
   -- already have a row of its own.
   and exists (
     select 1 from organic_perf k
      where k.creative_id = o.creative_id
        and k.platform = case when c.ig_link is not null then 'ig' else 'tt' end
   );

-- Expect 21 on the data as at 2026-10-18.
select count(*) as rows_to_delete, sum(views) as phantom_views from _phantom;

delete from organic_perf o using _phantom p where o.id = p.id;

-- fb_handle holds the creator's Instagram or TikTok handle on these, and
-- fb_last_scraped_at records a Facebook read that never happened. Both
-- are wrong, and a non-null stamp makes the sync skip the platform.
-- The ig and tt stamps are deliberately left alone: the sync is working
-- on those platforms and clearing them would force a needless refetch.
update creatives c
   set fb_handle          = null,
       fb_last_scraped_at = null
 where c.type = 'Others Say'
   and c.fb_link is null
   and (c.fb_handle is not null or c.fb_last_scraped_at is not null);

commit;

-- ── 2. Confirm. Both of these must return zero rows. ─────────────────
select c.creative_id, o.platform, o.views
  from creatives c
  join organic_perf o on o.creative_id = c.creative_id
 where c.type = 'Others Say' and c.fb_link is null and o.platform = 'fb';

select creative_id, fb_handle, fb_last_scraped_at
  from creatives
 where type = 'Others Say' and fb_link is null
   and (fb_handle is not null or fb_last_scraped_at is not null);

-- ── Why 013 must not be run ──────────────────────────────────────────
--  013 does:  update organic_perf set platform = 'ig' where platform = 'fb'
--  Every affected creative already has an ig (or tt) row, and
--  organic_perf_creative_id_platform_key is unique on
--  (creative_id, platform). Each update would raise a duplicate key
--  violation and roll the whole transaction back. Even if it succeeded it
--  would replace fresh sync numbers with the add's staler ones.
--
--  013's step 0 returns no rows against this data, because it required
--  ig_last_scraped_at AND tt_last_scraped_at to both be null. Most of
--  these creatives have been scraped on at least one platform since, so
--  they fail that test while still carrying the phantom row.
-- =====================================================================

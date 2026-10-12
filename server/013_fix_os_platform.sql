-- =====================================================================
--  012_fix_os_platform.sql — put Others Say numbers back on the right
--  platform.
--
--  worker.js wrote the first organic_perf row for every Others Say
--  creative with platform = 'fb', whatever platform the post was on. The
--  function took the short code 'ig' | 'tt' | 'fb' and silently defaulted
--  to 'fb', while the job handed it 'instagram' | 'tiktok' | 'facebook',
--  so neither branch ever matched. The same line put the scrape stamp on
--  fb_last_scraped_at and the Instagram or TikTok handle in fb_handle.
--
--  The code is fixed. This moves what is already stored.
--
--  The test for a misfiled row is that the creative has no Facebook link
--  at all. Nothing else writes a Facebook organic row for a creative with
--  no fb_link: the Brand Say branch requires fb_link is not null and so
--  does the Others Say one, so such a row can only have come from here.
--
--  A creative that has BOTH a Facebook link and an Instagram or TikTok
--  one is left alone. Its fb row may hold a mix of the add-time numbers
--  and real Facebook numbers written over them since, and there is no way
--  to separate those now. Its ig/tt stamps were never set, so the next
--  sync will read those platforms and create the rows properly.
--
--  Run inside a transaction. Step 0 changes nothing: read it first.
-- =====================================================================

-- ── 0. What is affected. Run this on its own and look at it. ─────────
select c.creative_id,
       c.type,
       c.ig_link is not null as has_ig,
       c.tt_link is not null as has_tt,
       case when c.ig_link is not null then 'ig'
            when c.tt_link is not null then 'tt' end as belongs_to,
       o.views, o.likes, o.comments, o.shares,
       c.fb_handle,
       c.fb_last_scraped_at,
       exists (select 1 from organic_perf x
                where x.creative_id = o.creative_id
                  and x.platform = case when c.ig_link is not null then 'ig' else 'tt' end)
         as target_row_already_exists
  from creatives c
  join organic_perf o
    on o.creative_id = c.creative_id and o.platform = 'fb'
 where c.fb_link is null
 order by c.creative_id;

-- ── 1. The repair ────────────────────────────────────────────────────
begin;

-- Where the sync has since written a real row for the right platform,
-- the misfiled one is a stale duplicate. Drop it rather than colliding
-- with the (creative_id, platform) key.
delete from organic_perf o
 using creatives c
 where o.creative_id = c.creative_id
   and o.platform = 'fb'
   and c.fb_link is null
   and (c.ig_link is not null or c.tt_link is not null)
   and exists (
     select 1 from organic_perf x
      where x.creative_id = o.creative_id
        and x.platform = case when c.ig_link is not null then 'ig' else 'tt' end);

-- Move the rest onto the platform they actually came from.
update organic_perf o
   set platform = case when c.ig_link is not null then 'ig' else 'tt' end
  from creatives c
 where o.creative_id = c.creative_id
   and o.platform = 'fb'
   and c.fb_link is null
   and (c.ig_link is not null or c.tt_link is not null);

-- The handle and the scrape stamp went to the Facebook columns too.
-- Clearing the stamp is deliberate: the sync treats a null as never read
-- and will fetch these on its next run regardless of how old they are.
update creatives c
   set fb_handle = null,
       fb_last_scraped_at = null
 where c.fb_link is null
   and (c.fb_handle is not null or c.fb_last_scraped_at is not null);

commit;

-- ── 2. Confirm. Should return no rows. ───────────────────────────────
select c.creative_id
  from creatives c
  join organic_perf o
    on o.creative_id = c.creative_id and o.platform = 'fb'
 where c.fb_link is null;

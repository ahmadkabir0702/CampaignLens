-- =====================================================================
--  013_fix_os_platform.sql — put Others Say numbers back on the right
--  platform.
--
--  worker.js wrote the first organic_perf row for every Others Say
--  creative with platform = 'fb', whatever platform the post was on. The
--  function took the short code 'ig' | 'tt' | 'fb' and silently defaulted
--  to 'fb', while the job handed it 'instagram' | 'tiktok' | 'facebook',
--  so neither branch ever matched. The same line put the scrape stamp on
--  fb_last_scraped_at and the creator's Instagram or TikTok handle in
--  fb_handle.
--
--  The add picks its link as ig || tt || fb, so where a creative has an
--  Instagram link the numbers in that row are Instagram's.
--
--  HOW A MISFILED ROW IS IDENTIFIED
--
--  Both the add and the sync stamp fb_last_scraped_at, and both write
--  fb_handle, so neither tells you which one wrote the row. What does is
--  that the sync has produced nothing at all for the real platform:
--
--    the creative has an Instagram or TikTok link, and
--    it has no organic_perf row for that platform, and
--    ig_last_scraped_at and tt_last_scraped_at are both null.
--
--  The add always writes an fb row for an Others Say creative, so when
--  the sync has demonstrably never run on the platform the post is
--  actually on, the fb row is the add's.
--
--  That is a strong signal, not a proof. Step 0 reads only and prints
--  fb_handle beside each row: if it is the creator's handle rather than a
--  Facebook page, the row is the add's. Look at it before running step 1.
-- =====================================================================

-- ── 0. Read only. Run this on its own and check fb_handle. ───────────
with suspect as (
  select c.creative_id,
         case when c.ig_link is not null then 'ig' else 'tt' end as belongs_to,
         c.fb_link is not null as has_fb_link,
         c.fb_handle, c.fb_last_scraped_at
    from creatives c
   where c.type = 'Others Say'
     and (c.ig_link is not null or c.tt_link is not null)
     and c.ig_last_scraped_at is null
     and c.tt_last_scraped_at is null
     and exists (select 1 from organic_perf o
                  where o.creative_id = c.creative_id and o.platform = 'fb')
     and not exists (select 1 from organic_perf o
                      where o.creative_id = c.creative_id
                        and o.platform in ('ig', 'tt'))
)
select s.*, o.views, o.likes, o.comments, o.shares
  from suspect s
  join organic_perf o
    on o.creative_id = s.creative_id and o.platform = 'fb'
 order by s.creative_id;

-- ── 1. The repair ────────────────────────────────────────────────────
begin;

create temporary table _misfiled on commit drop as
select c.creative_id,
       case when c.ig_link is not null then 'ig' else 'tt' end as belongs_to
  from creatives c
 where c.type = 'Others Say'
   and (c.ig_link is not null or c.tt_link is not null)
   and c.ig_last_scraped_at is null
   and c.tt_last_scraped_at is null
   and exists (select 1 from organic_perf o
                where o.creative_id = c.creative_id and o.platform = 'fb')
   and not exists (select 1 from organic_perf o
                    where o.creative_id = c.creative_id
                      and o.platform in ('ig', 'tt'));

-- Move the row rather than copying it. A move keeps the numbers without
-- this file having to name every column on organic_perf, and it leaves
-- no Facebook row showing Instagram figures while the sync catches up.
update organic_perf o
   set platform = m.belongs_to
  from _misfiled m
 where o.creative_id = m.creative_id
   and o.platform = 'fb';

-- The handle and the stamp went to the Facebook columns too. Clearing
-- all three stamps is the point of this step, not tidying: the sync
-- treats a null as never read and will fetch every platform on its next
-- run whatever the post's age. That is what rebuilds the Facebook row
-- for the creatives that do have a Facebook link, and fills in TikTok,
-- which was never fetched at all.
update creatives c
   set fb_handle          = null,
       fb_last_scraped_at = null,
       ig_last_scraped_at = null,
       tt_last_scraped_at = null
  from _misfiled m
 where c.creative_id = m.creative_id;

commit;

-- ── 2. Confirm. Each creative should now show its real platforms. ────
select c.creative_id, o.platform, o.views, o.likes, o.comments,
       c.ig_last_scraped_at, c.tt_last_scraped_at, c.fb_last_scraped_at
  from creatives c
  join organic_perf o on o.creative_id = c.creative_id
 where c.type = 'Others Say'
   and c.creative_id in (select creative_id from creatives
                          where type = 'Others Say' and ig_link is not null)
 order by c.creative_id, o.platform;

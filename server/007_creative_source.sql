-- =====================================================================
--  007_creative_source.sql — who made an Others Say post
--
--  Others Say covers two different things that have been pooled until
--  now: content from a creator the brand briefed and paid, and content
--  posted by members of the public about the brand. They behave
--  differently and they are acted on differently, so the analysis
--  should not average them together.
--
--  This is a sub-type rather than a third value of `type`, because
--  `type` is wired into the creative_id prefix, the threshold platform
--  keys (ig_os, tt_organic and so on), the Brand Say / Others Say split
--  and every filter. A separate column leaves all of that working and
--  still lets creator and community be separated everywhere it matters.
--
--  Safe to run more than once.
-- =====================================================================

alter table creatives add column if not exists source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'creatives_source_check'
  ) then
    alter table creatives add constraint creatives_source_check
      check (source is null or source in ('creator', 'community'));
  end if;
end $$;

comment on column creatives.source is
  'Sub-type of Others Say: creator (briefed and paid) or community (posted by the public). Null for Brand Say.';

-- Everything already in the system as Others Say was briefed content, so
-- it becomes creator. Community posts start from this migration onward.
update creatives
   set source = 'creator'
 where type = 'Others Say' and source is null;

create index if not exists creatives_brand_source on creatives (brand_id, source);

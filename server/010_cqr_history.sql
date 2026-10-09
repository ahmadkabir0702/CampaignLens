-- =====================================================================
--  010_cqr_history.sql — when a rating changed, and what it was before
--
--  A creative that was Good in its first fortnight can be Average by its
--  sixth week while the lifetime figures barely move: the early volume
--  drowns the recent decline, so nobody sees the slide. The windowed
--  view in 011 is what detects that. This table remembers it.
--
--  A row is written only when the rating actually changes, so the table
--  stays small and reads as a history of decisions rather than a log of
--  every night nothing happened.
--
--  Safe to run more than once.
-- =====================================================================

create table if not exists cqr_history (
  id            bigserial primary key,
  creative_id   text        not null,
  brand_id      text,
  channel       text        not null check (channel in ('paid', 'organic')),
  platform      text        not null,
  -- The rating over the trailing window, which is the one that moves.
  cqr           text,
  -- The lifetime rating at the same moment, so the two can be compared
  -- and so this table explains what the rest of the app was showing.
  cqr_lifetime  text,
  -- What produced it, kept so a past rating can be understood without
  -- recomputing it from data that has since changed.
  hook_rate     numeric,
  hold_rate     numeric,
  signal        numeric,
  impressions   bigint,
  spend         numeric,
  changed_at    timestamptz not null default now(),
  -- The first row for a creative-platform records where it started.
  is_first      boolean     not null default false
);

create index if not exists cqr_history_lookup
  on cqr_history (creative_id, channel, platform, changed_at desc);
create index if not exists cqr_history_brand
  on cqr_history (brand_id, changed_at desc);

comment on table cqr_history is
  'Change-only log of creative ratings. One row when the rating moves, never one per run. cqr is the trailing-window rating; cqr_lifetime is what the rest of the app shows at the same moment.';

-- ---------------------------------------------------------------------
--  The current rating per creative, channel and platform, so the writer
--  can compare against it without scanning the whole table.
-- ---------------------------------------------------------------------
create or replace view v_cqr_latest as
select distinct on (creative_id, channel, platform)
       creative_id, brand_id, channel, platform,
       cqr, cqr_lifetime, changed_at
  from cqr_history
 order by creative_id, channel, platform, changed_at desc;

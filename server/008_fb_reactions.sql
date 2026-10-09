-- =====================================================================
--  008_fb_reactions.sql — Facebook reaction breakdown
--
--  Facebook reports reactions by type on posts the brand owns. A like
--  and an angry both count as one reaction in the totals, so a post can
--  look engaged while the engagement is people objecting to it.
--
--  This is the one sentiment signal available through the official APIs
--  without reading anyone's comments. Instagram and TikTok report a
--  single like count with no breakdown, so these columns stay null for
--  them.
--
--  Safe to run more than once.
-- =====================================================================

alter table organic_perf add column if not exists reaction_like  bigint;
alter table organic_perf add column if not exists reaction_love  bigint;
alter table organic_perf add column if not exists reaction_haha  bigint;
alter table organic_perf add column if not exists reaction_wow   bigint;
alter table organic_perf add column if not exists reaction_sad   bigint;
alter table organic_perf add column if not exists reaction_angry bigint;

comment on column organic_perf.reaction_angry is
  'Facebook reaction counts by type, for posts the brand owns. Null on Instagram and TikTok, which report one like total with no breakdown.';

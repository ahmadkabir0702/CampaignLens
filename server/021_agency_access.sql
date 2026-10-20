-- =====================================================================
--  021 — agency access: Creative Hub and Pre-tests only
--
--  Agencies see how their own creative performed and run pre-tests on
--  the work they are making. They do not see the brand's media
--  numbers, the creator roster, share of voice, or Ask Lens, and they
--  cannot add creatives.
--
--  Same approach as 014: one flag per section, default true, so every
--  other account keeps what it has. Only agency accounts lose anything.
--
--  Takes effect on the agency's next request (the server re-reads the
--  flags for a session signed in before this change), not only at the
--  next sign-in.
-- =====================================================================

alter table app_users
  add column if not exists can_media    boolean not null default true,   -- Media Summary
  add column if not exists can_creators boolean not null default true,   -- Creators
  add column if not exists can_sov      boolean not null default true;   -- Share of voice

-- Matched on the username prefix, as in 014, so the next agency account
-- created as agency.<name> is covered without being listed here. A new
-- agency account made with a different name needs these flags set by hand.
update app_users
   set can_ask_lens     = false,
       can_add_creative = false,
       can_media        = false,
       can_creators     = false,
       can_sov          = false,
       can_pretest      = true
 where username like 'agency.%';

-- What this leaves:
--   agency.*    Creative Hub and Pre-tests only
--   everyone else unchanged
select username, can_ask_lens, can_add_creative, can_pretest, can_media, can_creators, can_sov
  from app_users
 where is_active
 order by can_media, username;

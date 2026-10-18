-- =====================================================================
--  014 — per-account feature access
--
--  Until now an account's only distinctions were is_internal and role.
--  That was enough while every login belonged to the team. It stopped
--  being enough once agencies got logins: an agency should see how its
--  own creative performed without being able to ask the assistant
--  open-ended questions about the brand, or add creatives to it.
--
--  Three flags rather than one "is_agency" boolean, because the
--  restrictions will not stay in step with each other. Pre-tests are
--  already allowed for agencies while the other two are not.
--
--  Default true, so every existing account keeps what it has and only
--  what this migration names is taken away. A new account is permissive
--  unless someone decides otherwise, which is the right default for a
--  tool used mostly by its own team.
-- =====================================================================

alter table app_users
  add column if not exists can_ask_lens     boolean not null default true,
  add column if not exists can_add_creative boolean not null default true,
  add column if not exists can_pretest      boolean not null default true;

-- Agencies: no assistant, no adding creatives. Pre-tests stay, since the
-- agencies are the ones making the work being tested.
--
-- Matched on the username prefix because that is how the accounts were
-- built, and listing them individually would silently miss the next one.
update app_users
   set can_ask_lens = false,
       can_add_creative = false
 where username like 'agency.%';

-- What this leaves:
--   usl.*      everything
--   ms.*       everything
--   agency.*   pre-tests only
--   kabir      everything (admin)
--   coordinator everything, and it needs add-creative for its own flow

select username, is_internal, can_ask_lens, can_add_creative, can_pretest
  from app_users
 where is_active
 order by can_ask_lens, username;

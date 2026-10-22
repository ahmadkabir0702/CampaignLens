-- =====================================================================
--  038 — Who added each campaign, and when
--
--  Unilever and Mindshare accounts now add campaigns themselves from the
--  app (Creative Hub > Campaigns, or the Add creative form). These two
--  columns show who added each one. Existing campaigns keep empty values.
--
--  Safe to re-run.
-- =====================================================================

begin;

alter table campaigns add column if not exists created_by text;
-- Added without a default first, so campaigns that already exist are left
-- empty rather than stamped with today; new ones get the time they are added.
alter table campaigns add column if not exists created_at timestamptz;
alter table campaigns alter column created_at set default now();

insert into schema_migrations (name) values ('038_campaign_owner.sql') on conflict (name) do nothing;

commit;

select count(*) as campaigns from campaigns;

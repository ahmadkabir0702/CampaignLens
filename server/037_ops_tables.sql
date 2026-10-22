-- =====================================================================
--  037 — Migration log, error log and usage counts
--
--  The app creates these tables itself on first use, so this file is not
--  required for it to work. Run it once to record the migrations that
--  have already been run, so the admin page can show what is missing.
--
--    schema_migrations  one row per numbered SQL file that has been run.
--                       Every migration from 038 on ends by adding its
--                       own row (see the last statement here).
--    app_errors         server faults, shown on the admin page
--    app_usage          sections opened and Ask Lens questions, per day
--                       and login
--
--  Safe to re-run.
-- =====================================================================

begin;

create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists app_errors (
  id         bigserial primary key,
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  count      integer not null default 1,
  tag        text not null,
  message    text not null,
  path       text,
  username   text
);
create index if not exists app_errors_last on app_errors (last_at desc);

create table if not exists app_usage (
  day        date not null,
  username   text not null,
  section    text not null,
  count      integer not null default 0,
  primary key (day, username, section)
);

-- Server-only tables: not reachable through Supabase's public API.
alter table schema_migrations enable row level security;
alter table app_errors        enable row level security;
alter table app_usage         enable row level security;
alter table if exists app_jobs enable row level security;

-- The migrations already run. Remove any line for a file you know was
-- NOT run on this database before running this.
insert into schema_migrations (name) values
  ('005_creative_tags_and_cards.sql'), ('006_organic_history.sql'), ('007_creative_source.sql'),
  ('008_fb_reactions.sql'), ('009_creator_led.sql'), ('010_cqr_history.sql'), ('011_paid_windowed.sql'),
  ('012_brainsuite.sql'), ('013_fix_os_platform.sql'), ('014_user_features.sql'),
  ('015_login_and_passwords.sql'), ('016_remove_phantom_fb_rows.sql'), ('017_share_of_voice.sql'),
  ('018_sov_seed_skin_cleansing.sql'), ('019_sov_pipeline.sql'), ('020_sov_config_skin_cleansing.sql'),
  ('021_agency_access.sql'), ('022_carousels_statics.sql'), ('023_cqr_fixes.sql'),
  ('024_sunsilk_like_vaseline.sql'), ('025_calibrate_paid_benchmarks.sql'),
  ('026_premium_brand_paid_bars.sql'), ('027_creator_bar_brand_weighted.sql'),
  ('028_creator_bar_per_brand.sql'), ('029_app_sessions.sql'), ('030_sov_monthly_panels.sql'),
  ('031_sov_study_collabs_panels.sql'), ('032_sov_study_voices.sql'), ('034_organic_cqr_boosted.sql'),
  ('035_campaign_signoff.sql'), ('036_repurposing.sql')
on conflict (name) do nothing;

-- This file's own row. Every new migration ends with a line like this.
insert into schema_migrations (name) values ('037_ops_tables.sql') on conflict (name) do nothing;

commit;

select count(*) as migrations_recorded from schema_migrations;

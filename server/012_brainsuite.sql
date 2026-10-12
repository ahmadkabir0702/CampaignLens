-- =====================================================================
--  012_brainsuite.sql — Brainsuite pre-tests and creative scores
--
--  Two kinds of Brainsuite test share one table:
--    pretest   a video a user uploads before it runs. Its summary is
--              deleted PRETEST_TTL_HOURS after it finishes.
--    creative  a Brand Say or Others Say video added to Campaign Lens,
--              scored in the background. Kept.
--
--  brainsuite_jobs is never deleted from. It is the record of every
--  test that used Brainsuite quota (started_at is set at that moment).
--  brainsuite_results holds the slim summary (about 8 KB), not the
--  570 KB report, and no media: images are fetched from Brainsuite on
--  demand because their links expire after an hour.
--
--  Safe to run more than once.
-- =====================================================================

create table if not exists brainsuite_jobs (
  id            uuid primary key default gen_random_uuid(),
  bs_job_id     uuid unique,
  kind          text not null check (kind in ('pretest', 'creative')),
  creative_id   text,
  brand_id      text not null,
  requested_by  text,                 -- app_users.username; null for auto-scoring
  status        text not null default 'uploading'
                check (status in ('uploading','queued','analysing','succeeded','failed','expired','skipped')),
  channel       text not null,
  briefing      jsonb not null default '{}'::jsonb,
  asset_name    text,                 -- what the user called it (pre-tests)
  file_name     text,
  file_bytes    bigint,
  file_sha256   text,
  reused_from   uuid references brainsuite_jobs(id) on delete set null,
  error         text,
  poll_count    int not null default 0,
  last_polled_at timestamptz,         -- a stalled poll chain is restarted from this
  created_at    timestamptz not null default now(),
  started_at    timestamptz,          -- when /start succeeded: the moment quota is used
  completed_at  timestamptz,
  expires_at    timestamptz           -- pre-tests only, set when the result arrives
);

create index if not exists brainsuite_jobs_brand_kind_idx
  on brainsuite_jobs (brand_id, kind, created_at desc);
create index if not exists brainsuite_jobs_creative_idx
  on brainsuite_jobs (creative_id) where creative_id is not null;
create index if not exists brainsuite_jobs_sha_idx
  on brainsuite_jobs (file_sha256) where status = 'succeeded';
create index if not exists brainsuite_jobs_started_idx
  on brainsuite_jobs (started_at) where started_at is not null;
create index if not exists brainsuite_jobs_expiry_idx
  on brainsuite_jobs (expires_at) where kind = 'pretest' and status = 'succeeded';

-- For databases that ran an earlier copy of this file.
alter table brainsuite_jobs add column if not exists last_polled_at timestamptz;

create table if not exists brainsuite_results (
  job_id        uuid primary key references brainsuite_jobs(id) on delete cascade,
  total_score   numeric,
  total_rating  text,
  summary       jsonb not null,
  weblink       text,
  created_at    timestamptz not null default now()
);

-- What Brainsuite needs to know about each brand. Business group and
-- category must match Brainsuite's own lists exactly; a brand without them
-- is never sent (its creatives are marked 'skipped').
alter table brands add column if not exists bs_business_group text;
alter table brands add column if not exists bs_category       text;
alter table brands add column if not exists bs_language       text not null default 'en-US';
-- Background scoring of added creatives uses quota, so it is opt-in per brand.
alter table brands add column if not exists bs_auto_score     boolean not null default false;

-- Starting values for the brands Campaign Lens carries today, matched by
-- name. Only fills brands that have no mapping yet, so an edit made by hand
-- is never overwritten. Check these, and fill any brand not listed:
--   update brands set bs_business_group = '...', bs_category = '...' where brand_id = '...';
update brands set bs_business_group = 'Personal Care', bs_category = 'Skin Cleansing'
 where bs_business_group is null and lower(name) similar to '(lifebuoy|lux|pears)%';
update brands set bs_business_group = 'Personal Care', bs_category = 'Deodorants'
 where bs_business_group is null and lower(name) like 'rexona%';
update brands set bs_business_group = 'Personal Care', bs_category = 'Oral Care'
 where bs_business_group is null and lower(name) like 'signal%';
update brands set bs_business_group = 'Beauty & Wellbeing', bs_category = 'Skin Care'
 where bs_business_group is null and (lower(name) like 'vaseline%' or lower(name) like 'pond%');
update brands set bs_business_group = 'Nutrition', bs_category = 'Scratch Cooking Aids'
 where bs_business_group is null and lower(name) like 'knorr%';
update brands set bs_business_group = 'Home Care', bs_category = 'Fabric Cleaning'
 where bs_business_group is null and lower(name) like 'surf%';

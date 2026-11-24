-- =====================================================================
--  045 — Sound and Funnel fit, next to the Pre-test Score
--
--  One row per tracked creative (kind 'creative') and one per pre-test
--  (kind 'pretest', linked to its brainsuite_jobs row). The Pre-test Score
--  tables are not changed except for one column: the temporary upload's
--  object name, so the worker can find the file and delete it.
--
--    analysis   the video analysis fields the checks read (format, hook,
--               captions, offer, reasons...). For pre-tests this is the
--               only copy; for tracked creatives most of it is also on
--               the creatives row.
--    sound      loudness, peak, voice against music, brand named, works
--               with the sound off. Null for photos and carousels.
--    funnel     awareness, consideration and conversion fit, what the ad
--               is built for, and what would help.
--
--  Pre-test rows expire with their report (PRETEST_TTL_HOURS).
--  Safe to run more than once.
-- =====================================================================

begin;

create table if not exists lens_checks (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('pretest', 'creative')),
  creative_id   text,
  pretest_id    uuid references brainsuite_jobs(id) on delete cascade,
  brand_id      text not null,
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  analysis      jsonb,
  sound         jsonb,
  funnel        jsonb,
  sound_score   int,
  funnel_intent text,
  funnel_fit    int,       -- the fit score of the stage it is built for
  error         text,
  cost_usd      numeric,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz
);

create unique index if not exists lens_checks_creative_uidx on lens_checks (creative_id) where kind = 'creative';
create unique index if not exists lens_checks_pretest_uidx  on lens_checks (pretest_id)  where kind = 'pretest';
create index if not exists lens_checks_brand_idx on lens_checks (brand_id, kind);

-- Where a pre-test's video waits between the browser's upload and the worker.
alter table brainsuite_jobs add column if not exists upload_key text;
-- When the worker finished sending that file to the scoring service and
-- started the test. A retried worker job skips the send once this is set.
alter table brainsuite_jobs add column if not exists bs_uploaded_at timestamptz;

-- Server-only, like the other app tables.
alter table lens_checks enable row level security;

-- For the recommendation writer (n8n) and anything else that wants every
-- test a creative has in one row. Plain numbers and short text only.
create or replace view v_creative_tests as
select c.creative_id,
       c.brand_id,
       bs.total_score                  as pretest_score,
       bs.total_rating                 as pretest_rating,
       bs.categories                   as pretest_categories,
       bs.to_improve                   as pretest_to_improve,
       l.sound_score,
       l.sound -> 'checks'             as sound_checks,
       l.funnel_intent                 as built_for,
       l.funnel_fit                    as built_for_fit,
       (l.funnel -> 'stages' -> 'Awareness'     ->> 'score')::int as awareness_fit,
       (l.funnel -> 'stages' -> 'Consideration' ->> 'score')::int as consideration_fit,
       (l.funnel -> 'stages' -> 'Conversion'    ->> 'score')::int as conversion_fit,
       l.funnel ->> 'verdict'          as funnel_verdict,
       l.funnel ->> 'basis'            as funnel_basis
  from creatives c
  left join lateral (
    select r.total_score, r.total_rating,
           r.summary -> 'categories' as categories,
           (select jsonb_agg(jsonb_build_object('name', k ->> 'name', 'value', k ->> 'display', 'rating', k ->> 'rating'))
              from jsonb_array_elements(r.summary -> 'kpis') k
             where k ->> 'rating' in ('negative','veryNegative','negativeTooLow','negativeTooHigh','medium')) as to_improve
      from brainsuite_jobs j join brainsuite_results r on r.job_id = j.id
     where j.creative_id = c.creative_id and j.kind = 'creative' and j.status = 'succeeded'
     order by j.completed_at desc limit 1
  ) bs on true
  left join lens_checks l on l.kind = 'creative' and l.creative_id = c.creative_id and l.status = 'succeeded';

insert into schema_migrations (name) values ('045_lens_checks.sql') on conflict (name) do nothing;

commit;

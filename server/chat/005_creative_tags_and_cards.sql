-- Ask Lens: creative tags (Phase 1) and insight cards
--
-- Adds the tags Gemini records when it watches each video, so the chat and
-- the nightly analysis read tags instead of second-by-second descriptions.
-- The second-by-second timeline is kept exactly as before.
--
-- Safe to run before or after the new worker.js deploys: every column is
-- nullable and nothing reads them until the new code is live.

alter table creatives
  add column if not exists logo_first_3s     boolean,  -- brand or logo visible in the first 3 seconds
  add column if not exists captions          boolean,  -- captions or subtitles for spoken words
  add column if not exists voiceover         boolean,
  add column if not exists music             boolean,
  add column if not exists cta               boolean,  -- an explicit call to action
  add column if not exists language          text,
  add column if not exists talent            text,     -- who is on screen
  add column if not exists production_style  text,
  add column if not exists aspect_ratio      text;

alter table creatives drop constraint if exists creatives_language_chk;
alter table creatives add constraint creatives_language_chk
  check (language is null or language in ('sinhala','tamil','english','mixed','none'));
alter table creatives drop constraint if exists creatives_talent_chk;
alter table creatives add constraint creatives_talent_chk
  check (talent is null or talent in ('creator','celebrity','model','everyday_person','none'));
alter table creatives drop constraint if exists creatives_production_style_chk;
alter table creatives add constraint creatives_production_style_chk
  check (production_style is null or production_style in ('phone_shot','polished'));
alter table creatives drop constraint if exists creatives_aspect_ratio_chk;
alter table creatives add constraint creatives_aspect_ratio_chk
  check (aspect_ratio is null or aspect_ratio in ('vertical','square','horizontal'));

-- Insight cards. Each finding is now a structured card: headline, why, test,
-- plus the proof and example creatives chosen in code.
alter table brand_insights
  add column if not exists card    jsonb,
  add column if not exists impact  numeric,
  add column if not exists status  text;   -- pass, fixed or rejected

-- Queue every creative to be re-tagged with the new tags. The backfill
-- script picks these up; it costs about 1.5 cents per video.
update creatives set attrs_version = 0 where attrs_version > 0;

select brand_id, count(*) as queued
from creatives
where attrs_version = 0 and coalesce(tt_link, ig_link, fb_link) is not null
group by brand_id order by queued desc;

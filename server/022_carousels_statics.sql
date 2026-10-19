-- =====================================================================
--  022 — carousels and static posts
--
--  Until now every creative was a video, apart from a community page's
--  Facebook photo. This lets Brand Say and Others Say both carry:
--
--    Photo     one image (Instagram, Facebook, TikTok)
--    Carousel  several slides (Instagram carousel, Facebook album,
--              TikTok photo post)
--
--  A static has no views, watch time or retention, so it cannot be rated
--  the way a video is. It is rated on engagement instead, against the
--  bands in static_thresholds, and compared only with other statics.
--
--  Safe to re-run.
-- =====================================================================

-- What each slide shows, from the analysis, and a permanent copy of it.
--   [{ "i": 1, "type": "image", "image": "<stored url>", "d": "…",
--      "on_screen": "product", "product_visible": true, "has_text": true }]
alter table creatives
  add column if not exists slides      jsonb,
  add column if not exists slide_count int;

-- Follower count at the time of the post. Others Say statics have no
-- public views or reach on Instagram, so engagement is read per follower.
alter table organic_perf
  add column if not exists followers bigint;

-- content_type held only 'Video' and 'Photo'. If a check constraint limits
-- it, widen it to include 'Carousel', keeping every value already in use.
do $$
declare
  c record;
  vals text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'creatives'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%content_type%'
  loop
    execute format('alter table creatives drop constraint %I', c.conname);
    select string_agg(quote_literal(v), ', ') into vals
      from (select distinct content_type as v from creatives where content_type is not null
            union select unnest(array['Video', 'Photo', 'Carousel'])) x;
    execute format('alter table creatives add constraint %I check (content_type is null or content_type in (%s))',
                   c.conname, vals);
  end loop;
end $$;

-- Others Say Instagram syncs pick creatives by ig_shortcode. Fill it for
-- /p/ links too (photos and carousels), now and on every new creative, in
-- case whatever fills it today only reads /reel/ links. A trigger named
-- zz_ runs after any existing one and only fills a value that is missing.
do $$
declare gen "char";
begin
  select attgenerated into gen from pg_attribute
   where attrelid = 'creatives'::regclass and attname = 'ig_shortcode' and not attisdropped;
  if not found then
    raise notice 'creatives.ig_shortcode does not exist; skipped';
    return;
  end if;
  if gen <> '' then
    raise notice 'creatives.ig_shortcode is a generated column; check its expression reads /p/ links';
    return;
  end if;

  update creatives
     set ig_shortcode = substring(ig_link from 'instagram\.com/(?:[^/]+/)?(?:p|reels?|tv)/([A-Za-z0-9_-]+)')
   where ig_shortcode is null and ig_link is not null;

  create or replace function zz_fill_ig_shortcode() returns trigger language plpgsql as $f$
  declare sc text;
  begin
    sc := substring(new.ig_link from 'instagram\.com/(?:[^/]+/)?(?:p|reels?|tv)/([A-Za-z0-9_-]+)');
    if new.ig_shortcode is null
       or (tg_op = 'UPDATE' and new.ig_link is distinct from old.ig_link and sc is not null) then
      new.ig_shortcode := coalesce(sc, new.ig_shortcode);
    end if;
    return new;
  end $f$;

  drop trigger if exists zz_fill_ig_shortcode on creatives;
  create trigger zz_fill_ig_shortcode before insert or update of ig_link on creatives
    for each row execute function zz_fill_ig_shortcode();
end $$;

-- Rating bands for statics, in percent. Brand rows (brand_id set) win over
-- the global ones. These are starting values: tune them once a few weeks
-- of statics are in.
--
--   basis 'reach'      (likes + comments + shares + saves) / reach
--   basis 'views'      Brand Say: same / views.  Others Say: (likes + 2 x comments) / views
--   basis 'followers'  (likes + 2 x comments) / followers   (Others Say)
create table if not exists static_thresholds (
  id            bigserial primary key,
  brand_id      text,
  platform      text not null,          -- ig | fb | tt
  creative_type text not null,          -- Brand Say | Others Say
  basis         text not null,          -- reach | views | followers
  good_gte      numeric not null,
  poor_lt       numeric not null,
  updated_at    timestamptz not null default now()
);
create unique index if not exists static_thresholds_key
  on static_thresholds (coalesce(brand_id, ''), platform, creative_type, basis);

insert into static_thresholds (brand_id, platform, creative_type, basis, good_gte, poor_lt) values
  (null, 'ig', 'Brand Say',  'reach',     6,   2),
  (null, 'ig', 'Brand Say',  'views',     4,   1.5),
  (null, 'fb', 'Brand Say',  'reach',     4,   1),
  (null, 'fb', 'Brand Say',  'views',     3,   0.8),
  (null, 'tt', 'Brand Say',  'reach',     8,   3),
  (null, 'tt', 'Brand Say',  'views',     6,   2),
  (null, 'ig', 'Others Say', 'followers', 3,   1),
  (null, 'ig', 'Others Say', 'views',     6,   2),
  (null, 'fb', 'Others Say', 'followers', 1,   0.2),
  (null, 'fb', 'Others Say', 'views',     4,   1),
  (null, 'tt', 'Others Say', 'followers', 3,   1),
  (null, 'tt', 'Others Say', 'views',     6,   2)
on conflict do nothing;

comment on table static_thresholds is
  'Good and Poor bands for photo and carousel posts, in percent. Statics are rated on engagement because they have no views or watch time. Brand rows override the global ones.';

select platform, creative_type, basis, good_gte, poor_lt
  from static_thresholds where brand_id is null order by creative_type, platform, basis;

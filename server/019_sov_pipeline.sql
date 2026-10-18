-- =====================================================================
--  019 — Share of voice: weekly pipeline
--
--  Everything the weekly run needs lives here, so adding a category is
--  configuration, not code:
--
--    sov_category_brands   + where each brand publishes and how it is named
--    sov_category_config   what counts as the category, what to search
--    sov_raw_posts         collected content, labelled, kept ~4 months
--    sov_raw_comments      collected conversation, labelled, no names kept
--    sov_creators          creator country, checked once and reused
--    sov_runs              one row per run: status, phase, credits, errors
--
--  The raw tables are internal. Nothing in them is sent to the browser:
--  /api/sov reads only the published shares from 017.
-- =====================================================================

alter table sov_category_brands
  add column if not exists facebook_url     text,
  add column if not exists instagram_handle text,
  add column if not exists tiktok_handle    text,
  -- Patterns (JavaScript regular expressions, case-insensitive) that name
  -- the brand, in any script: 'life\s?buoy', 'ලයිෆ්බෝයි', 'லைஃப்பாய்'.
  add column if not exists terms        text[] not null default '{}',
  add column if not exists hashtags     text[] not null default '{}',   -- without '#'
  add column if not exists searches     text[] not null default '{}',   -- brand search phrases
  -- A name that is also an ordinary word (Lux, Pears, Velvet): it only
  -- counts next to a category word or the brand's own hashtag or handle.
  add column if not exists is_ambiguous boolean not null default false,
  -- 'core': the page is all this category, so untagged brand posts count.
  -- 'multi': the page sells other things too; a post must name the category.
  add column if not exists page_scope   text not null default 'core';

create table if not exists sov_category_config (
  category_id     text primary key references sov_categories(category_id) on delete cascade,
  is_automated    boolean not null default false,   -- the weekly run picks it up
  scope_note      text,            -- one line for the labeller: what is in and out
  category_terms  text[] not null default '{}',     -- patterns: the text is about the category
  other_products  text[] not null default '{}',     -- patterns: products outside it (brand pages)
  searches        text[] not null default '{}',     -- industry searches run on TikTok, any language
  facebook_searches  text[] not null default '{}',  -- the subset also run as Facebook video searches
  instagram_searches text[] not null default '{}',  -- the subset also run as Instagram reel searches
  hashtags        text[] not null default '{}',     -- Sri Lanka-specific hashtags, without '#'
  -- Brands outside the tracker, for the public view:
  --   {"Dove": {"pattern": "\\bdove\\b", "group": "Imported"}}  (a bare pattern string also works)
  other_brands    jsonb  not null default '{}',
  -- Themes the labeller may tag, code -> name shown in Campaign Lens:
  --   {"price/value": "Price and value", "fragrance": "Fragrance"}
  topics          jsonb  not null default '{}',
  window_days     int    not null default 28,       -- rolling window for the headline shares
  credit_cap      int    not null default 1500,     -- most credits one run may spend
  updated_at      timestamptz not null default now()
);

alter table sov_category_config add column if not exists topics jsonb not null default '{}';

create table if not exists sov_raw_posts (
  category_id     text not null references sov_categories(category_id) on delete cascade,
  platform        text not null,                    -- facebook | instagram | tiktok
  post_id         text not null,
  source          text not null,                    -- owned | earned | category
  owner_brand     text,                             -- owned: whose page it is on
  url             text,
  author          text,                             -- page or creator handle (public accounts)
  published_at    timestamptz,
  body            text,
  likes           bigint not null default 0,
  comments        bigint not null default 0,
  shares          bigint not null default 0,
  views           bigint not null default 0,
  is_sri_lanka    boolean,
  sl_reason       text,
  search_brands   text[] not null default '{}',
  found_via       text[] not null default '{}',
  comments_fetched_at timestamptz,
  label           jsonb,
  labelled_at     timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (category_id, platform, post_id)
);
create index if not exists sov_raw_posts_when_idx on sov_raw_posts (category_id, published_at);

create table if not exists sov_raw_comments (
  category_id     text not null,
  platform        text not null,
  post_id         text not null,
  comment_key     text not null,                    -- a hash; who wrote it is not stored
  body            text,
  published_at    timestamptz,
  likes           int not null default 0,
  kind            text not null,                    -- text | tiny | emoji | empty | tag
  is_brand_reply  boolean not null default false,   -- the brand answering on its own page
  label           jsonb,
  labelled_at     timestamptz,
  primary key (category_id, platform, comment_key),
  foreign key (category_id, platform, post_id)
    references sov_raw_posts (category_id, platform, post_id) on delete cascade
);
create index if not exists sov_raw_comments_post_idx on sov_raw_comments (category_id, platform, post_id);

create table if not exists sov_creators (
  handle      text primary key,                     -- TikTok username, lower case
  region      text,                                 -- 'LK', 'IN', ... null when private
  checked_at  timestamptz not null default now()
);

create table if not exists sov_runs (
  run_id        bigserial primary key,
  category_id   text not null references sov_categories(category_id) on delete cascade,
  status        text not null default 'running',    -- running | succeeded | failed
  phase         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  credits_start int,
  credits_end   int,
  error         text,
  stats         jsonb not null default '{}'
);
create index if not exists sov_runs_cat_idx on sov_runs (category_id, started_at desc);

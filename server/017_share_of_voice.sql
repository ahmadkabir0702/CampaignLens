-- =====================================================================
--  017 — Digital share of voice
--
--  One section in Campaign Lens per product category (skin cleansing,
--  hair care, oral care...). A brand sees the category it belongs to:
--  Lux, Lifebuoy and Pears all open the skin cleansing view, with their
--  own bar highlighted.
--
--  Everything stored here is a share (0 to 1). Post counts, comment
--  counts and mention counts are deliberately not kept, so the product
--  cannot show them by accident. The collection and labelling happen
--  outside the app; this schema only holds the published results.
--
--  A category can have many periods (a 90-day snapshot now, weekly
--  later). The app shows the latest published period.
-- =====================================================================

create table if not exists sov_categories (
  category_id   text primary key,              -- 'skin_cleansing'
  name          text not null,                 -- 'Skin cleansing'
  sort_order    int  not null default 100,
  is_active     boolean not null default true
);

-- Every brand measured in a category, Unilever or not. brand_id links to
-- the brands table only for brands that exist in Campaign Lens; that link
-- is what decides which categories a signed-in brand can open.
create table if not exists sov_category_brands (
  category_id   text not null references sov_categories(category_id) on delete cascade,
  brand_name    text not null,                 -- as shown: 'Lux', 'Rani'
  brand_id      text,                          -- 'lux'; null for competitors
  owner         text,                          -- 'Unilever', 'Hemas', ...
  is_unilever   boolean not null default false,
  sort_order    int not null default 100,
  primary key (category_id, brand_name)
);
create index if not exists sov_category_brands_brand_idx on sov_category_brands (brand_id);

create table if not exists sov_periods (
  period_id     bigserial primary key,
  category_id   text not null references sov_categories(category_id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  label         text not null,                 -- '20 Jul to 18 Oct 2026'
  platforms     text[] not null default array['Facebook','Instagram','TikTok'],
  insights      jsonb not null default '[]',   -- short plain sentences, percentages only
  is_published  boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (category_id, period_start, period_end)
);

-- One row per brand per period. All values are shares from 0 to 1.
create table if not exists sov_brand_metrics (
  period_id           bigint not null references sov_periods(period_id) on delete cascade,
  brand_name          text   not null,
  share_of_voice      numeric(6,5),   -- share of all brand mentions in the category
  share_no_contest    numeric(6,5),   -- same, leaving out contest entries and friend tags
  share_engagement    numeric(6,5),   -- share of likes, comments and shares on posts naming the brand
  share_earned        numeric(6,5),   -- share of mentions outside brand pages, category brands only
  share_public        numeric(6,5),   -- share of all public brand mentions, every brand counted
  sentiment_positive  numeric(6,5),
  sentiment_neutral   numeric(6,5),
  sentiment_negative  numeric(6,5),
  share_facebook      numeric(6,5),   -- the brand's share of voice within each platform
  share_instagram     numeric(6,5),
  share_tiktok        numeric(6,5),
  primary key (period_id, brand_name)
);

-- Everything else as (dimension, key, value):
--   weekly_share   key = week start (YYYY-MM-DD), brand_name set
--   public_brand   key = brand name, grp = kind of brand
--   topic          key = topic
--   comment_type   key = what the comment does
--   author_type    key = who posted
create table if not exists sov_breakdowns (
  period_id     bigint not null references sov_periods(period_id) on delete cascade,
  dimension     text   not null,
  key           text   not null,
  brand_name    text   not null default '',
  grp           text,
  value         numeric(6,5) not null,
  sort_order    int not null default 100,
  primary key (period_id, dimension, key, brand_name)
);

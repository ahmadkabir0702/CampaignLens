-- =====================================================================
--  046_paid_engagement.sql : engagement rate and cost per engagement
--
--  Paid engagement, counted the same way on every row:
--
--    Meta    post reactions + comments + shares + saves + link clicks
--            + Instagram follows + Facebook page likes
--    TikTok  paid likes + comments + shares + follows + destination clicks
--
--  Not counted: 3-second plays, Post engagement, Clicks (all). TikTok
--  favorites are not offered by TikTok's ads reporting, so they are left
--  out. Instagram follows count where Meta reports them.
--
--  The n8n Brand Sync writes each input and the total (engagements) on
--  every ad and day it reads. A row the sync has not read since this
--  change has engagements null: it is left out of engagement rate and
--  cost per engagement, never counted as zero.
--
--  engagement_rate_percent on paid_meta used to be Post engagement over
--  impressions. The sync now writes the new formula there instead, so
--  there is one engagement rate. post_engagements is kept as Meta sends
--  it, and nothing in Campaign Lens reads it.
--
--  Safe to run more than once.
-- =====================================================================

alter table public.paid_meta
  add column if not exists eng_reactions   integer,
  add column if not exists eng_comments    integer,
  add column if not exists eng_shares      integer,
  add column if not exists eng_saves       integer,
  add column if not exists eng_link_clicks integer,
  add column if not exists eng_ig_follows  integer,
  add column if not exists eng_page_likes  integer,
  add column if not exists engagements     integer;

alter table public.paid_tiktok
  add column if not exists eng_likes       integer,
  add column if not exists eng_comments    integer,
  add column if not exists eng_shares      integer,
  add column if not exists eng_follows     integer,
  add column if not exists eng_clicks      integer,
  add column if not exists engagements     integer,
  add column if not exists engagement_rate_percent numeric;

-- Meta account, per month: the same formula as the ads.
alter table public.account_monthly
  add column if not exists act_engagements bigint;

comment on column public.paid_meta.engagements is
  'reactions + comments + shares + saves + link clicks + Instagram follows + page likes (046). Null until the sync reads the row.';
comment on column public.paid_meta.engagement_rate_percent is
  'engagements / impressions x 100 (046). Before 046 this was Post engagement / impressions.';
comment on column public.paid_tiktok.engagements is
  'paid likes + comments + shares + follows + destination clicks (046). Null until the sync reads the row.';
comment on column public.account_monthly.act_engagement_rate is
  'Meta account: act_engagements / impressions x 100, the same formula as paid_meta (046).';

-- ---------------------------------------------------------------------
--  The re-pull and its check write here, so the result can be read back
--  with one query: what each API returned, month by month, and what it
--  offers.
-- ---------------------------------------------------------------------
create table if not exists public.engagement_repull_log (
  id           bigserial primary key,
  ran_at       timestamptz not null default now(),
  brand_id     text not null,
  platform     text not null,          -- meta | tiktok | meta_account
  period_start date,
  period_end   date,
  api_rows     integer,                -- rows the API returned
  updated_rows integer,                -- rows in Campaign Lens it filled
  error        text
);
create index if not exists engagement_repull_log_brand on public.engagement_repull_log (brand_id, platform, period_start);

create table if not exists public.engagement_checks (
  id         bigserial primary key,
  checked_at timestamptz not null default now(),
  brand_id   text not null,
  result     jsonb not null
);

-- Engagement for any date range is read per ad and day, by brand.
create index if not exists paid_meta_brand_date   on public.paid_meta   (brand_id, date);
create index if not exists paid_tiktok_brand_date on public.paid_tiktok (brand_id, date);

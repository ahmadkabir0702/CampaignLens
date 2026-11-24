-- =====================================================================
--  047_engagement_on_reach.sql: engagement rate on true reach
--
--  Engagement rate is now engagements / reach, where reach is the number
--  of different people who saw the ads in that period, as Meta and TikTok
--  report it. Reach cannot be added up across days or ads (the same person
--  would be counted again), so it is fetched from the platforms for each
--  exact period by the n8n "Reach sync" workflow and kept here.
--
--  One row per brand, platform, campaign and period:
--    campaign  ''  = the whole brand; otherwise the Campaign Lens campaign
--    period    all_time | this_year | last_30 | this_month | last_month
--              | month:YYYY-MM (whole brand only)
--  Only ads tied to Campaign Lens creatives are counted, the same ads the
--  engagements and impressions come from.
--
--  The stored per-row rates move to reach too, so there is one engagement
--  rate everywhere. Nothing is re-pulled for that: the counts are already
--  there.
--
--  Safe to run more than once.
-- =====================================================================

create table if not exists public.paid_reach (
  brand_id     text not null,
  platform     text not null,            -- meta | tiktok
  campaign     text not null default '', -- '' = whole brand
  period       text not null,
  period_start date not null,
  period_end   date not null,
  reach        bigint,                   -- null when the platform did not answer
  ad_count     integer,
  basis        text,                     -- ads: only the brand's tracked ads; account: the whole ad account
  fetched_at   timestamptz not null default now(),
  error        text,
  primary key (brand_id, platform, campaign, period)
);

alter table public.paid_reach add column if not exists basis text;

comment on table public.paid_reach is
  'True reach from Meta and TikTok for each brand, Campaign Lens campaign and period (047). Written nightly by the n8n Reach sync.';

-- One engagement rate: engagements / reach on every stored row.
update public.paid_meta
   set engagement_rate_percent = case when coalesce(reach, 0) > 0
                                      then round(engagements::numeric / reach * 100, 2) else null end
 where engagements is not null;

update public.paid_tiktok
   set engagement_rate_percent = case when coalesce(reach, 0) > 0
                                      then round(engagements::numeric / reach * 100, 2) else null end
 where engagements is not null;

update public.account_monthly
   set act_engagement_rate = case when coalesce(act_reach, 0) > 0
                                  then round(act_engagements::numeric / act_reach * 100, 2) else null end
 where act_engagements is not null;

comment on column public.paid_meta.engagement_rate_percent is
  'engagements / reach x 100 for the ad and day (047). Before 046 this was Post engagement / impressions.';
comment on column public.paid_tiktok.engagement_rate_percent is
  'engagements / reach x 100 for the ad and day (047).';
comment on column public.account_monthly.act_engagement_rate is
  'Meta account: act_engagements / act_reach x 100 (047).';

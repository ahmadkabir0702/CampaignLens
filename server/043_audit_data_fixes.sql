-- =====================================================================
--  043: data fixes from the CQR audit (26 Oct 2026)
--
--  1. Paid spend reaches its creative even when the ad name is off.
--     Ads are matched to creatives by the creative ID in the ad name. The
--     sync took the first ID-shaped text it found, so these were lost:
--       PONDS_BS_PONDS_BS_12OCT...0080    read as PONDS_BS_PONDS
--       PONDS_BS_13th September_PONDS_BS_13THSEPAWARENESS0052
--                                         read as PONDS_BS_13
--       000PONDS_BS_18THSEPSF0062         read with the 000 attached
--       SUNSILK_BS_RASHIMOVIECREATIVE0014BSAY  BSAY typed onto the ID
--     and older names that carry only the end of the ID after a |, such
--     as 000|Prathiba for VASELINE_BS_PRATHIBA.
--     match_creative_id(brand, ad name) now finds the brand's creative
--     whose full ID appears anywhere in the ad name (the longest wins),
--     or, failing that, whose ID without the brand prefix equals the part
--     of the name after the last |. Only an exact match counts.
--       - A trigger on paid_meta and paid_tiktok applies it to every row
--         written whose creative is missing or unknown.
--       - A trigger on creatives applies it when a creative is added, so
--         ads that ran before the creative was entered attach to it.
--       - Rows already stored are matched now.
--
--  2. A day whose hold is above its hook is bad data, and its hold is
--     left out of the weighted hold. Hold is counted against impressions,
--     so it cannot be above the hook. Three Vaseline creatives (PRATHIBA,
--     ROMAIN, SHANUDRIE) had one such day each on 1 Sep, with hold near
--     57% on millions of impressions, which made their whole run's hold
--     read far too high. Same view definitions as 023 otherwise.
--
--  3. SUNSILK_OS_JANANYTAMIL0015 is a creator post (Others Say), entered
--     as Brand Say.
--
--  Ratings that move are recorded in cqr_history as 'rule change'.
--  Safe to re-run. Ends with what changed.
-- =====================================================================

begin;

drop table if exists _r_before;
create temp table _r_before as
  select 'paid'::text as channel, 'meta'::text as platform, creative_id, brand_id, cqr
    from v_paid_meta_creative
  union all
  select 'paid', 'tiktok', creative_id, brand_id, cqr from v_paid_tiktok_creative
  union all
  select 'organic', s.platform, s.creative_id, c.brand_id, s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id;

drop table if exists _unmatched_before;
create temp table _unmatched_before as
  select 'meta'::text as platform, brand_id, count(*) as n_rows, sum(spend) as spend
    from paid_meta p
   where p.creative_id is null or not exists (select 1 from creatives c where c.creative_id = p.creative_id)
   group by brand_id
  union all
  select 'tiktok', brand_id, count(*), sum(spend)
    from paid_tiktok p
   where p.creative_id is null or not exists (select 1 from creatives c where c.creative_id = p.creative_id)
   group by brand_id;

-- ---------------------------------------------------------------------
-- 3. Creator post entered as Brand Say
-- ---------------------------------------------------------------------
update creatives set type = 'Others Say'
 where creative_id = 'SUNSILK_OS_JANANYTAMIL0015' and type = 'Brand Say';

-- ---------------------------------------------------------------------
-- 1. Matching ads to creatives
-- ---------------------------------------------------------------------
create or replace function public.match_creative_id(p_brand text, p_ad_name text)
returns text
language sql
stable
as $$
  with c as (
    select creative_id,
           upper(creative_id) as u,
           regexp_replace(upper(creative_id), '^[A-Z0-9]+_(BS|OS)_', '') as suffix
      from public.creatives
     where brand_id = p_brand
  ),
  nm as (
    select upper(coalesce(p_ad_name, '')) as n,
           regexp_replace(regexp_replace(upper(coalesce(p_ad_name, '')), '^.*\|', ''), '[^A-Z0-9]', '', 'g') as tail
  )
  select creative_id
    from (
      select c.creative_id, 1 as pass, length(c.u) as len
        from c, nm
       where position(c.u in nm.n) > 0
      union all
      select c.creative_id, 2, length(c.suffix)
        from c, nm
       where length(c.suffix) >= 5 and nm.tail = c.suffix
    ) m
   order by pass, len desc, creative_id
   limit 1
$$;

comment on function public.match_creative_id(text, text) is
  'The brand''s creative an ad belongs to, from the ad name: the longest creative ID found anywhere in the name, else the ID without its brand prefix equal to the part after the last |. Null when nothing matches exactly (043).';

create or replace function public.paid_resolve_creative()
returns trigger
language plpgsql
as $$
begin
  if new.creative_id is null
     or not exists (select 1 from public.creatives c where c.creative_id = new.creative_id) then
    new.creative_id := coalesce(public.match_creative_id(new.brand_id, new.ad_name), new.creative_id);
  end if;
  return new;
end
$$;

drop trigger if exists zz_paid_meta_resolve_creative on paid_meta;
create trigger zz_paid_meta_resolve_creative
  before insert or update on paid_meta
  for each row execute function public.paid_resolve_creative();

drop trigger if exists zz_paid_tiktok_resolve_creative on paid_tiktok;
create trigger zz_paid_tiktok_resolve_creative
  before insert or update on paid_tiktok
  for each row execute function public.paid_resolve_creative();

create or replace function public.creative_claim_paid()
returns trigger
language plpgsql
as $$
begin
  update public.paid_meta p
     set creative_id = new.creative_id
   where p.brand_id = new.brand_id
     and (p.creative_id is null
          or not exists (select 1 from public.creatives c where c.creative_id = p.creative_id))
     and public.match_creative_id(p.brand_id, p.ad_name) = new.creative_id;
  update public.paid_tiktok p
     set creative_id = new.creative_id
   where p.brand_id = new.brand_id
     and (p.creative_id is null
          or not exists (select 1 from public.creatives c where c.creative_id = p.creative_id))
     and public.match_creative_id(p.brand_id, p.ad_name) = new.creative_id;
  return null;
end
$$;

drop trigger if exists zz_creatives_claim_paid on creatives;
create trigger zz_creatives_claim_paid
  after insert or update of creative_id on creatives
  for each row execute function public.creative_claim_paid();

-- Rows already stored
update paid_meta p
   set creative_id = m.cid
  from (select id, public.match_creative_id(brand_id, ad_name) as cid
          from paid_meta pm
         where pm.creative_id is null
            or not exists (select 1 from creatives c where c.creative_id = pm.creative_id)) m
 where p.id = m.id and m.cid is not null;

update paid_tiktok p
   set creative_id = m.cid
  from (select id, public.match_creative_id(brand_id, ad_name) as cid
          from paid_tiktok pt
         where pt.creative_id is null
            or not exists (select 1 from creatives c where c.creative_id = pt.creative_id)) m
 where p.id = m.id and m.cid is not null;

-- ---------------------------------------------------------------------
-- 2. Hold above hook is left out (views as 023, with that one rule)
-- ---------------------------------------------------------------------
create or replace view v_paid_meta_creative as
with agg as (
  select s.brand_id,
         s.creative_id,
         sum(to_lkr(s.spend, s.currency, s.date)) as spend,
         sum(s.spend)                             as spend_raw,
         max(s.currency)                          as currency,
         max(s.reach)                             as reach,
         sum(s.impressions)                       as impressions,
         sum(s.hook_rate * s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0), 0) as hook_rate,
         sum(s.hold_rate * s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0 and s.hold_rate <= coalesce(s.hook_rate, s.hold_rate))
           / nullif(sum(s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0 and s.hold_rate <= coalesce(s.hook_rate, s.hold_rate)), 0) as hold_rate,
         sum(s.vtr_percent * s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0), 0) as vtr,
         sum(s.avg_watch_time * s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0), 0) as avg_watch_time,
         sum(s.w25 * s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0), 0) as w25,
         sum(s.w50 * s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0), 0) as w50,
         sum(s.w75 * s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0), 0) as w75,
         sum(s.w100 * s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0), 0) as w100,
         max(s.duration_s)                        as duration_s,
         max(s.type)                              as type,
         bool_or(upper(s.ad_status) = any (array['ACTIVE', 'ENABLE'])) as is_active
    from v_paid_meta_scored s
   group by s.brand_id, s.creative_id
),
graded as (
  select a.*,
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q
    from agg a
    left join lateral thr(a.brand_id,
           'meta_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(a.brand_id,
           'meta_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true
)
select g.brand_id, g.creative_id, g.spend, g.spend_raw, g.currency, g.reach, g.impressions,
       g.hook_rate, g.hold_rate, g.vtr, g.avg_watch_time, g.w25, g.w50, g.w75, g.w100,
       g.duration_s, g.is_active, g.hold_q, g.hook_q,
       case when paid_cqr(g.hold_q, g.hook_q) in ('Good', 'Average', 'Poor')
             and coalesce(g.impressions, 0) < 10000 then 'Low Delivery'
            else paid_cqr(g.hold_q, g.hook_q) end as cqr,
       r.recommendation, r.action_status, r.actioned_by, r.action_date, r.agency,
       r.verdict, r.working, r.not_working, r.action, r.action_type, r.priority,
       r.evidence, r.confidence
  from graded g
  left join recommendations r on r.creative_id = g.creative_id and r.platform = 'meta';

comment on view v_paid_meta_creative is
  'One row per creative on Meta. Rates are impression-weighted over the whole run and graded once (migration 023). A day whose hold is above its hook is bad data and its hold is left out (043). Under 10,000 impressions the cqr reads Low Delivery.';

create or replace view v_paid_tiktok_creative as
with agg as (
  select s.brand_id,
         s.creative_id,
         sum(to_lkr(s.spend, s.currency, s.date)) as spend,
         sum(s.spend)                             as spend_raw,
         max(s.currency)                          as currency,
         max(s.reach)                             as reach,
         sum(s.impressions)                       as impressions,
         sum(s.hook_rate * s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.hook_rate > 0 and s.impressions > 0), 0) as hook_rate,
         sum(s.hold_rate * s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0 and s.hold_rate <= coalesce(s.hook_rate, s.hold_rate))
           / nullif(sum(s.impressions::numeric) filter (where s.hold_rate > 0 and s.impressions > 0 and s.hold_rate <= coalesce(s.hook_rate, s.hold_rate)), 0) as hold_rate,
         sum(s.vtr_percent * s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.vtr_percent > 0 and s.impressions > 0), 0) as vtr,
         sum(s.avg_watch_time * s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.avg_watch_time > 0 and s.impressions > 0), 0) as avg_watch_time,
         sum(s.w25 * s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w25 > 0 and s.impressions > 0), 0) as w25,
         sum(s.w50 * s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w50 > 0 and s.impressions > 0), 0) as w50,
         sum(s.w75 * s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w75 > 0 and s.impressions > 0), 0) as w75,
         sum(s.w100 * s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0)
           / nullif(sum(s.impressions::numeric) filter (where s.w100 > 0 and s.impressions > 0), 0) as w100,
         max(s.duration_s)                        as duration_s,
         max(s.type)                              as type,
         bool_or(upper(s.ad_status) = any (array['ACTIVE', 'ENABLE'])) as is_active
    from v_paid_tiktok_scored s
   group by s.brand_id, s.creative_id
),
graded as (
  select a.*,
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q
    from agg a
    left join lateral thr(a.brand_id,
           'tt_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hook_rate') as hk(poor_lt, good_gte) on true
    left join lateral thr(a.brand_id,
           'tt_paid' || case when a.type = 'Others Say' then '_os' else '_bs' end,
           'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true
)
select g.brand_id, g.creative_id, g.spend, g.spend_raw, g.currency, g.reach, g.impressions,
       g.hook_rate, g.hold_rate, g.vtr, g.avg_watch_time, g.w25, g.w50, g.w75, g.w100,
       g.duration_s, g.is_active, g.hold_q, g.hook_q,
       case when paid_cqr(g.hold_q, g.hook_q) in ('Good', 'Average', 'Poor')
             and coalesce(g.impressions, 0) < 10000 then 'Low Delivery'
            else paid_cqr(g.hold_q, g.hook_q) end as cqr,
       r.recommendation, r.action_status, r.actioned_by, r.action_date, r.agency,
       r.verdict, r.working, r.not_working, r.action, r.action_type, r.priority,
       r.evidence, r.confidence
  from graded g
  left join recommendations r on r.creative_id = g.creative_id and r.platform = 'tiktok';

comment on view v_paid_tiktok_creative is
  'One row per creative on TikTok. Rates are impression-weighted over the whole run and graded once (migration 023). A day whose hold is above its hook is bad data and its hold is left out (043). Under 10,000 impressions the cqr reads Low Delivery.';

-- The windows, weighted the same way.
create or replace view v_paid_windowed as
with daily as (
  select brand_id, creative_id, 'meta'::text as platform, date, impressions, spend, currency,
         hook_rate, hold_rate, duration_s, type, ad_status
    from v_paid_meta_scored
   where creative_id is not null
  union all
  select brand_id, creative_id, 'tiktok'::text, date, impressions, spend, currency,
         hook_rate, hold_rate, duration_s, type, ad_status
    from v_paid_tiktok_scored
   where creative_id is not null
),
bounds as (
  select creative_id, platform, min(date) as first_day, max(date) as last_day
    from daily
   group by creative_id, platform
),
sliced as (
  select d.*, b.first_day, b.last_day, w.name as window_name
    from daily d
    join bounds b on b.creative_id = d.creative_id and b.platform = d.platform
   cross join (values ('last_7'), ('prev_7'), ('first_7'), ('lifetime')) as w(name)
   where case w.name
           when 'last_7'  then d.date >  b.last_day - 7
           when 'prev_7'  then d.date <= b.last_day - 7 and d.date > b.last_day - 14
           when 'first_7' then d.date <  b.first_day + 7
           else true
         end
),
agg as (
  select brand_id, creative_id, platform, window_name,
         max(type)                as type,
         max(duration_s)          as duration_s,
         min(date)                as from_date,
         max(date)                as to_date,
         max(last_day)            as last_day,
         count(*)                 as days,
         sum(impressions)         as impressions,
         sum(to_lkr(spend, currency, date)) as spend,
         bool_or(upper(ad_status) = any (array['ACTIVE','ENABLE'])) as is_active,
         -- Weighted by impressions, the same way the lifetime views do it.
         sum(hook_rate * impressions::numeric) filter (where hook_rate > 0 and impressions > 0)
           / nullif(sum(impressions::numeric) filter (where hook_rate > 0 and impressions > 0), 0) as hook_rate,
         sum(hold_rate * impressions::numeric) filter (where hold_rate > 0 and impressions > 0 and hold_rate <= coalesce(hook_rate, hold_rate))
           / nullif(sum(impressions::numeric) filter (where hold_rate > 0 and impressions > 0 and hold_rate <= coalesce(hook_rate, hold_rate)), 0) as hold_rate
    from sliced
   group by brand_id, creative_id, platform, window_name
)
select a.brand_id,
       a.creative_id,
       a.platform,
       a.window_name,
       a.from_date,
       a.to_date,
       a.days,
       a.impressions,
       a.spend,
       a.is_active,
       a.duration_s,
       a.hook_rate,
       a.hold_rate,
       (a.last_day >= current_date - 2) as is_current,
       band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate') as hook_q,
       case when a.duration_s is null then 'No Duration'
            else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end as hold_q,
       paid_cqr(
         case when a.duration_s is null then 'No Duration'
              else band(a.hold_rate, hd.poor_lt, hd.good_gte, 'No Hold Rate') end,
         band(a.hook_rate, hk.poor_lt, hk.good_gte, 'No Hook Rate')
       ) as cqr
  from agg a
  left join lateral thr(a.brand_id,
         case a.platform when 'meta' then 'meta_paid' else 'tt_paid' end
           || case when a.type = 'Others Say' then '_os' else '_bs' end,
         'hook_rate') as hk(poor_lt, good_gte) on true
  left join lateral thr(a.brand_id,
         case a.platform when 'meta' then 'meta_paid' else 'tt_paid' end
           || case when a.type = 'Others Say' then '_os' else '_bs' end,
         'hold_rate', a.duration_s) as hd(poor_lt, good_gte) on true;

-- ---------------------------------------------------------------------
-- Record the ratings that moved
-- ---------------------------------------------------------------------
drop table if exists _r_after;
create temp table _r_after as
  select 'paid'::text as channel, 'meta'::text as platform, creative_id, brand_id, cqr
    from v_paid_meta_creative
  union all
  select 'paid', 'tiktok', creative_id, brand_id, cqr from v_paid_tiktok_creative
  union all
  select 'organic', s.platform, s.creative_id, c.brand_id, s.cqr
    from v_organic_scored s join creatives c on c.creative_id = s.creative_id;

insert into cqr_history
  (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
   hook_rate, hold_rate, impressions, spend, is_first, reason)
select w.creative_id, w.brand_id, 'paid', w.platform, w.cqr, a.cqr,
       w.hook_rate, w.hold_rate, w.impressions, w.spend, false, 'rule change'
  from _r_after a
  join _r_before b using (channel, platform, creative_id)
  join v_paid_windowed w on w.creative_id = a.creative_id and w.platform = a.platform
                        and w.window_name = 'last_7'
 where a.channel = 'paid' and a.cqr is distinct from b.cqr
union all
select a.creative_id, a.brand_id, 'organic', a.platform, a.cqr, a.cqr,
       null, null, o.views, null, false, 'rule change'
  from _r_after a
  join _r_before b using (channel, platform, creative_id)
  join organic_perf o on o.creative_id = a.creative_id and o.platform = a.platform
 where a.channel = 'organic' and a.cqr is distinct from b.cqr;

insert into schema_migrations (name) values ('043_audit_data_fixes.sql') on conflict (name) do nothing;

commit;

-- What changed
select 'paid matched' as what, coalesce(b.brand_id, a.brand_id) as brand, coalesce(b.platform, a.platform) as platform,
       coalesce(b.n_rows, 0) || ' -> ' || coalesce(a.n_rows, 0) as unmatched_rows,
       round(coalesce(b.spend, 0)) || ' -> ' || round(coalesce(a.spend, 0)) as unmatched_spend
  from _unmatched_before b
  full join (
    select 'meta'::text as platform, brand_id, count(*) as n_rows, sum(spend) as spend
      from paid_meta p
     where p.creative_id is null or not exists (select 1 from creatives c where c.creative_id = p.creative_id)
     group by brand_id
    union all
    select 'tiktok', brand_id, count(*), sum(spend)
      from paid_tiktok p
     where p.creative_id is null or not exists (select 1 from creatives c where c.creative_id = p.creative_id)
     group by brand_id
  ) a on a.brand_id = b.brand_id and a.platform = b.platform
 where coalesce(b.n_rows, 0) <> coalesce(a.n_rows, 0)
union all
select 'rating moved', a.brand_id, a.channel || ' ' || a.platform,
       a.creative_id, coalesce(b.cqr, '(none)') || ' -> ' || coalesce(a.cqr, '(none)')
  from _r_after a
  left join _r_before b using (channel, platform, creative_id)
 where a.cqr is distinct from b.cqr and a.creative_id is not null
 order by 1, 2, 3, 4;

-- =====================================================================
--  028 — creator posts rated against the brand's own creators
--
--  Others Say videos are rated on (likes + 2 x comments) per view. Until
--  now every brand shared one bar per platform. Brands' audiences behave
--  too differently for that: Vaseline's TikTok creators score about twice
--  Knorr's, and on Facebook about five times, so a shared bar sorted posts
--  by brand rather than by how good they were.
--
--  Now a brand with at least 5 creator posts on a platform (with no spend
--  behind them) gets its own bar there, built the same way as before:
--  Good from the median, Poor below the bottom 10% (15% on Facebook).
--  The last 90 days are used when they hold 5 posts, otherwise all of the
--  brand's posts. A brand with fewer keeps using the shared bar until it
--  reaches 5. Five posts is a thin base, so a brand's bar will settle as more come in.
--
--  So a Good creator post now means "good for this brand on this
--  platform", not "good against every brand".
--
--  Whatever already calls refresh_cqr_os_benchmarks() keeps working; it
--  keeps its name and arguments and now rebuilds the brand bars as well.
--  Safe to re-run. The result lists every bar.
-- =====================================================================

begin;

-- One row per platform (brand_id null, the shared bar) plus one per brand
-- and platform that has enough posts.
alter table cqr_os_benchmarks add column if not exists brand_id text;

do $$
declare r record;
begin
  -- Drop any primary key or unique constraint on platform alone, which
  -- would stop a second row for the same platform.
  for r in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'cqr_os_benchmarks'::regclass
       and con.contype in ('p', 'u')
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(con.conkey) k join pg_attribute a
                on a.attrelid = con.conrelid and a.attnum = k) = array['platform']
  loop
    execute format('alter table cqr_os_benchmarks drop constraint %I', r.conname);
  end loop;
end $$;

create unique index if not exists cqr_os_benchmarks_key
  on cqr_os_benchmarks (platform, coalesce(brand_id, ''));

comment on column cqr_os_benchmarks.brand_id is
  'Null for the bar shared by all brands. Set for a brand''s own bar, used for that brand once it has 5 creator posts on the platform (migration 028).';

create or replace function public.refresh_cqr_os_benchmarks(min_posts integer default 20)
returns void
language plpgsql
as $function$
declare
  brand_min constant integer := 5;
begin
  -- ---- The shared bar: every brand with 3 or more posts counts equally ----
  with epv as (
    select o.platform,
           c.brand_id,
           (coalesce(o.likes, 0) + 2 * coalesce(o.comments, 0)) / o.views * 100 as epv,
           coalesce(o.time_posted, c.posted_at, c.created_at) >= now() - interval '90 days' as recent
      from public.organic_perf o
      join public.creatives c using (creative_id)
     where c.type = 'Others Say'
       and o.views > 0
       and o.likes is not null
       and not exists (select 1 from public.paid_meta   m where m.creative_id = o.creative_id)
       and not exists (select 1 from public.paid_tiktok t where t.creative_id = o.creative_id)
  ),
  windows as (
    select platform, brand_id, epv, 'recent'::text as win from epv where recent
    union all
    select platform, brand_id, epv, 'all'::text from epv
  ),
  counted as (
    select w.*, count(*) over (partition by win, platform, brand_id) as n_brand
      from windows w
  ),
  eligible as (
    select c.*, max(n_brand) over (partition by win, platform) as max_brand
      from counted c
  ),
  weighted as (
    select win, platform, brand_id, epv,
           case when max_brand >= 3 then 1.0 / n_brand else 1.0 end as w
      from eligible
     where n_brand >= 3 or max_brand < 3
  ),
  cum as (
    select win, platform, epv,
           sum(w) over (partition by win, platform order by epv, brand_id
                        rows between unbounded preceding and current row)
             / sum(w) over (partition by win, platform) as cp
      from weighted
  ),
  stats as (
    select k.win, k.platform, k.n,
           (select min(q.epv) from cum q
             where q.win = k.win and q.platform = k.platform and q.cp >= b.poor_pct) as poor_v,
           (select min(q.epv) from cum q
             where q.win = k.win and q.platform = k.platform and q.cp >= b.good_pct) as good_v
      from (select win, platform, count(*) as n from weighted group by win, platform) k
      join public.cqr_os_benchmarks b on b.platform = k.platform and b.brand_id is null
  ),
  choice as (
    select b.platform,
           coalesce(r.n, 0) as n_recent, coalesce(a.n, 0) as n_all,
           r.poor_v as poor_recent, r.good_v as good_recent,
           a.poor_v as poor_all,    a.good_v as good_all
      from public.cqr_os_benchmarks b
      left join stats r on r.platform = b.platform and r.win = 'recent'
      left join stats a on a.platform = b.platform and a.win = 'all'
     where b.brand_id is null
  )
  update public.cqr_os_benchmarks bm
     set poor_below = round((case when c.n_recent >= min_posts then c.poor_recent else c.poor_all end)::numeric, 2),
         good_from  = round((case when c.n_recent >= min_posts then c.good_recent else c.good_all end)::numeric, 2),
         basis      = case when c.n_recent >= min_posts then 'live' else 'starting' end,
         posts      = case when c.n_recent >= min_posts then c.n_recent else c.n_all end,
         updated_at = now()
    from choice c
   where c.platform = bm.platform
     and bm.brand_id is null
     and (c.n_recent >= min_posts or c.n_all >= 3);

  -- ---- Each brand's own bar, once it has brand_min posts on a platform ----
  delete from public.cqr_os_benchmarks where brand_id is not null;

  insert into public.cqr_os_benchmarks
    (platform, brand_id, poor_pct, good_pct, poor_below, good_from, basis, posts, updated_at)
  with epv as (
    select o.platform,
           c.brand_id,
           (coalesce(o.likes, 0) + 2 * coalesce(o.comments, 0)) / o.views * 100 as epv,
           coalesce(o.time_posted, c.posted_at, c.created_at) >= now() - interval '90 days' as recent
      from public.organic_perf o
      join public.creatives c using (creative_id)
     where c.type = 'Others Say'
       and o.views > 0
       and o.likes is not null
       and not exists (select 1 from public.paid_meta   m where m.creative_id = o.creative_id)
       and not exists (select 1 from public.paid_tiktok t where t.creative_id = o.creative_id)
  ),
  per as (
    select e.platform, e.brand_id, b.poor_pct, b.good_pct,
           count(*) filter (where e.recent) as n_recent,
           count(*)                         as n_all,
           percentile_cont(b.poor_pct) within group (order by e.epv) filter (where e.recent) as poor_recent,
           percentile_cont(b.good_pct) within group (order by e.epv) filter (where e.recent) as good_recent,
           percentile_cont(b.poor_pct) within group (order by e.epv) as poor_all,
           percentile_cont(b.good_pct) within group (order by e.epv) as good_all
      from epv e
      join public.cqr_os_benchmarks b on b.platform = e.platform and b.brand_id is null
     group by e.platform, e.brand_id, b.poor_pct, b.good_pct
  )
  select platform, brand_id, poor_pct, good_pct,
         round((case when n_recent >= brand_min then poor_recent else poor_all end)::numeric, 2),
         round((case when n_recent >= brand_min then good_recent else good_all end)::numeric, 2),
         case when n_recent >= brand_min then 'brand, last 90 days' else 'brand, all posts' end,
         case when n_recent >= brand_min then n_recent else n_all end,
         now()
    from per
   where brand_id is not null
     and (n_recent >= brand_min or n_all >= brand_min);
end;
$function$;

comment on function public.refresh_cqr_os_benchmarks(integer) is
  'Rebuilds cqr_os_benchmarks from creator posts with no spend behind them: the shared bar per platform (each brand with 3+ posts counted equally) and a bar per brand and platform once the brand has 5 posts (migration 028).';

-- The rating itself: the brand's own bar first, then the shared one.
CREATE OR REPLACE FUNCTION public.cqr_organic_label(o organic_perf, p_brand text, ctype text, dur numeric)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  v      numeric;
  sig    numeric;
  s_p    numeric; s_g numeric;
  plat   text := o.platform;
  suffix text := case when ctype = 'Others Say' then '_os' else '_organic' end;
begin
  v := o.views;
  if v is null or v = 0 then return 'No Views'; end if;

  -- ---------------- Influencer content: engagement per view -------------
  if ctype = 'Others Say' then
    if exists (select 1 from public.paid_meta   m where m.creative_id = o.creative_id)
       or exists (select 1 from public.paid_tiktok t where t.creative_id = o.creative_id) then
      return 'Boosted';
    end if;
    if o.likes is null then return 'Counts Hidden'; end if;
    if o.time_posted is not null and o.time_posted > now() - interval '24 hours' then
      return 'Too Early';
    end if;

    sig := (o.likes + 2 * coalesce(o.comments, 0)) / v * 100;

    -- The brand's own creator bar when it has one (migration 028),
    -- otherwise the bar shared by all brands.
    select poor_below, good_from into s_p, s_g
      from public.cqr_os_benchmarks
     where platform = plat and (brand_id = p_brand or brand_id is null)
     order by brand_id nulls last
     limit 1;
    if s_p is null then return 'No Threshold'; end if;

    if    sig <  s_p then return 'Poor';
    elsif sig >= s_g then return 'Good';
    else  return 'Average';
    end if;
  end if;

  -- ---------------- Brand Say: retention, unchanged --------------------
  if dur is null or dur = 0 then return 'No Duration'; end if;

  -- Bug fix: a missing watch time used to fall through every comparison and
  -- land on 'Average'. It now says so instead of inventing a rating.
  if o.avg_watch_time is null then return 'No Watch Time'; end if;

  sig := (o.avg_watch_time / dur) * 100;

  select poor_lt, good_gte into s_p, s_g
    from thr(p_brand, plat || suffix, 'retention_rate', dur);
  if s_p is null then return 'No Threshold'; end if;

  if    sig <  s_p then return 'Poor';
  elsif sig >= s_g then return 'Good';
  else  return 'Average';
  end if;
end
$function$;

commit;

select refresh_cqr_os_benchmarks();

select platform, coalesce(brand_id, 'all brands') as bar_for, posts, basis,
       poor_below, good_from
  from cqr_os_benchmarks
 order by platform, brand_id nulls first;

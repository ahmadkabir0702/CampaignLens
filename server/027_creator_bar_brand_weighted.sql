-- =====================================================================
--  027 — creator benchmark: every brand counts equally
--
--  Others Say videos are rated on (likes + 2 x comments) per view against
--  cqr_os_benchmarks, one bar per platform, rebuilt from recent creator
--  posts that had no spend behind them.
--
--  Every post counted once, so a brand with many posts set the bar for
--  everyone. On TikTok half the posts were Vaseline's, so the Good mark
--  was in effect "as good as Vaseline's creators", and Knorr's creators
--  read Poor on TikTok while reading Good on Instagram.
--
--  Now each brand carries the same weight: a brand's posts share one
--  brand's worth of weight between them. Only brands with at least 3 posts
--  in the period count, so one stray post cannot move the bar. If no brand
--  on a platform has 3 posts yet, every post counts once, as before.
--
--  Unchanged: Good and Poor are still the same percentiles (good_pct and
--  poor_pct on each row), boosted posts are still left out, and the last
--  90 days are used when they hold enough posts, otherwise all posts.
--
--  Whatever already calls refresh_cqr_os_benchmarks() keeps working; the
--  function keeps its name and arguments. This file also runs it once.
-- =====================================================================

create or replace function public.refresh_cqr_os_benchmarks(min_posts integer default 20)
returns void
language plpgsql
as $function$
begin
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
    select w.*,
           count(*) over (partition by win, platform, brand_id) as n_brand
      from windows w
  ),
  eligible as (
    select c.*, max(n_brand) over (partition by win, platform) as max_brand
      from counted c
  ),
  weighted as (
    -- a brand's posts share one brand's worth of weight
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
      join public.cqr_os_benchmarks b on b.platform = k.platform
  ),
  choice as (
    select b.platform,
           coalesce(r.n, 0) as n_recent, coalesce(a.n, 0) as n_all,
           r.poor_v as poor_recent, r.good_v as good_recent,
           a.poor_v as poor_all,    a.good_v as good_all
      from public.cqr_os_benchmarks b
      left join stats r on r.platform = b.platform and r.win = 'recent'
      left join stats a on a.platform = b.platform and a.win = 'all'
  )
  update public.cqr_os_benchmarks bm
     set poor_below = round((case when c.n_recent >= min_posts then c.poor_recent else c.poor_all end)::numeric, 2),
         good_from  = round((case when c.n_recent >= min_posts then c.good_recent else c.good_all end)::numeric, 2),
         basis      = case when c.n_recent >= min_posts then 'live' else 'starting' end,
         posts      = case when c.n_recent >= min_posts then c.n_recent else c.n_all end,
         updated_at = now()
    from choice c
   where c.platform = bm.platform
     and (c.n_recent >= min_posts or c.n_all >= 3);
end;
$function$;

comment on function public.refresh_cqr_os_benchmarks(integer) is
  'Rebuilds cqr_os_benchmarks from creator posts with no spend behind them. Each brand with at least 3 posts carries equal weight (migration 027).';

drop table if exists _os_before;
create temp table _os_before as select platform, poor_below, good_from, posts from cqr_os_benchmarks;

select refresh_cqr_os_benchmarks();

select b.platform,
       o.poor_below as old_poor_below, o.good_from as old_good_from, o.posts as old_posts,
       b.poor_below as new_poor_below, b.good_from as new_good_from, b.posts as new_posts, b.basis
  from cqr_os_benchmarks b
  left join _os_before o on o.platform = b.platform
 order by b.platform;

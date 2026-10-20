-- =====================================================================
--  034 — organic CQR for boosted creator posts
--
--  A creator post with spend behind it showed no organic rating, only
--  "Spend is behind this post, so its organic numbers include paid
--  delivery". That is not what the numbers are: the organic sync stops
--  reading a post as soon as it is boosted, so the organic numbers on file
--  are from before the spend. Brand Say posts were already rated on them;
--  creator posts now are too, against the same creator bars.
--
--  One caveat: a boost is noticed at the next sync after its ad data comes
--  in, so the last organic reading can include up to about a day of paid
--  delivery.
--
--  The creator bars themselves (refresh_cqr_os_benchmarks) still leave
--  boosted posts out, so nothing about how the bars are set changes.
--
--  Each rating this changes is recorded once in cqr_history as a 'rule
--  change', so it is not read as the post moving. Safe to re-run.
--  The result counts organic creator ratings before and after.
-- =====================================================================

begin;

drop table if exists _org_before;
create temp table _org_before as
  select s.creative_id, s.platform, s.cqr
    from v_organic_scored s
   where s.type = 'Others Say';

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
    -- A boosted post is rated too. The organic sync stops reading a post
    -- once it is boosted, so these numbers are from before the spend
    -- (migration 034). It used to return 'Boosted' here, with no rating.
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

-- Record the change once per rating it moved, so screens do not read it
-- as the post's rating changing on its own.
insert into cqr_history
  (creative_id, brand_id, channel, platform, cqr, cqr_lifetime,
   hook_rate, hold_rate, impressions, spend, is_first, reason)
select s.creative_id, c.brand_id, 'organic', s.platform,
       s.cqr, s.cqr, null, null, o.views, null, (l.creative_id is null), 'rule change'
  from v_organic_scored s
  join creatives c on c.creative_id = s.creative_id
  join organic_perf o on o.creative_id = s.creative_id and o.platform = s.platform
  left join v_cqr_latest l
    on l.creative_id = s.creative_id and l.channel = 'organic' and l.platform = s.platform
 where s.type = 'Others Say'
   and l.creative_id is not null
   and l.cqr is distinct from s.cqr;

commit;

select coalesce(b.cqr, 'none') as was, a.cqr as now, count(*) as ratings
  from v_organic_scored a
  left join _org_before b on b.creative_id = a.creative_id and b.platform = a.platform
 where a.type = 'Others Say'
 group by coalesce(b.cqr, 'none'), a.cqr
 order by (coalesce(b.cqr, 'none') = 'Boosted') desc, 1, 2;

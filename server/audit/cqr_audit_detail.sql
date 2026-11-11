-- Campaign Lens: CQR audit, part 2. Read only.
-- The detail needed to fix what part 1 found.
with
c as (select cr.*, to_jsonb(cr) as j from creatives cr),
links as (
  select creative_id, brand_id, 'ig'::text as platform, ig_link as link from creatives where nullif(trim(ig_link), '') is not null
  union all select creative_id, brand_id, 'tt', tt_link from creatives where nullif(trim(tt_link), '') is not null
  union all select creative_id, brand_id, 'fb', fb_link from creatives where nullif(trim(fb_link), '') is not null
),
rawpaid as (
  select 'meta'::text as platform, to_jsonb(pm) as j from paid_meta pm
  union all select 'tiktok', to_jsonb(pt) from paid_tiktok pt
),
unmatched as (
  select x.j->>'brand_id' as brand_id, x.platform,
         coalesce(x.j->>'ad_name', x.j->>'name', x.j->>'ad', '(no ad name)') as ad_name,
         x.j->>'creative_id' as creative_id,
         count(*) as rows_n,
         round(sum(coalesce((x.j->>'spend')::numeric, 0))) as spend,
         min(x.j->>'date') as first_day, max(x.j->>'date') as last_day
    from rawpaid x
   where coalesce((x.j->>'spend')::numeric, 0) > 0
     and (nullif(x.j->>'creative_id', '') is null
          or not exists (select 1 from creatives cc where cc.creative_id = x.j->>'creative_id'))
   group by 1, 2, 3, 4
),
unmatched_top as (
  select u.*, row_number() over (partition by u.brand_id order by u.spend desc) as rn from unmatched u
),
out as (

  -- A. Which columns the paid tables have (so the next fix matches them)
  select 0 as ord, 'A columns' as section, null::text as brand, 'paid_meta' as item,
         (select string_agg(k, ', ' order by k) from jsonb_object_keys((select to_jsonb(pm) from paid_meta pm limit 1)) k) as detail
  union all
  select 0, 'A columns', null, 'paid_tiktok',
         (select string_agg(k, ', ' order by k) from jsonb_object_keys((select to_jsonb(pt) from paid_tiktok pt limit 1)) k)
  union all
  select 0, 'A columns', null, 'organic_perf',
         (select string_agg(k, ', ' order by k) from jsonb_object_keys((select to_jsonb(op) from organic_perf op limit 1)) k)

  -- B. Links never read: the link, when it was posted and added
  union all
  select 1, 'B never read', l.brand_id, l.creative_id || ' / ' || l.platform,
         l.link || ' | posted ' || coalesce(c.date::text, '?')
           || ' | added ' || coalesce(left(c.j->>'created_at', 10), '?')
           || ' | type ' || coalesce(c.type, '?')
    from links l join c on c.creative_id = l.creative_id
   where coalesce(c.date::timestamptz, now()) < now() - interval '2 days'
     and not exists (select 1 from organic_perf op where op.creative_id = l.creative_id and op.platform = l.platform)

  -- C. Links shared by two creatives
  union all
  select 2, 'C shared link', min(l.brand_id), l.platform || ': ' || string_agg(l.creative_id, ', ' order by l.creative_id),
         min(l.link)
    from links l
   group by l.platform, lower(regexp_replace(split_part(l.link, '?', 1), '/+$', ''))
  having count(*) > 1

  -- D. Paid spend that does not reach a creative: top 15 ad names per brand
  union all
  select 3, 'D unmatched paid', u.brand_id, u.platform || ': ' || u.ad_name,
         coalesce(u.creative_id, '(no id)') || ' | ' || u.rows_n || ' rows | spend ' || u.spend
           || ' | ' || coalesce(u.first_day, '?') || ' to ' || coalesce(u.last_day, '?')
    from unmatched_top u where u.rn <= 15

  -- E. Hold above hook: the days behind it
  union all
  select 4, 'E hold above hook', s.j->>'brand_id', (s.j->>'creative_id') || ' ' || (s.j->>'date'),
         'impr ' || coalesce(s.j->>'impressions', '?') || ' | hook ' || coalesce(s.j->>'hook_rate', '?')
           || ' | hold ' || coalesce(s.j->>'hold_rate', '?') || ' | dur ' || coalesce(s.j->>'duration_s', '?')
    from (select to_jsonb(v) as j from v_paid_meta_scored v
           where v.creative_id in ('VASELINE_BS_PRATHIBA', 'VASELINE_BS_ROMAIN', 'VASELINE_BS_SHANUDRIE')) s

  -- F. Type that disagrees with the ID (BS / OS in the name)
  union all
  select 5, 'F type vs id', c.brand_id, c.creative_id, 'type is ' || coalesce(c.type, '(blank)')
    from c
   where (c.creative_id ilike '%\_OS\_%' and c.type is distinct from 'Others Say')
      or (c.creative_id ilike '%\_BS\_%' and c.type is distinct from 'Brand Say')

  -- G. Length on file vs watch time read back
  union all
  select 6, 'G length check', c.brand_id, c.creative_id || ' / ' || op.platform,
         'duration_s ' || coalesce(c.duration_s::text, '?') || ' | avg watch ' || coalesce((to_jsonb(op)->>'avg_watch_time'), '?')
           || ' | views ' || coalesce(op.views::text, '?')
    from c join organic_perf op on op.creative_id = c.creative_id
   where c.creative_id = 'SUNSILK_BS_11THAUGUST0007'
      or (c.duration_s > 0 and (to_jsonb(op)->>'avg_watch_time')::numeric > c.duration_s + 1)

  -- H. Creator posts with no views: what they are
  union all
  select 7, 'H no views', c.brand_id, s.creative_id || ' / ' || s.platform,
         coalesce(c.content_type, '?') || ' | ' || coalesce(case s.platform when 'ig' then c.ig_link when 'tt' then c.tt_link else c.fb_link end, '(no link)')
    from v_organic_scored s join c on c.creative_id = s.creative_id
   where s.cqr in ('No Views', 'Counts Hidden', 'No Watch Time')

  -- I. Brand Say organic: typical retention per brand and platform (why almost all Good)
  union all
  select 8, 'I retention spread', x.brand_id, x.platform,
         x.n || ' rated | median length ' || x.med_len || 's | retention p25 ' || x.p25 || '% median ' || x.p50 || '% p75 ' || x.p75 || '%'
    from (
      select c.brand_id, op.platform, count(*) as n,
             round(percentile_cont(0.5) within group (order by c.duration_s)::numeric) as med_len,
             round(percentile_cont(0.25) within group (order by (to_jsonb(op)->>'avg_watch_time')::numeric / c.duration_s * 100)::numeric) as p25,
             round(percentile_cont(0.5)  within group (order by (to_jsonb(op)->>'avg_watch_time')::numeric / c.duration_s * 100)::numeric) as p50,
             round(percentile_cont(0.75) within group (order by (to_jsonb(op)->>'avg_watch_time')::numeric / c.duration_s * 100)::numeric) as p75
        from c join organic_perf op on op.creative_id = c.creative_id
       where c.type = 'Brand Say' and c.duration_s > 0 and (to_jsonb(op)->>'avg_watch_time')::numeric > 0
       group by c.brand_id, op.platform
      having count(*) >= 5
    ) x
)
select section, coalesce(brand, '-') as brand, item, detail
  from out
 order by ord, brand, item;

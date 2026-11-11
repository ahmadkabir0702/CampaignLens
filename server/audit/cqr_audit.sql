-- Campaign Lens: CQR audit, all brands. Read only: changes nothing.
-- One row per problem type per brand and platform, worst first.
-- sev 1 = a rating shown in the app is wrong or missing
-- sev 2 = data that will produce a wrong rating
-- sev 3 = worth a look
with
grades as (select unnest(array['Good','Average','Poor']) as g),
c as (
  select cr.*, to_jsonb(cr) as j from creatives cr
),
paid as (
  select 'meta'::text as platform, to_jsonb(m) as j from v_paid_meta_creative m
  union all
  select 'tiktok', to_jsonb(t) from v_paid_tiktok_creative t
),
p as (
  select platform,
         j->>'brand_id'                as brand_id,
         j->>'creative_id'             as creative_id,
         (j->>'spend')::numeric        as spend,
         (j->>'impressions')::numeric  as impressions,
         (j->>'reach')::numeric        as reach,
         (j->>'hook_rate')::numeric    as hook,
         (j->>'hold_rate')::numeric    as hold,
         (j->>'avg_watch_time')::numeric as awt,
         (j->>'duration_s')::numeric   as dur,
         j->>'cqr'                     as cqr,
         (j->>'is_active')::boolean    as is_active
    from paid
),
os as (
  select to_jsonb(s) as j from v_organic_scored s
),
o as (
  select j->>'brand_id' as brand_id, j->>'creative_id' as creative_id, j->>'platform' as platform,
         j->>'type' as type, j->>'cqr' as cqr,
         (j->>'engagement_rate')::numeric as er, (j->>'retention_rate')::numeric as rr
    from os
),
raw as (
  select to_jsonb(r) as j from organic_perf r
),
r as (
  select j->>'creative_id' as creative_id, j->>'platform' as platform,
         (j->>'views')::numeric as views, (j->>'likes')::numeric as likes,
         (j->>'comments')::numeric as comments, (j->>'avg_watch_time')::numeric as awt,
         (j->>'reach')::numeric as reach,
         nullif(coalesce(j->>'updated_at', j->>'last_updated', j->>'synced_at', j->>'fetched_at'), '')::timestamptz as read_at
    from raw
),
links as (
  select creative_id, brand_id, 'ig'::text as platform, ig_link as link from creatives where nullif(trim(ig_link), '') is not null
  union all select creative_id, brand_id, 'tt', tt_link from creatives where nullif(trim(tt_link), '') is not null
  union all select creative_id, brand_id, 'fb', fb_link from creatives where nullif(trim(fb_link), '') is not null
),
paid_brands as (
  select distinct p.brand_id, p.platform, coalesce(c.type, 'Brand Say') as type
    from p left join c on c.creative_id = p.creative_id
),
durs as (select unnest(array[6, 10, 15, 20, 30, 45, 60, 90]) as d),
findings as (

  -- 1. Paid spend but no rating (Low Delivery is expected, so left out)
  select 1 as sev, 'Paid: spend but no rating' as chk, p.brand_id, p.platform,
         coalesce(p.cqr, '(blank)') as detail, p.creative_id, p.spend as weight
    from p
   where p.spend > 0 and coalesce(p.cqr, '') not in ('Good','Average','Poor','Low Delivery')

  -- 2. Impossible paid rates
  union all
  select 1, 'Paid: impossible numbers', p.brand_id, p.platform,
         case when p.hook > 100 or p.hold > 100 then 'rate over 100%'
              when p.hook < 0 or p.hold < 0 then 'negative rate'
              when p.hold > p.hook then 'hold above hook'
              when p.reach > p.impressions then 'reach above impressions'
              else 'avg watch longer than the video' end,
         p.creative_id, p.spend
    from p
   where p.hook > 100 or p.hold > 100 or p.hook < 0 or p.hold < 0
      or p.hold > p.hook + 0.01
      or p.reach > p.impressions * 1.01
      or (p.dur > 0 and p.awt > p.dur + 1)

  -- 3. Big spend, tiny delivery: impressions probably missing
  union all
  select 2, 'Paid: Low Delivery with real spend', p.brand_id, p.platform,
         'over Rs. 20K spent, under 10K impressions', p.creative_id, p.spend
    from p
   where p.cqr = 'Low Delivery' and p.spend > 20000

  -- 4. Video length disagreements
  union all
  select 2, 'Duration: paid and creative disagree', p.brand_id, p.platform,
         'differs by more than 2s', p.creative_id, p.spend
    from p join c on c.creative_id = p.creative_id
   where p.dur is not null and c.duration_s is not null and abs(p.dur - c.duration_s) > 2
  union all
  select 2, 'Duration: implausible', coalesce(p.brand_id, c.brand_id), coalesce(p.platform, 'creative'),
         case when coalesce(p.dur, c.duration_s) <= 0 then 'zero or negative' else 'over 5 minutes' end,
         coalesce(p.creative_id, c.creative_id), p.spend
    from c full join p on p.creative_id = c.creative_id
   where coalesce(p.dur, c.duration_s) <= 0 or coalesce(p.dur, c.duration_s) > 300
  union all
  select 1, 'Duration: video with no length', c.brand_id, 'creative',
         'video creative, duration_s blank', c.creative_id, null
    from c
   where coalesce(c.content_type, 'Video') = 'Video'
     and c.duration_s is null

  -- 5. Paid rows that do not belong to a creative
  union all
  select 2, 'Paid: rows with no creative', x.j->>'brand_id', x.platform,
         case when nullif(x.j->>'creative_id', '') is null then 'no creative id' else 'creative id not in creatives' end,
         x.j->>'creative_id', (x.j->>'spend')::numeric
    from (select 'meta'::text as platform, to_jsonb(pm) as j from paid_meta pm
          union all select 'tiktok', to_jsonb(pt) from paid_tiktok pt) x
   where coalesce((x.j->>'spend')::numeric, 0) > 0
     and (nullif(x.j->>'creative_id', '') is null
          or not exists (select 1 from creatives cc where cc.creative_id = x.j->>'creative_id'))

  -- 6. Creative type missing or unknown (decides which bars apply)
  union all
  select 1, 'Creative: type missing or unknown', c.brand_id, 'creative',
         coalesce(c.type, '(blank)'), c.creative_id, null
    from c
   where coalesce(c.type, '') not in ('Brand Say', 'Others Say')

  -- 7. Organic: no rating
  union all
  select case when o.cqr = 'No Threshold' then 1 else 2 end,
         'Organic: no rating', coalesce(o.brand_id, c.brand_id), o.platform,
         coalesce(o.type, '?') || ' / ' || coalesce(o.cqr, '(blank)'), o.creative_id, null
    from o left join c on c.creative_id = o.creative_id
   where coalesce(o.cqr, '') not in ('Good','Average','Poor')
     and not (o.cqr = 'Too Early' and coalesce(c.date::timestamptz, now()) > now() - interval '3 days')

  -- 8. Organic: impossible numbers
  union all
  select 1, 'Organic: impossible numbers', c.brand_id, r.platform,
         case when r.views < 0 or r.likes < 0 or r.comments < 0 then 'negative count'
              when r.likes > r.views and r.platform <> 'fb' then 'more likes than views'
              when r.awt > c.duration_s + 1 then 'avg watch longer than the video'
              else 'reach above views' end,
         r.creative_id, r.views
    from r join c on c.creative_id = r.creative_id
   where r.views < 0 or r.likes < 0 or r.comments < 0
      or (r.likes > r.views and r.views > 0 and r.platform <> 'fb')
      or (c.duration_s > 0 and r.awt > c.duration_s + 1)
  union all
  select 2, 'Organic: rate out of range', o.brand_id, o.platform,
         case when o.rr > 100 then 'retention over 100%' else 'engagement over 100%' end,
         o.creative_id, null
    from o where o.rr > 100 or o.er > 100

  -- 9. Organic readings for a creative that does not exist
  union all
  select 2, 'Organic: reading with no creative', null, r.platform,
         'creative id not in creatives', r.creative_id, r.views
    from r where not exists (select 1 from creatives cc where cc.creative_id = r.creative_id)

  -- 10. Link on file but never read
  union all
  select 1, 'Organic: link never read', l.brand_id, l.platform,
         'posted over 2 days ago, no reading', l.creative_id, null
    from links l join c on c.creative_id = l.creative_id
   where coalesce(c.date::timestamptz, now()) < now() - interval '2 days'
     and not exists (select 1 from organic_perf op where op.creative_id = l.creative_id and op.platform = l.platform)

  -- 11. One post linked to two creatives
  union all
  select 1, 'Link used by more than one creative', min(l.brand_id), l.platform,
         string_agg(l.creative_id, ', ' order by l.creative_id), min(l.creative_id), null
    from links l
   group by l.platform, lower(regexp_replace(split_part(l.link, '?', 1), '/+$', ''))
  having count(*) > 1

  -- 12. Brand Say still inside its 30 days but not read for 2 days
  union all
  select 2, 'Organic: reading gone stale', c.brand_id, r.platform,
         'in its 30-day window, last read over 2 days ago', r.creative_id, null
    from r join c on c.creative_id = r.creative_id
   where c.type = 'Brand Say' and r.read_at is not null
     and coalesce(c.date::timestamptz, now()) > now() - interval '30 days'
     and r.read_at < now() - interval '2 days'

  -- 13. Paid bars: no band for a length a brand actually runs
  union all
  select 1, 'Bars: no paid band', pb.brand_id, pb.platform,
         grp || ' ' || m.metric || ' at ' || d.d || 's', null, null
    from paid_brands pb
    cross join lateral (select case when pb.platform = 'meta' then 'meta_paid' else 'tt_paid' end
                               || case when pb.type = 'Others Say' then '_os' else '_bs' end as grp) gg(grp)
    cross join (values ('hook_rate'), ('hold_rate')) m(metric)
    cross join durs d
    cross join lateral thr(pb.brand_id, grp, m.metric, d.d) t(poor_lt, good_gte)
   where (t.poor_lt is null or t.good_gte is null)
     and exists (select 1 from p where p.brand_id = pb.brand_id and p.platform = pb.platform
                   and p.dur between d.d - 4 and d.d + 4)

  -- 14. Organic retention bars (Brand Say)
  union all
  select 1, 'Bars: no organic retention band', b.brand_id, pl.plat,
         pl.plat || '_organic at ' || d.d || 's', null, null
    from (select distinct brand_id from creatives where type = 'Brand Say') b
    cross join (values ('ig'), ('tt'), ('fb')) pl(plat)
    cross join durs d
    cross join lateral thr(b.brand_id, pl.plat || '_organic', 'retention_rate', d.d) t(poor_lt, good_gte)
   where (t.poor_lt is null or t.good_gte is null)
     and exists (select 1 from c join links l on l.creative_id = c.creative_id
                  where c.brand_id = b.brand_id and l.platform = pl.plat and c.type = 'Brand Say'
                    and c.duration_s between d.d - 4 and d.d + 4)

  -- 15. Creator bars (Others Say)
  union all
  select 1, 'Bars: no creator band', b.brand_id, pl.plat, 'cqr_os_benchmarks', null, null
    from (select distinct brand_id from creatives where type = 'Others Say') b
    cross join (values ('ig'), ('tt'), ('fb')) pl(plat)
   where not exists (select 1 from cqr_os_benchmarks ob
                      where ob.platform = pl.plat and (ob.brand_id = b.brand_id or ob.brand_id is null))
     and exists (select 1 from links l join creatives cc on cc.creative_id = l.creative_id
                  where cc.brand_id = b.brand_id and cc.type = 'Others Say' and l.platform = pl.plat)

  -- 16. Bars that cannot work
  union all
  select 1, 'Bars: Poor line above Good line', t.brand_id, t.platform, t.metric, null, null
    from cqr_thresholds t where t.poor_lt > t.good_gte
  union all
  select 1, 'Bars: Poor line above Good line', ob.brand_id, ob.platform, 'creator bar', null, null
    from cqr_os_benchmarks ob where ob.poor_below > ob.good_from
  union all
  select 2, 'Bars: overlapping length ranges', a.brand_id, a.platform,
         a.metric || ' ' || coalesce(a.min_duration::text, '0') || '-' || coalesce(a.max_duration::text, 'any')
           || ' overlaps ' || coalesce(b.min_duration::text, '0') || '-' || coalesce(b.max_duration::text, 'any'),
         null, null
    from cqr_thresholds a join cqr_thresholds b
      on a.platform = b.platform and a.metric = b.metric
     and a.brand_id is not distinct from b.brand_id and a.ctid < b.ctid
     and coalesce(a.min_duration, 0) < coalesce(b.max_duration, 1e9)
     and coalesce(b.min_duration, 0) < coalesce(a.max_duration, 1e9)

  -- 17. Bars changed since the 2026 copy (should be fixed all year)
  union all
  select 1, 'Bars: changed since fixed for 2026', x.j->>'brand_id', x.src, 'not in the 2026 copy', null, null
    from (select 'cqr_thresholds'::text as src, to_jsonb(t) - 'updated_at' - 'created_at' as j from cqr_thresholds t
          union all select 'cqr_os_benchmarks', to_jsonb(t) - 'updated_at' - 'created_at' from cqr_os_benchmarks t
          union all select 'static_thresholds', to_jsonb(t) - 'updated_at' - 'created_at' from static_thresholds t) x
   where exists (select 1 from cqr_bar_years where year = 2026)
     and not exists (select 1 from cqr_bars_archive a
                      where a.year = 2026 and a.source = x.src
                        and (a.row - 'updated_at' - 'created_at') = x.j)

  -- 18. History out of step with the live rating (fatigue and "moved" screens)
  union all
  select 2, 'History: latest entry differs from live rating', p.brand_id, p.platform,
         coalesce(l.cqr_lifetime, '(blank)') || ' on file, ' || p.cqr || ' live', p.creative_id, p.spend
    from p join v_cqr_latest l on l.creative_id = p.creative_id and l.channel = 'paid' and l.platform = p.platform
   where l.cqr_lifetime is distinct from p.cqr
  union all
  select 2, 'History: latest entry differs from live rating', o.brand_id, o.platform,
         coalesce(l.cqr, '(blank)') || ' on file, ' || coalesce(o.cqr, '(blank)') || ' live', o.creative_id, null
    from o join v_cqr_latest l on l.creative_id = o.creative_id and l.channel = 'organic' and l.platform = o.platform
   where l.cqr is distinct from o.cqr

  -- 19. Rating spread that suggests a bar is off (10 or more rated)
  union all
  select 3, 'Spread: lopsided ratings', s.brand_id, s.platform,
         s.n || ' rated: ' || s.good || ' Good, ' || s.avg || ' Average, ' || s.poor || ' Poor', null, null
    from (
      select brand_id, 'paid ' || platform as platform, count(*) as n,
             count(*) filter (where cqr = 'Good') as good, count(*) filter (where cqr = 'Average') as avg,
             count(*) filter (where cqr = 'Poor') as poor
        from p where cqr in ('Good','Average','Poor') group by 1, 2
      union all
      select brand_id, 'organic ' || platform || ' ' || coalesce(type, '?'), count(*),
             count(*) filter (where cqr = 'Good'), count(*) filter (where cqr = 'Average'),
             count(*) filter (where cqr = 'Poor')
        from o where cqr in ('Good','Average','Poor') group by 1, 2
    ) s
   where s.n >= 10 and (s.good = 0 or s.poor = 0 or s.good >= s.n * 0.7 or s.poor >= s.n * 0.7)

  -- 20. Brands with creatives but nothing rated
  union all
  select 2, 'Brand: nothing rated', b.brand_id, 'all',
         (select count(*) from creatives cc where cc.brand_id = b.brand_id) || ' creatives', null, null
    from brands b
   where exists (select 1 from creatives cc where cc.brand_id = b.brand_id)
     and not exists (select 1 from p where p.brand_id = b.brand_id and p.cqr in ('Good','Average','Poor'))
     and not exists (select 1 from o where o.brand_id = b.brand_id and o.cqr in ('Good','Average','Poor'))
)
select f.sev, f.chk as check_name, coalesce(f.brand_id, '-') as brand, f.platform, f.detail,
       count(*) as creatives,
       round(sum(f.weight)) as spend_or_views,
       left(string_agg(distinct f.creative_id, ', '), 400) as examples
  from findings f
 group by f.sev, f.chk, f.brand_id, f.platform, f.detail
 order by f.sev, count(*) desc, f.chk, f.brand_id;

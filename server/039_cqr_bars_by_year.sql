-- =====================================================================
--  039 — CQR benchmarks are fixed for a calendar year
--
--  Decision (Oct 2026): the bars every creative is graded against stay
--  the same for the whole year and are reset once, in January, from the
--  previous year's results. Within a year, a rise in the share of Good
--  creatives is real improvement, not the bars moving.
--
--  The bars in force now (set by migrations 023 to 028) become the 2026
--  bars. This file:
--    1. cqr_bar_years: which year's bars are in force, when and by whom
--       they were set, and the minimum sample a bar needs.
--    2. cqr_bars_archive: a copy of every benchmark row for the year,
--       so later years can be compared with this one and any year can be
--       restored. One JSON row per benchmark, so it works whatever columns
--       the benchmark tables have.
--
--    3. The creator-bar refresh does nothing outside the January reset.
--
--  Nothing here changes a bar or a rating.
--  The January reset is described in docs/cqr-benchmarks.md.
--
--  Safe to re-run: the 2026 copy is only taken once.
-- =====================================================================

begin;

create table if not exists cqr_bar_years (
  year        integer primary key,
  set_at      timestamptz not null default now(),
  set_by      text,
  min_sample  integer not null default 30,
  note        text
);

create table if not exists cqr_bars_archive (
  year         integer not null,
  source       text    not null,     -- cqr_thresholds, cqr_os_benchmarks, static_thresholds
  row          jsonb   not null,
  archived_at  timestamptz not null default now()
);
create index if not exists cqr_bars_archive_year on cqr_bars_archive (year, source);

alter table cqr_bar_years    enable row level security;
alter table cqr_bars_archive enable row level security;

do $$
declare t text;
begin
  if exists (select 1 from cqr_bar_years where year = 2026) then
    raise notice '2026 bars already recorded; nothing copied.';
    return;
  end if;
  insert into cqr_bar_years (year, set_by, min_sample, note)
  values (2026, 'migrations 023-028', 8,
          'Bars in force since migrations 023 to 028. Fixed until the January 2027 reset.');
  foreach t in array array['cqr_thresholds', 'cqr_os_benchmarks', 'static_thresholds'] loop
    if to_regclass(t) is not null then
      execute format('insert into cqr_bars_archive (year, source, row) select 2026, %L, to_jsonb(x) from %I x', t, t);
    end if;
  end loop;
end $$;

-- 3. The creator bars (Others Say organic) are rebuilt by
--    refresh_cqr_os_benchmarks(). Something may call it on a schedule, which
--    would move the bars mid-year. It now does nothing unless the annual
--    reset switches it on for its own transaction:
--        set local cqr.annual_reset = 'on';  select refresh_cqr_os_benchmarks();
--    The real rebuild is kept as refresh_cqr_os_benchmarks_now().
do $$
begin
  if to_regprocedure('public.refresh_cqr_os_benchmarks(integer)') is not null
     and to_regprocedure('public.refresh_cqr_os_benchmarks_now(integer)') is null then
    alter function public.refresh_cqr_os_benchmarks(integer) rename to refresh_cqr_os_benchmarks_now;
  end if;
end $$;

create or replace function public.refresh_cqr_os_benchmarks(min_posts integer default 20)
returns void
language plpgsql
as $function$
begin
  if coalesce(current_setting('cqr.annual_reset', true), '') <> 'on' then
    raise notice 'CQR benchmarks are fixed for the year, so the creator bars were not rebuilt. See docs/cqr-benchmarks.md.';
    return;
  end if;
  perform public.refresh_cqr_os_benchmarks_now(min_posts);
end;
$function$;

comment on function public.refresh_cqr_os_benchmarks(integer) is
  'Fixed for the year (039): does nothing unless cqr.annual_reset is on for the transaction. The rebuild itself is refresh_cqr_os_benchmarks_now().';

insert into schema_migrations (name) values ('039_cqr_bars_by_year.sql') on conflict (name) do nothing;

commit;

select year, set_at, note, (select count(*) from cqr_bars_archive a where a.year = y.year) as bars_copied
  from cqr_bar_years y order by year;

-- Anything scheduled in the database that refreshes the bars (pg_cron).
-- If a row comes back it is now harmless, but it can be removed.
do $$
declare r record;
begin
  if to_regclass('cron.job') is not null then
    for r in execute $q$select jobid, schedule, command from cron.job where command ilike '%cqr%'$q$ loop
      raise notice 'Scheduled job % (%) runs: %', r.jobid, r.schedule, r.command;
    end loop;
  end if;
end $$;

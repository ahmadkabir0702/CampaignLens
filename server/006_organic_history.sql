-- =====================================================================
--  006_organic_history.sql — keep a history of organic numbers
--
--  organic_perf holds one row per post per platform, overwritten on every
--  pull, so there is no way to see whether a post is still climbing or
--  already flat. Rather than change organic_perf to append (which would
--  multiply every existing organic read: v_organic_scored,
--  v_creative_organic_best, the dashboard payload, the chat snapshot and
--  the organic element analysis), history goes in its own table and a
--  trigger writes it.
--
--  Consequences:
--    * n8n needs no change at all. It keeps upserting organic_perf.
--    * Every existing read keeps returning exactly one row per post.
--    * organic_perf_history accumulates one row per genuine change.
--
--  Safe to run more than once.
-- =====================================================================

create table if not exists organic_perf_history (
  creative_id        text        not null,
  platform           text        not null,
  captured_at        timestamptz not null default now(),
  views              bigint,
  reach              bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saves              bigint,
  total_interactions bigint,
  avg_watch_time     numeric,
  time_posted        timestamptz,
  primary key (creative_id, platform, captured_at)
);

create index if not exists organic_perf_history_lookup
  on organic_perf_history (creative_id, platform, captured_at desc);

comment on table organic_perf_history is
  'Append-only history of organic_perf, written by trigger. One row per genuine change. Read for velocity and "is it still climbing"; never for current numbers — those live in organic_perf.';

-- ---------------------------------------------------------------------
--  The trigger. Records a point only when a number actually moved, so a
--  pull that returns identical figures does not grow the table. Two
--  pulls in the same minute collapse into one point.
-- ---------------------------------------------------------------------
create or replace function organic_perf_snapshot() returns trigger as $$
declare
  last_row organic_perf_history;
begin
  -- organic_perf can hold rows for posts whose creative is not registered
  -- yet. They have no creative to attach history to, and a trigger that
  -- raised here would break the pull that wrote them.
  if new.creative_id is null then
    return null;
  end if;

  select * into last_row
    from organic_perf_history
   where creative_id = new.creative_id
     and platform    = new.platform
   order by captured_at desc
   limit 1;

  -- Nothing moved since the last point: no new point.
  if last_row.creative_id is not null
     and coalesce(last_row.views, -1)              = coalesce(new.views, -1)
     and coalesce(last_row.reach, -1)              = coalesce(new.reach, -1)
     and coalesce(last_row.total_interactions, -1) = coalesce(new.total_interactions, -1)
     and coalesce(last_row.likes, -1)              = coalesce(new.likes, -1)
     and coalesce(last_row.comments, -1)           = coalesce(new.comments, -1)
     and coalesce(last_row.shares, -1)             = coalesce(new.shares, -1)
     and coalesce(last_row.saves, -1)              = coalesce(new.saves, -1) then
    return null;
  end if;

  insert into organic_perf_history
    (creative_id, platform, captured_at, views, reach, likes, comments,
     shares, saves, total_interactions, avg_watch_time, time_posted)
  values
    (new.creative_id, new.platform, date_trunc('minute', now()), new.views, new.reach,
     new.likes, new.comments, new.shares, new.saves, new.total_interactions,
     new.avg_watch_time, new.time_posted)
  on conflict (creative_id, platform, captured_at) do update set
     views = excluded.views, reach = excluded.reach, likes = excluded.likes,
     comments = excluded.comments, shares = excluded.shares, saves = excluded.saves,
     total_interactions = excluded.total_interactions,
     avg_watch_time = excluded.avg_watch_time, time_posted = excluded.time_posted;

  return null;
end;
$$ language plpgsql;

drop trigger if exists organic_perf_history_trg on organic_perf;
create trigger organic_perf_history_trg
  after insert or update on organic_perf
  for each row execute function organic_perf_snapshot();

-- ---------------------------------------------------------------------
--  Seed: today's numbers become each post's first history point, so
--  velocity starts accumulating from now rather than from the first
--  future change. Rows with no creative_id are organic pulls for posts
--  that were never registered as creatives; they are skipped, and they
--  start a history of their own once the creative is added.
-- ---------------------------------------------------------------------
insert into organic_perf_history
  (creative_id, platform, captured_at, views, reach, likes, comments,
   shares, saves, total_interactions, avg_watch_time, time_posted)
select creative_id, platform, date_trunc('minute', now()), views, reach,
       likes, comments, shares, saves, total_interactions, avg_watch_time, time_posted
  from organic_perf
 where creative_id is not null
on conflict (creative_id, platform, captured_at) do nothing;

-- =====================================================================
--  036 — Assign agency for repurposing
--
--  Unilever and Mindshare accounts assign a creative to an agency for
--  repurposing, with a due date. The agency sees it in its own list and
--  marks it done; a Unilever account approves it (or reopens it with a
--  note). The media head sees every request, read-only.
--
--  A creative can be assigned when it has something to act on: a paid
--  recommendation if it ran on paid, a pre-test score if it is organic
--  only. The server checks this.
--
--    assigned   with the agency
--    done       the agency says it is done; waiting for Unilever
--    approved   Unilever approved it; closed
--    cancelled  withdrawn before approval
--
--  This file:
--    1. app_users.org: unilever, mindshare, agency or other. Worked out
--       from the login (agency.* = agency, ms.* or internal = mindshare,
--       the coordinator = other, everyone else = unilever). The result at
--       the end lists every account so you can check it.
--    2. app_users.agency_key: which agency an agency login belongs to,
--       matched to the agencies list by name (agency.litmus -> Litmus).
--    3. app_users.can_repurpose: the menu section; off for the coordinator.
--    4. repurpose_tasks and repurpose_task_events.
--
--  One transaction; safe to re-run (it does not overwrite an org or
--  agency_key already set, so fixes made by hand stay).
-- =====================================================================

begin;

alter table app_users
  add column if not exists org            text,
  add column if not exists agency_key     text,
  add column if not exists can_repurpose  boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_org_check') then
    alter table app_users add constraint app_users_org_check
      check (org is null or org in ('unilever', 'mindshare', 'agency', 'other'));
  end if;
end $$;

-- 1. Which side each account is on.
do $$
declare has_internal boolean;
begin
  select exists (select 1 from information_schema.columns
                  where table_schema = current_schema() and table_name = 'app_users' and column_name = 'is_internal')
    into has_internal;
  update app_users set org = 'agency' where org is null and username like 'agency.%';
  update app_users set org = 'other'  where org is null and role = 'influencer_coordinator';
  update app_users set org = 'unilever' where org is null and role = 'media_head';
  update app_users set org = 'mindshare' where org is null and (username like 'ms.%' or role = 'admin');
  if has_internal then
    execute 'update app_users set org = ''mindshare'' where org is null and is_internal';
  end if;
  update app_users set org = 'unilever' where org is null;
end $$;

update app_users set can_repurpose = false where role = 'influencer_coordinator';

-- 2. Agency logins to agencies, by name: agency.litmus -> Litmus,
--    agency.creative.octo -> Creative Octo. The whole name after
--    "agency." is compared first, then just its first part
--    (agency.isobar.lk -> Isobar).
update app_users u
   set agency_key = a.agency_id::text
  from agencies a
 where u.org = 'agency' and u.agency_key is null
   and regexp_replace(lower(substr(u.username, 8)), '[^a-z0-9]', '', 'g')
       = regexp_replace(lower(a.name), '[^a-z0-9]', '', 'g');
update app_users u
   set agency_key = a.agency_id::text
  from agencies a
 where u.org = 'agency' and u.agency_key is null
   and regexp_replace(lower(split_part(substr(u.username, 8), '.', 1)), '[^a-z0-9]', '', 'g')
       = regexp_replace(lower(a.name), '[^a-z0-9]', '', 'g');

-- 3. The tasks
create table if not exists repurpose_tasks (
  id              bigserial primary key,
  creative_id     text        not null,
  brand_id        text        not null,
  agency_key      text        not null,
  agency_name     text        not null,
  status          text        not null default 'assigned'
                  check (status in ('assigned', 'done', 'approved', 'cancelled')),
  due_date        date        not null,
  assigned_by     text        not null,
  assigned_at     timestamptz not null default now(),
  done_by         text,
  done_at         timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  cancelled_by    text,
  cancelled_at    timestamptz,
  reopened        integer     not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists repurpose_tasks_brand_status on repurpose_tasks (brand_id, status);
create index if not exists repurpose_tasks_agency on repurpose_tasks (agency_key, status);
create index if not exists repurpose_tasks_creative on repurpose_tasks (creative_id);
-- One open request per creative at a time.
create unique index if not exists repurpose_tasks_one_open
  on repurpose_tasks (creative_id) where status in ('assigned', 'done');

create table if not exists repurpose_task_events (
  id          bigserial primary key,
  task_id     bigint      not null,
  action      text        not null,   -- assigned, done, approved, reopened, cancelled, due_changed
  actor       text        not null,
  actor_name  text,
  note        text,
  at          timestamptz not null default now()
);
create index if not exists repurpose_task_events_task on repurpose_task_events (task_id, at);

comment on table repurpose_tasks is
  'Creatives assigned to an agency for repurposing (migration 036). Assigned by Unilever or Mindshare, marked done by the agency, approved by Unilever.';
comment on column app_users.org is
  'unilever, mindshare, agency or other. Decides who can assign repurposing (unilever, mindshare) and who can approve it (unilever).';

commit;

-- Check: every active account, its side, and the agency it belongs to.
-- An agency login with no agency is listed first: set it by hand with
--   update app_users set agency_key = (select agency_id::text from agencies where name = 'Litmus') where username = '...';
select u.username, u.org, a.name as agency, u.role
  from app_users u
  left join agencies a on a.agency_id::text = u.agency_key
 where u.is_active
 order by (u.org = 'agency' and a.name is null) desc, u.org, u.username;

-- =====================================================================
--  035 — Campaign sign-off: the full workflow
--
--  Unilever and Mindshare accounts create a checklist for a campaign and
--  send it to the Unilever media head (Chaminda), who is the only
--  approver. He fills in his own section, marks each item OK or needing a
--  change, adds notes, and either sends it back or approves it. Approving
--  locks the checklist and adds the campaign to the brand's campaigns.
--
--    draft              being filled in; the creators can edit it
--    submitted          with the media head; nobody else can edit it
--    changes_requested  sent back with items flagged; editable again
--    approved           locked; the campaign exists in Campaign Lens
--    superseded         an approved version replaced by an approved amendment
--
--  This file:
--    1. sign_offs: new statuses, the media head's section (review),
--       versions for amendments, who submitted and when, the campaign it
--       created. Old 'pending' rows become 'submitted'.
--    2. sign_off_notes: notes on an item or on the whole checklist.
--    3. sign_off_events: the activity log (created, submitted, sent back,
--       resubmitted, approved, amended).
--    4. app_users.can_signoff: true for Unilever and Mindshare accounts,
--       false for agency.* logins and the influencer coordinator.
--    5. Chaminda's login: role media_head, every brand, a temporary
--       password (given in chat) to change at first sign-in. The server
--       also gives a media head every active brand at sign-in, so brands
--       added later are covered without editing his access.
--
--  One transaction: if any step fails, nothing changes. Safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  1. sign_offs
-- ---------------------------------------------------------------------
alter table sign_offs
  add column if not exists version        integer     not null default 1,
  add column if not exists parent_id      bigint,
  add column if not exists review         jsonb       not null default '{}'::jsonb,
  add column if not exists submitted_by   text,
  add column if not exists submitted_at   timestamptz,
  add column if not exists returned_by    text,
  add column if not exists returned_at    timestamptz,
  add column if not exists campaign_id    bigint,
  add column if not exists updated_by     text,
  add column if not exists updated_at     timestamptz not null default now();

-- Whatever check the old statuses had goes; the new one replaces it.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
     where conrelid = 'sign_offs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table sign_offs drop constraint %I', r.conname);
  end loop;
end $$;

update sign_offs set status = 'submitted', submitted_at = coalesce(submitted_at, created_at),
                     submitted_by = coalesce(submitted_by, created_by)
 where status = 'pending';
update sign_offs set status = 'draft'
 where status is null or status not in ('draft', 'submitted', 'changes_requested', 'approved', 'superseded');

alter table sign_offs
  add constraint sign_offs_status_check
  check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'superseded'));

alter table sign_offs alter column status set default 'draft';
alter table sign_offs alter column fields set default '{}'::jsonb;

create index if not exists sign_offs_brand_status on sign_offs (brand_id, status);
create index if not exists sign_offs_parent on sign_offs (parent_id);

comment on column sign_offs.review is
  'The media head''s part: {approvedBudget, kpis, conditions, items: {<item key>: "ok" | "change"}}.';
comment on column sign_offs.version is
  'An amendment to an approved checklist is a new row with version + 1 and parent_id pointing at the one it amends.';

-- ---------------------------------------------------------------------
--  2. Notes
-- ---------------------------------------------------------------------
create table if not exists sign_off_notes (
  id           bigserial primary key,
  sign_off_id  bigint      not null,
  item_key     text,                      -- null = a note on the whole checklist
  author       text        not null,      -- username
  author_name  text,
  is_reviewer  boolean     not null default false,
  body         text        not null check (length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);
create index if not exists sign_off_notes_signoff on sign_off_notes (sign_off_id, created_at);

-- ---------------------------------------------------------------------
--  3. Activity log
-- ---------------------------------------------------------------------
create table if not exists sign_off_events (
  id           bigserial primary key,
  sign_off_id  bigint      not null,
  action       text        not null,      -- created, submitted, resubmitted, changes_requested, approved, amended, superseded
  actor        text        not null,
  actor_name   text,
  detail       jsonb       not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index if not exists sign_off_events_signoff on sign_off_events (sign_off_id, at);

-- Existing sign-offs get their history so far.
insert into sign_off_events (sign_off_id, action, actor, at)
select s.id, 'created', coalesce(s.created_by, 'unknown'), s.created_at
  from sign_offs s
 where not exists (select 1 from sign_off_events e where e.sign_off_id = s.id);
insert into sign_off_events (sign_off_id, action, actor, at)
select s.id, 'approved', s.approved_by, s.approved_at
  from sign_offs s
 where s.status = 'approved' and s.approved_by is not null
   and not exists (select 1 from sign_off_events e where e.sign_off_id = s.id and e.action = 'approved');

-- ---------------------------------------------------------------------
--  4. Who may use it
-- ---------------------------------------------------------------------
alter table app_users add column if not exists can_signoff boolean not null default true;
update app_users set can_signoff = false
 where username like 'agency.%' or role = 'influencer_coordinator';

comment on column app_users.can_signoff is
  'Campaign sign-off. True for Unilever and Mindshare accounts; false for agencies and the influencer coordinator (migration 035).';

-- ---------------------------------------------------------------------
--  5. Chaminda, media head
-- ---------------------------------------------------------------------
-- Sets one account's brands wherever brand access is stored (the same
-- function as the agency access file; created here too in case that was
-- not run).
create or replace function public.set_user_brands(p_user text, p_brands text[])
returns void
language plpgsql
as $fn$
declare
  t record;
  done boolean := false;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'app_users' and column_name = 'brands') then
    execute 'update app_users set brands = $1 where username = $2' using p_brands, p_user;
    done := true;
  end if;
  for t in
    select distinct u.table_name
      from information_schema.view_table_usage u
     where u.view_schema = current_schema() and u.view_name = 'v_user_access'
       and u.table_name <> 'app_users'
       and exists (select 1 from information_schema.columns c
                    where c.table_schema = u.table_schema and c.table_name = u.table_name and c.column_name = 'username')
       and exists (select 1 from information_schema.columns c
                    where c.table_schema = u.table_schema and c.table_name = u.table_name and c.column_name = 'brand_id')
  loop
    execute format('delete from %I where username = $1', t.table_name) using p_user;
    execute format('insert into %I (username, brand_id) select $1, b from unnest($2::text[]) b', t.table_name)
      using p_user, p_brands;
    done := true;
  end loop;
  if not done then
    raise exception 'Could not find where brand access is stored. Send Claude the result of: select pg_get_viewdef(''v_user_access''::regclass, true);';
  end if;
end;
$fn$;

do $$
declare
  new_user constant text := 'chaminda';
  new_name constant text := 'Chaminda (Unilever media head)';
  -- bcrypt hash of the temporary password given in chat
  new_hash constant text := '$2a$10$L/0JNbMtJuZEdp9yaWrACOFbh9gCUOu9RvmEGL.X.Uytry6kCzGz.';
  tmpl text;
  cols text;
  roles text;
  r record;
begin
  -- A check on app_users.role, if there is one, has to allow media_head.
  for r in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'app_users'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%role%'
       and pg_get_constraintdef(oid) not ilike '%media_head%'
  loop
    select string_agg(quote_literal(x), ', ') into roles
      from (select distinct role as x from app_users where role is not null
            union select 'media_head' union select 'client_lead' union select 'admin'
            union select 'influencer_coordinator') v;
    execute format('alter table app_users drop constraint %I', r.conname);
    execute format('alter table app_users add constraint %I check (role is null or role in (%s))', r.conname, roles);
    raise notice 'Role check % now allows media_head', r.conname;
  end loop;

  if not exists (select 1 from app_users where username = new_user) then
    -- A copy of an ordinary (non-agency, non-coordinator) account, so any
    -- column this script does not know about gets a sensible value.
    select username into tmpl from app_users
     where is_active and username not like 'agency.%'
       and coalesce(role, '') not in ('influencer_coordinator')
     order by (username like 'ms.%'), username
     limit 1;
    if tmpl is null then raise exception 'No account to copy settings from'; end if;

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = current_schema() and table_name = 'app_users'
       and column_name not in ('username', 'display_name', 'password_hash', 'must_change_password', 'email',
                               'last_login_at', 'password_changed_at', 'created_at', 'updated_at', 'brands',
                               'role', 'agency_id')
       and coalesce(column_default, '') not like '%(%'
       and is_identity = 'NO' and is_generated = 'NEVER';
    execute format(
      'insert into app_users (username, display_name, password_hash, must_change_password, role, %s)
       select %L, %L, %L, true, %L, %s from app_users where username = %L',
      cols, new_user, new_name, new_hash, 'media_head', cols, tmpl);
  end if;

  update app_users
     set role = 'media_head', is_active = true, can_signoff = true,
         can_ask_lens = true, can_pretest = true, can_media = true,
         can_creators = true, can_sov = true, can_add_creative = false
   where username = new_user;

  -- Every active brand. The server also does this at each sign-in.
  begin
    perform set_user_brands(new_user, array(select brand_id::text from brands where is_active order by brand_id));
  exception when others then
    raise notice 'Brand list not written to the table (%); the server gives the media head every brand at sign-in.', sqlerrm;
  end;
end $$;

commit;

-- Check: Chaminda with every brand, and who can use sign-offs.
select u.username, u.role, u.can_signoff, v.brands
  from app_users u left join v_user_access v using (username)
 where u.username = 'chaminda' or u.username like 'agency.%'
 order by (u.username = 'chaminda') desc, u.username;

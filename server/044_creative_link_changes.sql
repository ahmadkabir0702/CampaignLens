-- =====================================================================
--  044: a record of every link added or changed after a creative was added
--
--  Links can be added to a creative from its panel (POST /api/creative-links).
--  Guardrails, enforced by the server:
--    - a missing link can be added for 2 days after the creative was added;
--      after that, admin only
--    - a link that is already set can be changed by an admin only, with a
--      reason
--  Every add and change is written here. When a link is replaced, the
--  readings that came from the old post are kept in old_readings rather
--  than lost, so a change can always be undone.
--
--  The server refuses link changes until this table exists. Safe to re-run.
-- =====================================================================

begin;

create table if not exists creative_link_changes (
  id            bigserial primary key,
  creative_id   text        not null,
  brand_id      text        not null,
  platform      text        not null check (platform in ('ig', 'fb', 'tt')),
  kind          text        not null check (kind in ('added', 'replaced')),
  old_link      text,
  new_link      text        not null,
  reason        text,
  changed_by    text        not null,
  role          text,
  changed_at    timestamptz not null default now(),
  old_readings  jsonb
);
create index if not exists creative_link_changes_creative on creative_link_changes (creative_id, changed_at desc);

alter table creative_link_changes enable row level security;

comment on table creative_link_changes is
  'Every link added or replaced on a creative after it was added (044). old_readings holds the organic_perf rows of a replaced link.';

insert into schema_migrations (name) values ('044_creative_link_changes.sql') on conflict (name) do nothing;

commit;

select count(*) as changes_recorded from creative_link_changes;

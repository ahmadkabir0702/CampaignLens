-- =====================================================================
--  048: the objective of a pre-test
--
--  A pre-test is now judged against the job it is meant to do. The person
--  uploading picks Awareness, Consideration or Conversion, and the report's
--  headline is the score for that objective.
--
--  Kept in its own column and never sent to the scoring service, which
--  refuses fields it does not know. Null for pre-tests run before this and
--  for tracked creatives, which fall back to what the video reads as.
--
--  Safe to run more than once.
-- =====================================================================

begin;

alter table brainsuite_jobs add column if not exists objective text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brainsuite_jobs_objective_chk') then
    alter table brainsuite_jobs add constraint brainsuite_jobs_objective_chk
      check (objective is null or objective in ('Awareness', 'Consideration', 'Conversion'));
  end if;
end $$;

insert into schema_migrations (name) values ('048_pretest_objective.sql') on conflict (name) do nothing;

commit;

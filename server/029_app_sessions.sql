-- =====================================================================
--  029 — table for sign-in sessions
--
--  Sessions move from Redis to Postgres (server/pg-session-store.js). The
--  app creates this table itself on start, but run this first so the
--  first deploy does not depend on that.
--
--  Row level security is on with no policies, so the table cannot be read
--  through Supabase's public API; the app's own connection still can.
--  Expired rows are deleted by the app every 15 minutes.
--
--  Safe to re-run.
-- =====================================================================

create table if not exists app_sessions (
  sid    text primary key,
  sess   jsonb not null,
  expire timestamptz not null
);
create index if not exists app_sessions_expire on app_sessions (expire);

alter table app_sessions enable row level security;
revoke all on app_sessions from anon, authenticated;

comment on table app_sessions is
  'Sign-in sessions for Campaign Lens. One row per signed-in browser; expire moves forward as the person uses the app (at most every 5 minutes) and expired rows are deleted every 15 minutes.';

select count(*) as sessions_now from app_sessions;

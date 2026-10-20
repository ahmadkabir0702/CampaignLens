-- =====================================================================
--  030 — share of voice: monthly runs, review before publishing,
--        brand-backed creator content, batch labelling and the
--        "what's behind this" panels
--
--  Run after 019 and 020. Safe to re-run.
-- =====================================================================

begin;

-- ── How often each category runs, and whether it publishes on its own ──
--   cadence       'monthly': the period is the last full calendar month.
--                 'weekly': a rolling window_days ending last Sunday.
--   run_day       monthly: the day of the month the run becomes due, so
--                 late numbers and late conversation have come in.
--   auto_publish  false: a run saves its period without showing it; it
--                 goes live when someone publishes it after review.
alter table sov_category_config
  add column if not exists cadence      text    not null default 'monthly',
  add column if not exists run_day      int     not null default 3,
  add column if not exists auto_publish boolean not null default false;

do $$ begin
  alter table sov_category_config add constraint sov_cfg_cadence check (cadence in ('monthly', 'weekly'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sov_category_config add constraint sov_cfg_run_day check (run_day between 1 and 28);
exception when duplicate_object then null; end $$;

-- Skin cleansing was reviewed by hand in the first study, so it publishes
-- on its own from the start. Every new category starts on review.
update sov_category_config set auto_publish = true, cadence = 'monthly' where category_id = 'skin_cleansing';

-- A monthly run reads about six weeks of brand pages, searches and
-- conversation in one go, so it needs a bigger cap than a weekly one.
update sov_category_config set credit_cap = greatest(credit_cap, 2500) where cadence = 'monthly';

-- ── Brand-backed creator content ─────────────────────────────────────
--   A creator post made with the brand counts as the brand's content, not
--   as earned conversation: a collab, a paid partnership label, a
--   disclosure (#ad, #sponsored ...), or a creator post the team tracks in
--   Campaign Lens. The conversation on it is still earned.
alter table sov_raw_posts
  add column if not exists backed_brand  text,
  add column if not exists backed_reason text;

-- ── Labelling: repeated short replies are labelled once ──────────────
alter table sov_raw_comments add column if not exists norm_key text;
create index if not exists sov_raw_comments_norm_idx on sov_raw_comments (category_id, norm_key) where norm_key is not null;

-- ── Labelling through the Message Batches API ────────────────────────
--   One row per batch sent. If the server restarts mid-run, the next run
--   collects the finished labels instead of paying for them again.
create table if not exists sov_label_batches (
  batch_id     text primary key,
  category_id  text not null references sov_categories(category_id) on delete cascade,
  run_id       bigint,
  kind         text not null,                -- posts | comments
  items        jsonb not null,               -- custom_id -> the rows it labels
  status       text not null default 'sent', -- sent | collected | expired
  created_at   timestamptz not null default now(),
  collected_at timestamptz
);
create index if not exists sov_label_batches_open on sov_label_batches (category_id) where status = 'sent';

-- ── Periods: monthly and weekly side by side ─────────────────────────
alter table sov_periods add column if not exists cadence text;
update sov_periods set cadence = 'study' where cadence is null;

-- ── "What's behind this" ─────────────────────────────────────────────
--   One row per panel per period:
--     section:<name>   a chart: share, trend, sentiment, public, origin,
--                      topics, intent, source
--     brand:<name>     one tracked brand
--   content: { read, drivers[], implications{brand: {implication, next_step}},
--              quotes[{text, translated}] }
--   Shares only, like every other published table.
create table if not exists sov_panels (
  period_id  bigint not null references sov_periods(period_id) on delete cascade,
  panel_key  text   not null,
  content    jsonb  not null,
  primary key (period_id, panel_key)
);

commit;

select category_id, is_automated, cadence, run_day, auto_publish
  from sov_category_config order by category_id;

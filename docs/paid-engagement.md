# Paid engagement rate and cost per engagement

Part 2 of the paid roll-up. Part 1 is `docs/cqr-good-rates.md`.

## The figures

| Figure | Worked out as |
|---|---|
| Engagement rate | engagements / impressions |
| Cost per engagement | spend in LKR / the same engagements |
| Impressions covered | impressions on days with engagement data / all paid impressions |

Engagements:

- **Meta:** post reactions + comments + shares + saves + link clicks +
  Instagram follows + Facebook page likes.
- **TikTok:** paid likes + comments + shares + follows + destination clicks.
- **Not counted:** 3-second plays, Post engagement, Clicks (all).
- **TikTok favorites:** not offered by TikTok's ads reporting, so they are
  left out.
- **Instagram follows:** counted where Meta reports them (Meta's action type
  ending in `instagram_profile_follow`). The footnote names them only once
  Meta has reported some for the brand.

Rules:

- Every paid creative counts, photos and carousels included. CQR stays
  video only.
- A day the sync has not read for engagement is left out of impressions and
  spend alike, never counted as zero. Impressions covered shows how much of
  the delivery the figure rests on.
- Meta and TikTok are worked out separately. Combined adds engagements,
  impressions and spend.
- `paid_meta.engagement_rate_percent` now holds the new formula (it was Post
  engagement / impressions), so there is one engagement rate.
  `post_engagements` is kept as Meta sends it and nothing reads it.
- `account_monthly.act_engagement_rate` is filled with the same formula for
  the Meta ad account, with the count in `act_engagements`.

## Where it shows

- **Media Summary:** the section is now "Paid quality and engagement". An
  Engagement card sits under Video quality, and the campaign and brand
  tables switch between Video quality and Engagement.
- **Ask Lens:** the brand data carries the all-time figures. The tool,
  renamed `paid_rates`, returns them for any date range, campaign or
  platform. New markers: `paid_engagement_rate` and `cost_per_engagement`.

## Running it, in order

1. **SQL.** Run `server/046_paid_engagement.sql` in Supabase. It adds
   columns and two log tables and changes no existing value. Safe to run
   twice. Until it runs, the page shows video quality only and says
   engagement is not loaded yet.

2. **Brand Sync (child).** The current workflow must be kept, because the
   parent calls it by its ID. So:
   - Download the current child as a backup.
   - Open it, select all nodes, delete them.
   - Import `Brand Sync (child) - engagement.json` from File, then save.

   The changes:
   - Meta ads keep the engagement inputs from the action breakdown already
     fetched.
   - TikTok asks for likes, comments, shares and follows in a new request,
     Get TT Engagement. If TikTok refuses it, the paid rows are still
     written as before, without engagement.
   - The Meta account monthly call asks for actions and fills the monthly
     engagement rate.
   - The `level` parameter on that call had a long run of trailing spaces
     in its name. That is fixed.

3. **Re-pull.** Import `Engagement re-pull (one-off).json` as a new
   workflow and run it by hand.
   - It reads Meta a month at a time and TikTok half a month at a time,
     from January 2025 to today, for every active brand.
   - It only updates engagement on rows Campaign Lens already has. It adds
     no rows and changes no other column.
   - It also records what each API offers, in `engagement_checks`.
   - To run one brand first, set `only_brand` in the Settings node.

4. **Read the result** and send it back:

   ```sql
   -- Per brand and platform: earliest month the API returned, earliest
   -- month Campaign Lens had rows to fill, rows filled, errors.
   select l.brand_id, l.platform,
          to_char(min(l.period_start) filter (where l.api_rows > 0), 'YYYY-MM')     as api_earliest_month,
          to_char(min(l.period_start) filter (where l.updated_rows > 0), 'YYYY-MM') as filled_from_month,
          sum(l.api_rows) as api_rows, sum(l.updated_rows) as rows_filled,
          count(*) filter (where l.error is not null) as chunks_failed,
          max(l.error) as example_error
     from engagement_repull_log l
    where l.platform <> 'check'
    group by 1, 2 order by 1, 2;

   -- What each API offers: Meta action types (anything with "follow" is
   -- listed apart) and which TikTok metrics it accepted.
   select brand_id, checked_at, result from engagement_checks order by checked_at desc;
   ```

## Code

- `server/046_paid_engagement.sql`
- `server/cqr-rollup.js`: `loadEngagement`, `engFigures`
- `public/js/cqr-rates.js`: the Engagement card and table switch
- `server/chat/rates.js`, `snapshot.js` (schema 16), `contract.md`, `chat-cards.js`
- `tests/cqr-rollup.test.js`

The n8n workflows live outside this repo. The workflow files are not
committed.

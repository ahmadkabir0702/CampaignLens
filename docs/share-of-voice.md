# Share of voice

A section in Campaign Lens showing digital share of voice by product category. A brand opens the category it belongs to: Lux, Lifebuoy and Pears all open skin cleansing, each with its own bar highlighted. A brand in more than one category gets a switch between them. Brands with no category set up see a short "not set up yet" message.

Everything shown is a percentage. The database holds shares only (0 to 1), with no post, comment or mention counts, so the product cannot show them.

## Files

| File | What it is |
|---|---|
| `server/017_share_of_voice.sql` | Tables. Run once. |
| `server/018_sov_seed_skin_cleansing.sql` | Skin cleansing results, 20 Jul to 18 Oct 2026. Safe to re-run. |
| `server/sov/routes.js` | `GET /api/sov`: categories for the active brand, brand-scoped like every other route. |
| `public/js/sov.js` | The page. Hooks into `setNav` and wraps `switchBrand`. |
| `public/css/sov.css` | Styles, on the design system tokens. |
| `server.js` | Mounts the routes; lets the two run endpoints past the login (they use a token). |
| `server/019_sov_pipeline.sql` | Run tables: brand handles and terms, category config, collected content, runs. |
| `server/030_sov_monthly_panels.sql` | Monthly cadence, review before publishing, brand-backed creator content, batch labelling, insight panels. |
| `server/020_sov_config_skin_cleansing.sql` | Skin cleansing handles, keywords, searches and themes. Safe to re-run. |
| `server/sov/automation.js` | `GET /api/sov/automation`, `POST /api/sov/runs`, `GET /api/sov/runs/:id`, for n8n. |
| `server/sov/pipeline/*.js` | The run: collect, label, work out shares, write the panels, publish. `panels.js` writes the "What's behind this" panels. |
| `server/sov/new_category_template.sql` | Fill in to add a category. |
| `n8n/sov-runs.json` | The n8n workflow: checks every day which categories are due, starts each one and watches it. |
| `public/index.html` | Nav item, page container, stylesheet, script, and the `setNav` wrapper. |

## Setup

1. In Supabase SQL editor, run `017_share_of_voice.sql`, then `018_sov_seed_skin_cleansing.sql`. The last statement of 018 prints the total share (about 1.0).
2. Upload the files above to the repo and let Render deploy.
3. Open Campaign Lens, pick Lux, Lifebuoy or Pears, and click "Share of voice".

## Data model

- `sov_categories`: one row per category.
- `sov_category_brands`: every brand measured in a category. `brand_id` is set only for brands that exist in Campaign Lens (lux, lifebuoy, pears); that link decides who sees the category.
- `sov_periods`: one row per published period, with `insights` (a JSON list of plain sentences, percentages only). The page shows the latest published period.
- `sov_brand_metrics`: per brand per period. `share_of_voice`, `share_no_contest`, `share_engagement`, `share_earned`, `share_public`, sentiment split, and the brand's share within Facebook, Instagram and TikTok.
- `sov_breakdowns`: `weekly_share`, `public_brand` (every brand named in public conversation, with its group), `topic`, `comment_type`, `author_type`.

## Adding a category or a new period

Insert the category and its brands, then a `sov_periods` row and its metrics and breakdowns, as 018 does. A new period for an existing category only needs the period, metrics and breakdowns. Set `is_published = false` to stage a period before it goes live.

## Monthly update

Each category has a `run_day` (default the 3rd). n8n checks every morning at 03:30 Sri Lanka time and starts any category that is due; Campaign Lens does the work itself, in the background:

1. **Brand posts.** New posts on each brand's pages since the last run, with 10 days of overlap for late numbers. A first run collects 12 weeks.
2. **Searches.** Brand searches, hashtags, the brand's tagged posts and the category searches in `sov_category_config`, covering the last 3 months and kept only inside the collection window.
3. **Creator countries.** TikTok creators are checked once and remembered in `sov_creators`.
4. **Labelling.** Claude Sonnet labels anything new: relevant or not, who made it, brands, themes, sentiment. Labels are kept, so nothing is labelled twice.
   - Requests go through the Message Batches API: half the price, same model and answers. Each batch is recorded in `sov_label_batches`, so if Render restarts mid-run the next run collects the finished labels instead of paying again.
   - Identical short replies ("price?", "nice") are labelled once and the label reused.
   - Emoji, empty and tag-only replies are labelled by rule.
5. **Conversation.** Replies on brand posts up to 35 days old, and on the most discussed public posts.
6. **Shares.** The last full calendar month is the headline, compared with the month before. The trend shows month by month, with 12 weeks of weekly detail.
7. **Summary and panels.** Claude writes the summary sentences and a "What's behind this" panel for each chart and each brand: what it shows, what drove it, what it means for the brand with a next step, and short translated consumer quotes with no names. Everything is written from computed figures, and a checker rejects any number that is not one of the figures, any platform name, posts, comments or mentions, and dashes.
8. **Publish** in one transaction, then email or Slack the result.

Content older than about 4 months is deleted. Commenters' names are never stored.

### Brand-backed creator content

Creator content made with a brand counts as that brand's voice, not earned:

- an Instagram collab (it also shows on the brand's page);
- a post the platform marks as a paid partnership or branded content;
- a disclosure in the caption (#ad, #sponsored, #collab, "in partnership with" and similar) naming a tracked brand;
- a creator post your team tracks in Campaign Lens as an Others Say creative.

The audience conversation on that content is earned. Earned voice is everything else: consumers, unpaid creators, sellers and media. The page shows each brand's voice split three ways in "Where each brand's voice comes from".

### Review before publishing

A category with `auto_publish = false` saves each period without putting it on the page. Internal accounts see it in Campaign Lens under a "Preview" banner; brand teams keep seeing the last published period. To put it live:

```
curl -X POST https://<campaign-lens>/api/sov/periods/<period_id>/publish -H "x-sov-token: <SOV_RUN_TOKEN>"
```

or in SQL, `update sov_periods set is_published = true where period_id = ...`. Then set `auto_publish = true` on the category so later months go live on their own. Every new category, and skin cleansing's first automated run, start on review.

**When nothing is published.** If the credit cap or the balance floor stops collection, the page keeps the last published month and the run is marked failed with the reason. The next run starts from the last successful one, so nothing is lost. A month with too little conversation (under `SOV_MIN_MENTIONS`) is also not published.

**Cost**, estimated from test runs: about 1,200 to 1,600 ScrapeCreators credits per category per month, and about 2,500 for a category's first 12-week run. Claude (Sonnet with batch processing) is about $3 to $4 a month per category, about $5 on the first run.

### Setup, once

1. Run `019_sov_pipeline.sql`, `020_sov_config_skin_cleansing.sql`, then `030_sov_monthly_panels.sql`, in the Supabase SQL editor.
2. On Render, add environment variables:

| Variable | Value |
|---|---|
| `SCRAPECREATORS_API_KEY` | The ScrapeCreators key. |
| `SOV_RUN_TOKEN` | A long random string (at least 16 characters). n8n sends it. |
| `SOV_MIN_CREDITS` | Optional. Stop a run when the balance falls to this. Default 300. |
| `SOV_FIRST_RUN_CAP` | Optional. Credit cap for a category's first run. Default 3000. |
| `SOV_LABEL_MODEL` | Optional. Default `claude-sonnet-5`. |
| `SOV_LABEL_MODE` | Optional. `batch` (default, half price) or `direct`. |
| `SOV_BATCH_WAIT_MIN` | Optional. How long a run waits for a batch before leaving it for the next run. Default 240. |
| `SOV_PANELS` | Optional. `off` to skip the panels. |
| `SOV_MIN_MENTIONS` | Optional. Below this the period is not published. Default 200. |

`ANTHROPIC_API_KEY` is already set for Ask Lens.

3. In n8n: Workflows, Import from file, `n8n/sov-runs.json`. Then:
   - Create a credential of type **Header Auth** named `Campaign Lens SOV token`: name `x-sov-token`, value the `SOV_RUN_TOKEN`. Select it on the HTTP nodes.
   - In the **Config** node set `baseUrl` to the Campaign Lens address.
   - It checks every day at 03:30 Sri Lanka time and only starts categories that are due. Move the time if it lands on the paid and organic sync.
   - Activate it. Set an error workflow on it if you want n8n to alert on failures too.

### Run one now

```
curl -X POST https://<campaign-lens>/api/sov/runs \
  -H "x-sov-token: <SOV_RUN_TOKEN>" -H "content-type: application/json" \
  -d '{"category_id":"skin_cleansing"}'
```

It returns a run id. `GET /api/sov/runs/<id>` with the same header shows the phase and the last lines of the log. Only one run goes at a time; a second request gets 409. Add `"backfill": true` to recollect 12 weeks.

## Adding another category

Configuration only, no code:

1. Copy `server/sov/new_category_template.sql`, fill it in and run it. What it needs:
   - **Brands**: names, owners, which are Unilever, and for brands that are in Campaign Lens their `brand_id` (that decides who sees the category).
   - **Handles**: each brand's Sri Lanka Facebook page URL, Instagram and TikTok handles.
   - **Name spellings**: English, Sinhala and Tamil. Mark names that are ordinary words as ambiguous, and pages that sell other categories as `multi`.
   - **Category words and searches**: 60 to 100 industry searches across languages and needs, a shorter list for Facebook and Instagram, and a few Sri Lankan hashtags.
   - **Other brands** to watch in earned conversation, with a group for colour.
   - **Themes**: 8 to 14 codes with the names to show.
   - **Run day**: spread categories over the 3rd to the 6th.
2. Check the Campaign Lens brands are linked: `select * from sov_category_brands where category_id = '...'`.
3. Start a first run by hand and read the email. It collects 12 weeks (about 2,500 credits), so check the balance first.
4. Open Campaign Lens on one of the linked brands as an internal account and read the preview. If something irrelevant is counted, tighten the terms, set the brand to ambiguous or `multi`, or narrow the scope note, then run again with `"backfill": true`.
5. Publish the period and set `auto_publish = true`.

Set `is_automated = false` to pause a category without losing anything.

The skin cleansing period from the first manual study (20 Jul to 18 Oct 2026) stays in the database. Brand teams keep seeing it until the first monthly period is published.

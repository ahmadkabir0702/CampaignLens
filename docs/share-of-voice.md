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
| `server/019_sov_pipeline.sql` | Weekly run tables: brand handles and terms, category config, collected content, runs. |
| `server/020_sov_config_skin_cleansing.sql` | Skin cleansing handles, keywords, searches and themes. Safe to re-run. |
| `server/sov/automation.js` | `GET /api/sov/automation`, `POST /api/sov/runs`, `GET /api/sov/runs/:id`, for n8n. |
| `server/sov/pipeline/*.js` | The weekly run: collect, label, work out shares, publish. |
| `server/sov/new_category_template.sql` | Fill in to add a category. |
| `n8n/sov-weekly.json` | The n8n workflow: starts the run every Monday and watches it. |
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

## Weekly update

Every Monday n8n asks Campaign Lens to update each automated category. Campaign Lens does the work itself, in the background:

1. **Brand posts.** New posts on each brand's pages since the last run (10 days of overlap for late numbers).
2. **Searches.** Brand searches, hashtags, the brand's tagged posts and the category searches in `sov_category_config`.
3. **Creator countries.** TikTok creators are checked once and remembered in `sov_creators`.
4. **Labelling.** Claude Sonnet labels anything new: relevant or not, who wrote it, brands, themes, sentiment. Labels are kept, so nothing is labelled twice. Emoji, empty and tag-only replies are labelled by rule.
5. **Conversation.** Replies on brand posts from the last two weeks, and on the most discussed public posts.
6. **Shares.** The last 4 full weeks (Monday to Sunday) become the headline; 12 weeks feed the weekly chart. Claude writes the summary sentences from the figures; a checker rejects any sentence with a number that is not one of the figures, or that names a platform or says posts or comments, and a plain template is used if it fails twice.
7. **Publish** in one transaction, then email or Slack the result (same `RESEND_*` / `SLACK_WEBHOOK_URL` settings as the creative notifications).

Content older than about 4 months is deleted. Commenters' names are never stored.

**When nothing is published.** If the credit cap or the balance floor stops collection, the page keeps last week's figures and the run is marked failed with the reason. The next run starts from the last successful one, so nothing is lost. A window with too little conversation (under `SOV_MIN_MENTIONS`) is also not published.

**Cost.** About 550 to 650 ScrapeCreators credits per category per week (roughly $5 a month at $47 per 25,000 credits). The first run for a category collects 12 weeks and uses about 2,000. Claude labelling is about $2 to $3 a week per category, more on the first run.

### Setup, once

1. Run `019_sov_pipeline.sql`, then `020_sov_config_skin_cleansing.sql`, in the Supabase SQL editor.
2. On Render, add environment variables:

| Variable | Value |
|---|---|
| `SCRAPECREATORS_API_KEY` | The ScrapeCreators key. |
| `SOV_RUN_TOKEN` | A long random string (at least 16 characters). n8n sends it. |
| `SOV_MIN_CREDITS` | Optional. Stop a run when the balance falls to this. Default 300. |
| `SOV_FIRST_RUN_CAP` | Optional. Credit cap for a category's first run. Default 3000. |
| `SOV_LABEL_MODEL` | Optional. Default `claude-sonnet-5`, the same Sonnet Ask Lens uses. |
| `SOV_MIN_MENTIONS` | Optional. Below this the period is not published. Default 200. |

`ANTHROPIC_API_KEY` is already set for Ask Lens.

3. In n8n: Workflows, Import from file, `n8n/sov-weekly.json`. Then:
   - Create a credential of type **Header Auth** named `Campaign Lens SOV token`: name `x-sov-token`, value the `SOV_RUN_TOKEN`. Select it on the three HTTP nodes.
   - In the **Config** node set `baseUrl` to the Campaign Lens address.
   - The schedule is Monday 03:30 Sri Lanka time. Move it if it lands on the paid and organic sync.
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
2. Check the Campaign Lens brands are linked: `select * from sov_category_brands where category_id = '...'`.
3. Start a first run by hand and read the email. It collects 12 weeks (about 2,000 credits), so check the balance first.
4. Open Campaign Lens on one of the linked brands and read the page. If something irrelevant is counted, tighten the terms, set the brand to ambiguous or `multi`, or narrow the scope note, then run again with `"backfill": true`.

From then on the Monday run includes it. Set `is_automated = false` to pause a category without losing anything.

The skin cleansing period from the first manual run (20 Jul to 18 Oct 2026) stays in the database. The page shows whichever published period ends last, so the weekly rolling period takes over from the first Monday run.

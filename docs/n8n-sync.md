# The n8n sync: what updates, for how long, and what is logged

Two workflows in n8n, outside this repo:

- **Brand Sync (parent)** runs every 30 minutes. It loops over active
  brands that have a Meta token and runs the child for each, then writes
  a row to `sync_runs`.
- **Brand Sync (child)** runs one brand: paid first, then organic.

## How long organic numbers update

| Posts | Platform | Window | How often |
|---|---|---|---|
| Brand Say | Instagram, Facebook, TikTok | 30 days from the post date | every sync |
| Others Say, collab | Instagram | 7 days | every sync for 48 hours, then hourly |
| Others Say, not collab | Instagram, Facebook, TikTok | 48 hours | at most every 12 hours (paid scraper) |

A post that has never been read gets one first reading even when it is
outside its window, so a post added late still gets numbers. For Brand
Say this applies to posts added in the last 30 days.

## Boosted posts

Organic numbers stop updating once spend on that platform is behind the
post: the counts would include paid delivery. The last reading before the
boost is kept.

- TikTok stops on TikTok spend (`v_boost_status.on_tt_paid`).
- Instagram and Facebook stop together on Meta spend (`on_meta_paid`).

A post with spend on a platform before its first reading there gets no
organic numbers on that platform, because any reading would include paid.

## What is logged

`sync_errors` holds what is broken right now. A clean read closes it.

| source | What | Shown |
|---|---|---|
| `step` | A whole brand could not be read on a platform: TikTok token, TikTok video list, Facebook Page token, Instagram media list. `creative_id` is `STEP:<brand>:<step>`. | Admin, Data and errors, Sync problems |
| `run` | The whole child run failed. `creative_id` is `RUN:<brand>`. | Admin, Sync problems |
| `ig_collab`, `ig_scrape`, `tt_scrape`, `fb_scrape` | One Others Say post could not be read. | Coordinator page, on the post |

A `step` or `run` problem closes itself after a clean run where it did
not happen again (the parent's Log Run node).

A refused token or call ends only that platform's branch; the other
platforms still run for the brand.

## Keys

No keys are typed into the workflows:

- Meta and TikTok tokens come from `v_brand_runtime`.
- The ScrapeCreators key is the `scrapecreators_key` row in
  `integration_secrets`, read by the query that feeds each scrape node.
  n8n runs on its own server, so Render's environment does not reach it.
- The manual TikTok onboarding nodes read the app id and secret from
  `v_brand_runtime`. The one-time code is pasted when used and not saved.

Never commit an exported workflow that still has a key in it.

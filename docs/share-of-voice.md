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
| `server.js` | One added line mounting the route. |
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

The collection and labelling that produce these numbers run outside the app (see the share of voice handover). Automating them weekly would write new periods into these same tables.

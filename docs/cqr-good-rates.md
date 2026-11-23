# CQR Good rate, Hook Good rate and Hold Good rate

Part 1 of the paid roll-up. Part 2 (engagement rate and cost per engagement)
follows separately.

## What the figures are

Paid video only. Each video keeps the rating it already has, worked out on
its full paid run. Nothing is re-rated and no benchmark changes.

| Figure | Worked out as |
|---|---|
| CQR Good rate | impressions on videos rated Good / impressions on videos with a CQR grade |
| Hook Good rate | impressions on videos whose hook is rated Good / the same total |
| Hold Good rate | impressions on videos whose hold is rated Good / the same total |
| Impressions rated | impressions on videos with a CQR grade / all paid video impressions |

- Videos under 10,000 impressions read Low Delivery, are not rated and sit
  outside the three rates. They still count in Impressions rated's total.
- Photos and carousels are left out: they have no paid rating.
- Meta and TikTok are worked out separately. Combined adds the impressions
  together; it never averages the two rates.
- For a date range, only impressions inside the range count. Each video
  still carries its full-run rating.
- Campaign is the Campaign Lens campaign the video was added under.
- The count beside each figure, "(9 of 10 videos)", is the existing
  count-based share: one vote per video. A video on both platforms counts
  once on each.

## Where it shows

**Media Summary**, a new "Paid video quality" section above Paid:

- Date range: All time, Last 30 days, This month, Last month, This year, Custom.
- Meta, TikTok and Combined rows for the brand, or for the campaign picked in
  the page's Campaign filter. The page's other filters (Month, Platform,
  Posted by) are about organic posts and publish months, so they do not apply.
- A table by campaign.
- Compare brands: side by side for the same dates. Mindshare logins and the
  admin only, and only across brands the login can already see. Unilever
  logins see their own brands only. Agencies have no access to any of it.

**Ask Lens** reads the same code, so the two never disagree:

- The all-time brand and campaign figures are in the brand data.
- A new `cqr_rates` tool works them out for a date range, a campaign or a
  platform.
- New markers: `cqr_good_rate`, `hook_good_rate`, `hold_good_rate`,
  `rated_share`. Each badge shows the video count beside the figure.

## Endpoints

- `GET /api/cqr-rates?brand=&from=&to=`: one brand, overall and by campaign.
- `GET /api/cqr-rates/compare?from=&to=&brands=`: several brands, overall.

Dates are YYYY-MM-DD. Both sit behind the Media Summary flag (`can_media`).
Results are kept for five minutes, since paid data lands once a day.

## Code

- `server/cqr-rollup.js`: the figures.
- `public/js/cqr-rates.js`: the Media Summary section.
- `server/chat/rates.js`: Ask Lens records and the `cqr_rates` tool.
- `tests/cqr-rollup.test.js`.

No database change: it reads `v_paid_meta_scored`, `v_paid_tiktok_scored`,
`v_paid_meta_creative`, `v_paid_tiktok_creative` and `creatives`.

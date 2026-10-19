# CQR benchmarks

Every rating rule in Campaign Lens and the benchmark it is graded against, as set by migration 023. All figures are percentages. A brand's own rows always win over the global ones.

## How each type is rated

| Type | Rated on | Benchmark table |
|---|---|---|
| Paid video, Brand Say and Others Say | Hook rate and hold rate over the whole paid run, each day weighted by its impressions | `cqr_thresholds` (`meta_paid_bs`, `meta_paid_os`, `tt_paid_bs`, `tt_paid_os`) |
| Organic Brand Say video | Average watch time ÷ video length | `cqr_thresholds` (`ig_organic`, `fb_organic`, `tt_organic`) |
| Organic Others Say video | (likes + 2 × comments) ÷ views | `cqr_os_benchmarks`, rebuilt from creator posts with no spend behind them. A brand with 5 or more on a platform is rated against its own creators there (migration 028); otherwise against all brands, each brand with 3 or more posts counting equally (027) |
| Photo and carousel, Brand Say | (likes + comments + shares + saves) ÷ reach, or ÷ views where there is no reach | `static_thresholds` |
| Photo and carousel, Others Say | (likes + 2 × comments) ÷ views, or ÷ followers where there are no public views | `static_thresholds` |
| Paid photo and carousel | Not rated, because the paid rating is built on video watch rates | none |

Paid grades are worked out as follows:
- **Good:** hook and hold are both Good.
- **Poor:** both are Poor, or one is Poor and the other Average.
- **Average:** anything else.
- **Low Delivery:** under 10,000 impressions, so no grade is given.

## Global video benchmarks

The Good marks were kept where they were. Poor now starts at about 70% of Good, so there is a real Average band.

**Paid, as set by 023.** Migration 025 then re-sets every global paid band from your own results: Good from the 60th percentile and Poor below the 25th, separately for Meta and TikTok, Brand Say and Others Say, and each video length. Its output lists the bands it set, and those replace the table below. Hold is counted against all impressions, so it is always lower than the hook rate. The global hold bars in this table were higher than the hook bars and almost nothing could clear them, which is why 025 exists.

| | Meta Poor below | Meta Good from | TikTok Poor below | TikTok Good from |
|---|---|---|---|---|
| Hook rate | 7 | 10 | 21 | 30 |
| Hold, under 10s | 17.5 | 25 | 10.5 | 15 |
| Hold, 10 to 15s | 13 | 19 | 8.5 | 12 |
| Hold, 15 to 60s | 10.5 | 15 | 7 | 10 |
| Hold, 60s and over | 5 | 7 | 5 | 7 |

The Meta hook is 3-second views per impression. The TikTok hook is 2-second views per impression, which is why its marks are higher.

**Organic Brand Say retention**

| Video length | Instagram Poor / Good | Facebook Poor / Good | TikTok Poor / Good |
|---|---|---|---|
| Under 15s | 17.5 / 25 | 17.5 / 25 | 10.5 / 15 |
| 15 to 30s | 12.5 / 18 | 14 / 20 | 7 / 10 |
| 30 to 60s | 10.5 / 15 | 11 / 16 | 5.5 / 8 |
| 60s and over | 7 / 10 | 8.5 / 12 | 4 / 6 |

## Brand benchmarks

- **Vaseline** has its own paid hook and hold and its own organic retention, all higher than the global ones.
- **Sunsilk** gets the same benchmarks as Vaseline if migration 024 is run.
- **Knorr** has its own organic retention bands. Good starts at 3% for videos under 15 seconds, which looks like seconds of watch time entered as percentages. Confirm the numbers before relying on Knorr's organic grades.
- **Every other brand** is rated on the global benchmarks.

## Photo and carousel benchmarks

These are starting values for Sri Lanka. A row for Carousel wins over the row for both formats. Check them against real results once a few weeks of posts are in.

| Type | Platform | Read on | Format | Poor below | Good from |
|---|---|---|---|---|---|
| Brand Say | Instagram | reach | both | 1 | 3 |
| Brand Say | Instagram | reach | Carousel | 1.5 | 4 |
| Brand Say | Instagram | views | both | 0.7 | 2 |
| Brand Say | Instagram | views | Carousel | 1 | 2.5 |
| Brand Say | Facebook | reach | both | 0.5 | 2 |
| Brand Say | Facebook | views | both | 0.4 | 1.5 |
| Brand Say | TikTok | reach | both | 2 | 5 |
| Brand Say | TikTok | views | both | 1.5 | 4 |
| Others Say | Instagram | followers | both | 0.4 | 1.5 |
| Others Say | Instagram | followers | Carousel | 0.5 | 2 |
| Others Say | Instagram | views | both | 0.8 | 3 |
| Others Say | Facebook | followers | both | 0.05 | 0.3 |
| Others Say | Facebook | views | both | 0.5 | 2 |
| Others Say | TikTok | followers | both | 0.5 | 2 |
| Others Say | TikTok | views | both | 2 | 5 |

## Changing a benchmark

Benchmarks are rows in a table, so changing one needs no deploy. To give one brand its own photo band:

```sql
insert into static_thresholds (brand_id, platform, creative_type, basis, content_type, good_gte, poor_lt)
values ('vaseline', 'ig', 'Brand Say', 'reach', null, 4, 1.5);
```

The same pattern works for video in `cqr_thresholds` with `platform`, `metric`, `min_duration` and `max_duration`. A band runs from its minimum up to, but not including, its maximum.

## Retired rows

Migration 023 moved 43 rows that no rule read into `cqr_thresholds_retired`. Each one records why it was moved:
- the engagement_rate and avg_watch_time rows;
- the Others Say organic retention rows (Others Say is rated against `cqr_os_benchmarks`);
- the `meta_paid` and `tt_paid` rows with no `_bs` or `_os`.

They were only confusing: anyone editing them saw nothing change. To bring one back, copy it into `cqr_thresholds`.

## Rating history

When rules or benchmarks change, ratings move without anything happening to the creative. Migration 023 records that move once in `cqr_history`, with `reason = 'rule change'`. The Hub and Ask Lens leave those rows out, so the history only shows real movement.

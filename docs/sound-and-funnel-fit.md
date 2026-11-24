# Sound and Funnel fit

Two checks Campaign Lens adds next to the Pre-test Score, on pre-tests and on every tracked creative.

- **Funnel fit.** How well the creative suits awareness, consideration and conversion (0 to 100 each), what it is built for, and what would make it fit better.
- **Sound.** Loudness against the platform level, clipping, whether the voice is clear over the music, whether the brand is named early, and whether it works with the sound off.

Colours follow one rule everywhere: green 70 and above, amber 50 to 69, red below 50.

## How it fits with the Pre-test Score

The Pre-test Score is unchanged and stays the headline number. Our results sit beside it in their own table (`lens_checks`) and never change it.

| | Tracked creative | Pre-test |
|---|---|---|
| Where the video comes from | The worker downloads it from the post link, as before | The browser uploads it once to private storage (R2) |
| Pre-test Score | As before, for brands on auto-scoring | The worker sends the file to the scoring service |
| Video analysis | The analysis the worker already runs, with a few more fields | One analysis per pre-test |
| Sound | ffmpeg on the file the worker already has | ffmpeg on the uploaded file |
| Funnel fit | From the Pre-test Score checks when there is a score, else from the analysis alone | Same |

The Pre-test Score arrives about five minutes after the analysis. When it does, Funnel fit is worked out again with the scored checks, which take over from the analysis' own reading where both exist.

Funnel fit reads the scored checks (brand and product in the first seconds, attention on the brand, reading time, an engaging opening, sound-off, call to action) plus the analysis (reasons to buy, offer, call to action, direct action, urgency, length). It also says what the ad is built for: an offer with a direct ask reads as conversion, reasons to choose the product as consideration, anything else as awareness. When a Pre-test Score exists it counts for a quarter of each stage, so a weak creative cannot look like a strong fit by default.

All thresholds are in `server/lens/score.js`.

## Setup

1. **Database.** Run `server/045_lens_checks.sql` in the Supabase SQL editor **before** deploying. It adds `lens_checks`, two columns on `brainsuite_jobs`, and the `v_creative_tests` view.
2. **Cloudflare R2** (free tier):
   1. Create a bucket, for example `campaignlens-pretests`. Leave public access off.
   2. Bucket settings, CORS policy:
      ```json
      [{ "AllowedOrigins": ["https://<your Campaign Lens domain>"],
         "AllowedMethods": ["PUT"],
         "AllowedHeaders": ["content-type"],
         "MaxAgeSeconds": 3600 }]
      ```
   3. Bucket settings, Object lifecycle rules: delete objects 1 day after upload (the backstop; the worker deletes each file as soon as it is done).
   4. R2, Manage API tokens: create a token with **Object Read & Write** on **this bucket only**.
   5. Turn on two-factor sign-in for the Cloudflare account.
3. **Render**, on the service that runs the worker, add:
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   - optional `PRETEST_CONCURRENCY` (default 2), `FFMPEG_PATH` (default: the bundled ffmpeg-static)

Until the four R2 variables are set, pre-tests keep the old direct upload and get no Sound or Funnel fit. Tracked creatives get both as soon as the SQL has run.

## Security

- The bucket is private. Upload links are made by the server only for a logged-in user with access to the brand, work for one object with a random name, are locked to the file's type and exact size, and expire after 15 minutes.
- The worker checks the file is really there at that size before starting, and that it is an MP4, MOV or WebM video before anything else reads it.
- ffmpeg reads local files only (`-protocol_whitelist file`), so a crafted file cannot make the server fetch another address. Every run has a time limit. The same guard rails apply to tracked creatives.
- The token reaches this one bucket. Files are deleted after processing, and after a day at most.

## Backfill

Creatives added before this get nothing until backfilled:

```
node scripts/backfill-lens.js --dry                 how many are missing
node scripts/backfill-lens.js --brand=lux           quick: Funnel fit from stored fields, no cost
node scripts/backfill-lens.js --full --limit=5      full: download again, analyse, Sound included (~$0.06 each)
```

The quick run has no reasons to buy, offers or Sound, so it is a rougher read. The full run matches a newly added creative.

## Recommendations (n8n)

The recommendation writer lives in n8n, so it reads the tests through the view. In the workflow, before the Claude step, add a Postgres node:

```sql
select * from v_creative_tests where creative_id = '{{ $json.creative_id }}'
```

Then add this block to the Claude prompt, after the performance data:

```
PRE-LAUNCH TESTS FOR THIS CREATIVE
These judge the creative itself, not its results. Fields left empty were not tested.
Pre-test Score: {{pretest_score}} ({{pretest_rating}}). Checks to improve: {{pretest_to_improve}}
Funnel fit: built for {{built_for}}, fit {{built_for_fit}}. Awareness {{awareness_fit}}, consideration {{consideration_fit}}, conversion {{conversion_fit}}. {{funnel_verdict}}
Sound: {{sound_score}}. Checks: {{sound_checks}}

How to use them:
- Real performance outranks any test. Never let a test overrule what the numbers show.
- Use the tests to explain results. Example: weak hold plus "brand not in the first seconds" means people leave before the brand lands.
- When a test and the results disagree, say so in one line and go with the results.
- Use the funnel fit to judge whether the creative is in the right job: a conversion creative with a weak conversion fit needs a clearer ask; an awareness creative should be judged on reach and hold, not clicks.
- Call them the Pre-test Score, Funnel fit and Sound check. Never name a vendor or tool, and never quote pass marks or thresholds.
```

Ask Lens reads Funnel fit and Sound from the snapshot already (schema version 18).

## Cost

- Tracked creatives: a few more output fields on the existing analysis, well under a cent each. ffmpeg is free.
- Pre-tests: one video analysis each, about $0.06.
- R2: free at these volumes (files are deleted within minutes).

# Sound and Funnel fit

Two checks Campaign Lens adds next to the Pre-test Score, on pre-tests and on every tracked creative.

- **Funnel fit.** How well the creative suits awareness, consideration and conversion (0 to 100 each), what it is built for, and what would make it fit better.
- **Sound.** Loudness against the platform level, clipping, whether the voice is clear over the music, whether the brand is named early, and whether it works with the sound off.

Colours follow one rule everywhere: green 70 and above, amber 50 to 69, red below 50.

## How it fits with the Pre-test Score

The Pre-test Score is never changed by anything here. Our results sit in their own table (`lens_checks`).

On tracked creatives the Pre-test Score stays the headline, with Funnel fit and Sound beside it. On pre-tests the headline is the score for the objective (see "Pre-tests are judged on their objective" below).

| | Tracked creative | Pre-test |
|---|---|---|
| Where the video comes from | The worker downloads it from the post link, as before | The browser uploads it once to private storage (R2) |
| Pre-test Score | As before, for brands on auto-scoring | The worker sends the file to the scoring service |
| Video analysis | The analysis the worker already runs, with a few more fields | One analysis per pre-test |
| Sound | ffmpeg on the file the worker already has | ffmpeg on the uploaded file |
| Funnel fit | The Pre-test Score weighted for each objective. No Pre-test Score, no fit score (what it is built for is still shown) | Same |

The Pre-test Score arrives about five minutes after the analysis. The objective scores are worked out when it does. The scored "Works with the sound off" check also takes over from the analysis' own reading in Sound.

What the ad reads as comes from the analysis: an offer with a direct ask reads as conversion, reasons to choose the product as consideration, anything else as awareness.

### How each objective score is made

Each objective score **is the Pre-test Score, weighted for that objective**. It uses the same scored checks, the same pass marks and the same placement as the Pre-test Score. Only the weight given to each of its categories changes with what the video is for. It is never a separate number: without a Pre-test Score there is no objective score.

| | Awareness | Consideration | Conversion |
|---|---|---|---|
| Attention | 35% | 20% | 20% |
| Branding | 35% | 10% | 10% |
| Processing Ease | 10% | 30% | 15% |
| Emotional Engagement | 15% | 10% | |
| Persuasion | | 25% | 20% |
| The ask (offer, call to action, urgency) | | | 30% |
| Sound | 5% | 5% | 5% |

- Category scores are the tested placement's, as the scoring service reports them. Persuasion is not in the scoring service's own total, but it counts here for consideration and conversion.
- **The ask** is the one part the Pre-test Score has no checks for: call to action (the scored check when there is one), a direct ask, an offer and urgency, from the video analysis.
- **Sound** counts for 5%. A part that is missing (no sound track, nothing known about the ask) is left out and the rest are scaled to 100.
- The weights are `MIX` in `server/lens/score.js`. Agreed November 2026.

Example (TikTok, Pre-test Score 64; Attention 50, Branding 75, Processing Ease 70, Emotional Engagement 67, Sound 80): awareness = 0.35x50 + 0.35x75 + 0.10x70 + 0.15x67 + 0.05x80 = **65**.

## Pre-tests are judged on their objective

The person uploading a pre-test picks its objective: Awareness, Consideration or Conversion. The report is built around that choice.

- **Headline.** The score for the chosen objective, out of 100, with the other two objectives shown smaller beside it. If another objective scores clearly higher, the report says so.
- **How it is worked out.** Under the headline: "Pre-test Score 64, weighted for awareness", and a table of each category's score and its share of the objective score.
- **What to improve.** Scored checks to fix are split in two: the ones that count toward this objective, then the rest.
- **No second verdict.** The overall Pre-test Score appears only as the base of the objective score, not as a separate score lower down.
- **One final report.** Nothing is shown while a pre-test is still being scored or analysed. The list says Queued, Analysing or Finishing, and the report opens once every part is in, so the numbers never move after someone has seen them.
- **If scoring does not finish.** There are no objective scores, since they are built from the Pre-test Score. The report says so at the top and shows Sound and the video analysis.

The objective is kept in `brainsuite_jobs.objective` (migration 048) and is never sent to the scoring service. A pre-test with no objective (run before this) is scored for what the video reads as. Tracked creatives have no objective yet, so they keep "built for".

All thresholds are in `server/lens/score.js`.

## Setup

1. **Database.** Run `server/045_lens_checks.sql` in the Supabase SQL editor **before** deploying. It adds `lens_checks`, two columns on `brainsuite_jobs`, and the `v_creative_tests` view. Then run `server/048_pretest_objective.sql`, which adds the objective column. Pre-tests still run without 048, but the objective is not kept.
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

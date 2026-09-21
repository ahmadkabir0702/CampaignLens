# Campaign Lens semantic contract

This file tells Ask Lens what the numbers mean. It is the single highest
leverage piece of the system: the same model with this document answers far
more accurately than a larger model without it.

It is meant to be edited by the team. If a definition here is wrong, the
chat is wrong. Keep it in the language your planners actually use.

---

## What this data covers

Paid social (Meta and TikTok) and organic social (Facebook, Instagram,
TikTok) for Unilever Sri Lanka brands, managed by Mindshare Fulcrum.

One brand is selected at a time. Every answer is about that brand only.

Paid figures are **lifetime per creative**, not per period. A creative that
ran in March and a creative that ran last week each carry their full
lifetime totals. This matches the Creative Hub exactly.

Organic figures are **lifetime per post**, and most organic performance
lands within 48 hours of posting.

---

## The metric hierarchy

The team judges creative in this order. Use it for any question that does
not name a metric.

1. **CQR** — creative quality rating. Good, Average, Poor, Invalid.
2. **Hook rate** — the share of viewers who stayed past the opening.
3. **Hold rate** — the share retained through the body.
4. **Engagement rate**
5. **Reach** and **video views**

"Best performing", "top", "winning", "doing well" all mean: best CQR first,
then hook rate, then hold rate.

**CTR, VTR, CPM and CPC are vanity metrics here.** Never volunteer them.
Report one only if the user names it, and say nothing that implies it
matters.

---

## What CQR actually is

CQR is a single quality rating per creative per platform, derived from hook
rate and hold rate against duration-aware thresholds that the brand sets
itself. A 45% hook rate can be Strong on a 60-second video and Weak on a
6-second one, so a raw percentage means nothing without its threshold.

When a creative runs on both Meta and TikTok, its overall CQR is the
**better** of the two. The per-platform split is available and matters:
Good overall with Poor on TikTok means the cut is not native to TikTok.

- **Good** — both hook and hold clear the brand's Good thresholds
- **Average** — one clears, one does not
- **Poor** — neither clears
- **Invalid** — not enough delivery to rate

---

## Strong and Weak

Every hook rate and hold rate carries a Strong or Weak qualifier computed
against the brand's own thresholds for that platform and duration bucket.

**Use those words.** Do not decide for yourself whether a percentage is
good. The qualifier already encodes the brand's judgment.

### Reading the combinations

- **Strong hook, Weak hold** — the opener works, the body loses people.
  The fix is in the middle: tighten it, cut repetition, get to the point.
- **Weak hook, Strong hold** — whoever stays, stays. The problem is the
  first three seconds. Change the opening frame, not the body.
- **Strong hook, Strong hold** — working. Look at what it does and whether
  it can be repeated.
- **Weak hook, Weak hold** — not working. Say so plainly.

---

## Retention

The retention curve is six points: 0s, hook, 25%, 50%, 75%, 100%. The
largest gap between consecutive points is where the creative loses people.

Code pre-computes the drop location and what was on screen at that moment.
When explaining why a creative holds or does not, cite that, not the
hold rate alone.

---

## How merging works

A creative can run on Meta, TikTok, both, or neither.

- CQR: the better of the two platforms
- Hook rate: average across platforms
- Hold rate: the higher of the two
- Spend and impressions: summed
- Reach: the higher of the two, never summed (the same person can be
  reached on both platforms)

---

## Creative attributes

Every creative is classified by Gemini at ingest. These are independent
axes; a creative has one value on each.

- **format** — how it was shot: music_video, product_demo, talking_head,
  testimonial, lifestyle, tutorial, ugc, animation, other
- **content_intent** — what job it is doing: educate, entertain,
  demonstrate, prove, announce, inspire, promote_offer
- **narrative_structure** — how it is built: problem_solution, story, tips,
  demo, montage, testimonial_arc, performance
- **product_role** — how present the product is: hero, featured,
  incidental, absent
- **hook_device** — the opening move in the first 3 seconds: question,
  bold_claim, problem, product_reveal, face_to_camera, motion,
  text_overlay, sound, before_after, unexpected_visual
- **hook_subject** — what is on screen at the open: person, product, text,
  scene
- **hook_pace** — single_shot or fast_cut
- **opens_with_product**, **opens_with_face**, **has_text_overlay** — true
  or false

**type** is separate and not classified: BrandSay is brand-produced,
OthersSay is creator or influencer content.

---

## The minimum group size rule

**A pattern in fewer than 5 creatives is not a pattern.**

Every rollup and crosstab in the snapshot carries its group size. If a
group is below 5, the snapshot marks it `TOO FEW`. When that happens, say
there is not enough data to compare rather than reporting the number.

This is not optional caution. Reporting a three-creative fluke as a trend
is how a tool loses the team's trust.

---

## The volume floor

Creatives with fewer than 10,000 lifetime impressions are excluded from all
rankings. A Good rating on 300 impressions is noise, not a top performer.

The snapshot states how many were excluded. Mention it when reporting a
ranking.

---

## Benchmarks

The only benchmarks that exist here are the brand's own:

- `cqr_thresholds` — the Good and Poor cutoffs per metric, platform and
  duration bucket
- the monthly plan targets for spend, reach, impressions, frequency and
  engagement rate

**Never cite an industry average, a category norm, or a number from
outside this data.** If a metric has no threshold set, say the brand has
not set one.

"What counts as a good hook rate for us" is a fair question and is answered
from the thresholds. "What's the industry average" is not answerable.

---

## Media waste

A creative rated Poor that is still ACTIVE and carrying meaningful spend is
media waste. The snapshot lists these. Raise it when it is relevant, even
if the user did not ask.

---

## The boost workflow

Organic posts are validated first. A post that passes validation should be
boosted; the dashboard flags it after 48 hours if it has not been. The
snapshot lists validated-but-not-boosted posts. These are the boost
candidates.

---

## What is missing, and how to say so

- **TikTok paid engagement** is not collected yet, so paid engagement rate
  is Meta only. Never present a Meta-only engagement figure as a
  whole-brand number.
- **Hook rate, hold rate and CQR have no daily series.** They are lifetime
  scores. If asked how hook rate changed over time, say so. Spend, reach,
  impressions and video views do have daily series.
- **Organic is not date filtered.** It is lifetime per post.

When something is genuinely not answerable from this data, say so in one
sentence and name what would answer it. An honest "not available" is a
better answer than a plausible guess.

---

## How to answer

Lead with the answer. Two to four sentences plus markers. No preamble, no
restating the question, no closing summary.

Say what the data shows and, where the data supports it, why. Point at
patterns: a hook device that outperforms, a platform soaking up spend
without returning quality, repurposed cuts lagging their originals.

Never invent a reason. Each creative may carry an Insights diagnosis
(works / not / do). When asked why something works, synthesise across those
for the relevant set. That is grounded. Anything else is not.

Never write a metric value as text. Emit a marker and the interface renders
the real value from the database.

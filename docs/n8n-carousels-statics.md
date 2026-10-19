# n8n changes for carousels and static posts

Campaign Lens accepts photo and carousel posts for Brand Say and Others Say (migration 022). These are the changes made to the **Brand Sync (child)** workflow so the syncs fill their numbers. The edited workflow was delivered as `Brand_Sync_child_statics.json`. It is not kept in this repo because it carries API keys.

Run migration 022 **before** importing the workflow, because two of the write nodes now set `organic_perf.followers`.

---

## Brand Say Instagram

| Node | Change |
|---|---|
| Get IG Media Page | Also asks for `media_type` and `media_product_type`. |
| Resolve IG Media IDs | Passes the type on, plus `is_reel` (true for `REELS`). Matching on the shortcode already covered `/p/` links. |
| Get IG Insights | Photos and carousels (`FEED`) are asked only `reach,saved,shares,total_interactions,views`. Instagram rejects the whole request if one metric does not apply, so asking a carousel for reel watch time would fail it. Errors are now let through, so one post cannot stop the brand. |
| Process IG Insights | Watch time and hook rate are null for photos and carousels, not zero. Errors are logged and skipped. |

## Brand Say Facebook

| Node | Change |
|---|---|
| Get FB Sheet Rows | Also returns `content_type`. |
| Match & Filter FB Posts | Videos only. Photos and carousels go to the new branch. |
| **Match FB Statics** (new) | Reads the photo id (`fbid=`), or the post id from `/posts/{id}` or `permalink.php`. |
| **Get FB Static Post** (new) | For a photo, finds its post (`page_story_id`), where the numbers live. |
| **Get FB Static Insights** (new) | Fetches reactions, comments, shares, `post_total_media_view_unique` (people reached) and `post_media_view` (views), plus the reaction breakdown. These are Meta's replacements for the retired `post_impressions_unique` and `post_impressions`. Only counts are requested, never who reacted. |
| **Process FB Static** (new) | Shapes the numbers like the video branch. |
| Map organic fb | Writes `reach` when there is one. |

A Facebook post link with a `pfbid…` token cannot be read through the Graph API. Campaign Lens now stores those links in numeric form when the creative is added.

## Brand Say TikTok

| Node | Change |
|---|---|
| Extract TT Video IDs, Process TT Insights | Match `/photo/{id}` as well as `/video/{id}`. |
| Get TT Refresh Due | Also picks Brand Say photo posts. If the business API does not return photo posts, the public numbers keep them current. If it does, its numbers are kept. |

## Others Say

| Node | Change |
|---|---|
| map_ig_scrape, Write IG NonCollab | Save the creator's follower count to `organic_perf.followers`. Creators' photos have no public views, so they are rated per follower. |
| tt_scrape_map, Write TT Organic | The same for TikTok. |

Instagram Others Say rows are chosen by `creatives.ig_shortcode`. Migration 022 fills it for `/p/` links too, and adds a trigger that fills it for every new creative.

---

## Ratings for statics (for reference)

Statics are rated on engagement and compared only with other statics. The bands live in `static_thresholds` and can be tuned per brand without a deploy:

| Type | Read on |
|---|---|
| Brand Say | engagement per person reached, or per view where there is no reach |
| Others Say | likes plus twice the comments, per view where there are views (TikTok), otherwise per follower |

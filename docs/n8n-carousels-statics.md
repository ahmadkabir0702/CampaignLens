# n8n changes for carousels and static posts

Campaign Lens now accepts photo and carousel posts for Brand Say and Others Say (migration 022). It reads the slides itself, stores them and rates the post on engagement. The organic numbers still come from n8n, and these changes let the syncs fill them for statics too.

Until they are made:
- **Others Say statics** work already: they get their numbers when they are added, and the 12-hour sync refreshes them if it passes the stored link to ScrapeCreators. Check that in step 3.
- **Brand Say statics** get public likes and comments when they are added. Reach, saves and shares only arrive once step 1 or 2 is done, and Brand Say statics are rated on reach.

---

## 1. Brand Say Instagram: include photo and carousel posts

**Now.** The media pull either keeps only reels or asks every post for reel metrics. A photo or carousel then either never reaches `organic_perf` or makes the insights call fail.

**Change.**

1. **List every type of post.** On the media list, request
   `id,media_type,media_product_type,permalink,shortcode,timestamp,like_count,comments_count`.
   Keep `IMAGE`, `CAROUSEL_ALBUM` and `VIDEO` (reels).
2. **Split the insights call by type,** because Instagram rejects the whole request if one metric does not apply to that post:
   - Reels (`media_product_type = REELS`): the metrics already requested.
   - Photos and carousels (`media_product_type = FEED`, `media_type` `IMAGE` or `CAROUSEL_ALBUM`): `reach,views,likes,comments,saved,shares,total_interactions`. Never ask these for `ig_reels_avg_watch_time` or other reel-only metrics.
3. **Match on the shortcode.** A static's link is stored as `https://www.instagram.com/p/{shortcode}/` and a reel's as `/reel/{shortcode}/`. Match the shortcode from `permalink` (or `shortcode`) against the end of `creatives.ig_link`, whichever of the two forms it uses.
4. **Write the row** to `organic_perf` as for reels: `views`, `reach`, `likes`, `comments`, `saves` (from `saved`), `shares`, `total_interactions`, `time_posted`. Leave `avg_watch_time` null.

`v_organic_scored` will give these posts a state such as "No Duration". That is expected. Campaign Lens works out the rating for photos and carousels itself from these numbers (`server/static-rating.js`).

---

## 2. Brand Say Facebook: include photo and album posts

**Now.** The Facebook branch matches video ids. A photo post's id is a different number from its photo's id, so nothing matches.

**What Campaign Lens stores for a static:**
- `https://www.facebook.com/photo/?fbid={photo id}` for a photo link
- `https://www.facebook.com/{page}/posts/{post id}` for a post link. A `pfbid…` link is replaced with this numeric form when the post is fetched.

**Change.**

1. **Request the attachments** on the page posts call, so each post carries the ids of its photos:
   `attachments{media_type,target{id},subattachments{target{id}}}`
2. **Match** a creative when the numeric id at the end of `creatives.fb_link` (the `fbid=` value for a photo link) equals any of:
   - the post id: the part of `id` after the underscore;
   - `attachments.target.id`, which is the photo for a single-photo post;
   - any `subattachments.target.id`, which are the photos in an album.
3. **Request the post's numbers** with the same reach metric the video branch already uses, plus reactions, comments and shares. Write them to `organic_perf` with `platform = 'fb'`. Video views are null for a photo, which is fine.

---

## 3. Others Say sync (every 12 hours): check it covers statics

It should need no change if it calls ScrapeCreators with the creative's stored link. Two things to check:

1. **The link filter.** If the node picks creatives with a pattern such as `ig_link like '%/reel/%'` or `tt_link like '%/video/%'`, widen it to include `/p/` and `/photo/`.
2. **Instagram photo views.** For a photo, `video_play_count` is absent. Map it to null, not 0, the same as hidden like counts.

**Optional:** write the follower count to `organic_perf.followers`. Instagram has it at `data.xdt_shortcode_media.owner.edge_followed_by.count`, TikTok at `aweme_detail.author.follower_count`. Others Say photos on Instagram are rated per follower. The count is saved when the creative is added, so this only keeps it current.

---

## 4. Brand Say TikTok: photo posts

TikTok photo posts are stored as `https://www.tiktok.com/@{handle}/photo/{item id}`.

- **If the TikTok business pull returns photo posts:** match their item id against the id after `/photo/`, the same way `/video/` ids are matched now.
- **If it does not:** those creatives keep the public numbers saved when they were added, which include views, likes, comments, shares and saves.

---

## Ratings for statics (for reference)

Statics are rated on engagement and compared only with other statics. The bands live in `static_thresholds`, created by migration 022, and can be tuned per brand without a deploy:

| Type | Read on |
|---|---|
| Brand Say | engagement per person reached, or per view where a platform gives views but no reach |
| Others Say | likes plus twice the comments, per view where there are views (TikTok), otherwise per follower |

The starting bands are a judgement, not a benchmark. Review them once a few weeks of statics are in.

# n8n changes outstanding

The ingestion workflows live in n8n, outside this repo. This is the list
of what needs changing there, with the reason and the evidence, so the
work can be done in one sitting rather than discovered one bug at a time.

Ordered by how much damage each one is doing.

---

## 1. The Instagram pull writes blank rows

**Evidence.** 23 rows in `organic_perf` with `platform = 'ig'` and every
other column null, including `creative_id` and `time_posted`. No media
id, no numbers, nothing. They are not posts.

**Cause.** An insert node is firing on items that carry no media. Most
likely the same branch as the pagination fault below: when the media
lookup returns an empty result the item still reaches the insert.

**Change.** Put a condition in front of the insert node requiring a media
id on the item. An empty result should end the branch, not write a row.

**Clean up what is already there.** Safe, because the rows hold no data:

```sql
delete from organic_perf
 where creative_id is null and views is null and time_posted is null;
```

These blank rows also broke migration 006 on its first run, because
`organic_perf_history` requires a `creative_id`. That migration now skips
them, but they should stop being created.

---

## 2. Boosted posts are being filtered out of the organic pull

**Evidence.** On Sunsilk, every Instagram post missing from
`organic_perf` had Ad Status "Boosted" in the source sheet. The
correlation was exact.

**Why it matters.** Boosting a post does not replace its organic
performance, it adds paid delivery alongside it. Filtering boosted posts
out means the posts the brand believed in most are the ones with no
organic record, which is backwards. It also makes the organic standing
percentile wrong, because the strongest posts are missing from the
comparison set.

**Change.** Remove the Ad Status condition from the organic branch. Pull
every post regardless of whether it has been boosted.

---

## 3. Instagram pagination never advances

**Evidence.** A run returned 10 pages of identical results.

**Cause.** The response carries `paging.cursors.after`, and the next
request is not passing it.

**Change.** Take `paging.cursors.after` from each response and send it as
the `after` query parameter on the next request. Stop when `paging.next`
is absent rather than after a fixed page count. While the cursor is
ignored, any account with more than one page of media is silently
truncated to its first page, so this is not only a wasted-calls problem.

---

## 4. Collaboration posts return nothing, and it looks like failure

**Evidence.** The Sunsilk Rashi creative is a collaboration post owned by
`rashiprabha`'s account. The brand token cannot read it, so no row is
ever written.

**This is not fixable in n8n.** Meta returns media for the account that
owns it. A collab post lives on the creator's account, and the brand is
tagged rather than the owner.

**Change.** Make the failure legible instead of silent. When a creative
has a link on file and the media lookup returns nothing, write a row to
`sync_errors` naming the creative and the platform, with a reason such as
`not_returned_by_owner_account`. The Creative Hub already reads
`sync_errors` on the coordinator page, and the validation panel already
distinguishes "no numbers came back" from "weak post", so the information
has somewhere to land.

**The real fix is contractual.** Ask the creator to add the brand as a
collaborator with insights access, or brief through TikTok Creator
Marketplace, where data access comes with the engagement.

---

## 5. Pull the Facebook reaction breakdown

**New, not a bug.** Migration `008_fb_reactions.sql` adds the columns.
They stay null until n8n requests the fields.

Facebook reports reactions by type on posts the Page owns. The totals
treat a like and an angry identically, so a post can read as engaged when
the engagement is people objecting to it. This is the only sentiment
signal available through the official APIs without reading comments.

**Change.** On the Facebook post node, request each reaction type as its
own summarised edge:

```
fields=reactions.type(LIKE).limit(0).summary(total_count).as(like),
       reactions.type(LOVE).limit(0).summary(total_count).as(love),
       reactions.type(HAHA).limit(0).summary(total_count).as(haha),
       reactions.type(WOW).limit(0).summary(total_count).as(wow),
       reactions.type(SAD).limit(0).summary(total_count).as(sad),
       reactions.type(ANGRY).limit(0).summary(total_count).as(angry)
```

`limit(0)` means no reaction rows come back, only the counts, so nothing
identifying anyone is requested or stored.

Map each `summary.total_count` into the matching column on
`organic_perf`: `reaction_like`, `reaction_love`, `reaction_haha`,
`reaction_wow`, `reaction_sad`, `reaction_angry`.

Instagram and TikTok report one like total with no breakdown, so leave
those branches alone. The panel hides the block when the columns are
null.

---

## Nothing needed for community posts

The Community sub-type is entered in the app when a creative is added, so
n8n needs no change for it.

Worth knowing what will happen: community posts are owned by members of
the public, so the brand token cannot read them and no row will come
back. That is the same wall as item 4, and with item 1 fixed it will
correctly produce nothing rather than a blank row. The validation panel
reports it as "no numbers came back" rather than as weak performance.

Numbers for community posts have to come from the manual entry on the
coordinator page, or from a licensed listening platform if the agency has
one.

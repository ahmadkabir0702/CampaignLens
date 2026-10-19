# Scaling the Creative Hub

How the dashboard loads its data, what it costs, and what to build if a brand outgrows it.

## How it works

The browser does not hold a brand's creative list any more. The Creative Hub asks the server for one page at a time.

- `/api/dashboard-data?lite=1` sends the brand, campaigns, the Media Summary's account numbers, the hub's dropdown options and the brand's creative count. No creatives.
- `/api/creatives` returns one page of the hub: `?platform&q&month&campaign&contentType&status&source&origin&validation&action&sort&dir&offset&limit`. The first request for a filter also asks for `summary=1`, which adds the tiles for that filter and the creatives the named tiles point at. Filters, search, sort and tiles run in `server/hub.js` with the same rules the browser used to apply.
- `/api/creative-details?ids=` sends the panel-only fields (scene timeline, brief, recommendation text) and the creative's lineage when it is opened.
- `/api/creatives/library` sends every creative, slim, for Media Summary and Creators, which still work their figures out in the browser. It is fetched only when one of those pages is opened.
- `/api/creatives/ids` lists every id for the add form's "repurposed from" picker.

On the page:

- Cards on screen stay there while a new filter loads, and only dim if the answer takes more than 300ms.
- Search waits for typing to pause (250ms), or runs at once on Enter.
- The next page is fetched as soon as one is drawn, so it is usually there before the end of the grid comes into view.
- Answers are kept for 30 seconds, so going back to a filter you just had is instant. A write you make clears them.

On the server:

- A brand's payload is built once from Postgres and reused. It is fresh for 30 seconds. Between 30 seconds and 5 minutes, a request gets the last build at once and a new one is built behind it, so data that only n8n has touched never makes anyone wait. Past 5 minutes the request waits for the new build.
- A write through the API (adding a creative, marking an action) clears the cache, so the next request waits for a fresh build and shows the change. Switching brand, checking links and Ask Lens no longer count as writes.
- Each build keeps an index: the slim list, lookups by id, lineage, dropdown options and the last 64 filtered and sorted lists. Scrolling through one filter's pages filters and sorts once.

## Measured on a synthetic brand

Same machine, warm server cache, `/api` bytes before gzip.

| | Before (whole list) | After (paged) |
|---|---|---|
| 5,000 creatives: data sent to the browser | 8.4 MB | 180 KB (first page, tiles, prefetched second page) |
| 5,000 creatives: browser memory | 26 MB | 10 MB |
| 20,000 creatives: cards on screen | 2.0 s | 0.7 s |
| 20,000 creatives: browser memory | 86 MB | 10 MB |
| 20,000 creatives: build on the server | 2.1 s | 2.1 s, hidden by the cache except after a write |

The page's size in the browser no longer grows with the brand. The server build still does.

## How to tell when the build needs to change

Every build writes one line to the server log:

```
[payload] brand=sunsilk creatives=1200 build=640ms
```

When a build passes either threshold the line is a warning that names this file. The thresholds are environment variables on Render, with no deploy needed:

| Variable | Default | Meaning |
|---|---|---|
| `PAYLOAD_WARN_CREATIVES` | 3000 | Creatives for one brand |
| `PAYLOAD_WARN_BUILD_MS` | 1000 | Milliseconds to build one brand's payload |

An admin can see the latest figures for every brand at `/api/payload-stats`.

## What to build if a brand crosses the line

1. **A ready-made cards table.** Each card is assembled from several views that work out ratings, boost state, validation and fatigue on the fly, which is what makes the build slow. A `creative_cards` table, one row per creative with what a card shows, refreshed after an n8n pull, a new creative, a finished analysis or a marked action, and indexed on brand, date, campaign and rating, would let `/api/creatives` query a page straight from Postgres instead of building the whole brand first.
2. **Media Summary and Creators on the server.** Both still load the slim list when opened. Their figures can move to endpoints that return totals for the current filters, the way the hub's tiles already do.

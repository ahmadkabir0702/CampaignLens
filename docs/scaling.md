# Scaling the Creative Hub

How the dashboard loads its data today, how to tell when that stops being the right design, and what to build then.

## How it works today

- `/api/dashboard-data` sends the browser a slim record of every creative for the active brand. The fields only the creative panel reads (scene timeline, brief, recommendation text) are left out and fetched from `/api/creative-details` when a creative is opened.
- Responses are gzipped, and a built payload is cached per brand for 30 seconds. Any successful write through the API, or a finished analysis job, clears it.
- The Creative Hub draws 48 cards at a time and draws more as the end of the grid comes into view.
- Filters, search, sorting and every total (Creative Hub tiles, Media Summary, Creators) are worked out in the browser from that list.

This is the fastest experience while a brand has up to a few thousand creatives: every filter change is instant, with no round trip to the server.

## How to tell when it needs to change

Every payload build writes one line to the server log:

```
[payload] brand=sunsilk creatives=1200 build=640ms list=1950KB
```

- `creatives`: how many creatives the brand has.
- `build`: how long the server took to assemble them.
- `list`: the size of the list sent to the browser, before gzip.

When a build passes either threshold, the line is logged as a warning that names this file. The thresholds are set with environment variables on Render, with no deploy needed:

| Variable | Default | Meaning |
|---|---|---|
| `PAYLOAD_WARN_CREATIVES` | 3000 | Creatives for one brand |
| `PAYLOAD_WARN_BUILD_MS` | 1000 | Milliseconds to build one brand's payload |

An admin can see the latest figures for every brand at `/api/payload-stats`. They cover brands built since the server last started.

## What to build when a brand crosses the line

Do them in this order. Each step is useful without the next.

1. **A ready-made cards table.** Each card is assembled today from several views that work out ratings, boost state, validation and fatigue on the fly, and filtering across those views on every request would be slow. Keep a `creative_cards` table, one row per creative with exactly what a card shows, refreshed when data changes: after an n8n pull, a new creative, a finished analysis or a marked action. Index it on brand, date, campaign and rating.
2. **The Creative Hub on the server.** `GET /api/creatives?brand&filters&q&sort&cursor&limit=48` returns one page and a total. The grid keeps its current cards on screen while the next page loads, shows a placeholder only past about 300ms, waits for typing to pause before searching, and fetches the next page before it is needed.
3. **Totals on the server.** The Creative Hub tiles, Media Summary and Creators get their figures for the current filters from the server, cached per brand and filter.
4. **Lookups on demand.** Repurposed lineage and pre-test names fetch what they need instead of searching the full list in the browser.

Expect each filter change to take one round trip (typically 150–400ms) instead of being instant. That is the cost of not holding the library in the browser, and the reason not to make this move before it is needed.

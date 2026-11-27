# When an ad counts as running

One rule, used everywhere Campaign Lens says an ad is running: the card's "Ad running" pill, the summary row's Paid status, the Active and Stopped filters, the Live count, the Fatiguing chip and filter, the fatigue panel's Running or Stopped badge, and Ask Lens.

**A creative is running on a platform when one of its ads delivered there in the last two days (`date >= current_date - 2`, impressions above zero) and that day's status was active (`ACTIVE` on Meta, `ENABLE` on TikTok).**

Where it is worked out:
- Creative Hub: `paidExtras` in `creatives.js`, per creative and platform.
- Ask Lens: `server/chat/running.js`.
- Fatigue panel: `fatigueFor` in `server/fatigue.js`.

## Why not the stored status alone

The nightly sync stores each ad's status on the day it delivered. When an ad is paused, no new rows arrive, so its last stored status stays active for good. The lifetime views' `is_active` is also "active on any day ever". Before this rule, the per-platform status on the card read that flag directly, so a paused ad showed "Ad running" for good while the filters and counts said it had ended.

## What it cannot see yet

An ad paused today still delivered yesterday with an active status, so it reads as running for up to two days after it is paused. Closing that gap needs the nightly sync to write each recently delivered ad's current status back onto its latest row. That is a change to the n8n sync, not to this app.

TikTok's status is the ad's own switch (`operation_status`), which stays `ENABLE` when its ad group or campaign is switched off. The delivery check covers this once delivery stops, with the same two-day lag.

# Security

How Campaign Lens protects accounts and client data, what has to be set on
Render, and the routine jobs that keep it that way.

## Settings on Render

| Variable | Needed | What it does |
|---|---|---|
| `SESSION_SECRET` | Yes, 32+ characters | Signs session cookies. If it is missing or short, the app makes a random one at each start, so nobody can forge a cookie but every deploy signs everyone out. |
| `DATABASE_CA_CERT` | Recommended | The Supabase CA certificate (PEM text, from Project Settings > Database > SSL). With it set, the database's certificate is checked; without it the connection is encrypted but not verified. |
| `ALLOWED_ORIGINS` | Only if needed | Extra sites allowed to post to the app, comma separated. Leave unset: the app's own address is always allowed. |
| `ASK_LENS_WARM_SECRET`, `SOV_RUN_TOKEN` | For n8n | Tokens n8n sends. Compared in constant time. |

## Controls

**Signing in**
- Most logins are shared by a team, so wrong passwords are counted three ways, over 15 minutes:
    - 5 from one browser on one login: that browser waits. Colleagues on the same login are not affected.
    - 20 on one login from anywhere: treated as a guessing attack, and the login waits for everyone.
    - 50 from one network address across all logins: that address waits.
  All are logged. A correct sign-in clears only that browser's count.
- A new session id is issued at sign-in.
- Sessions end after 8 hours idle and 12 hours at most, however active.
- Each signed-in account is re-read once a minute. Deactivating an account, removing its brands or changing its password signs it out everywhere within a minute (the session that changed the password stays in).
- The session cookie is HttpOnly, SameSite=Lax, and Secure in production.

**Passwords**
- New passwords: at least 12 characters, at most 72 bytes (the bcrypt limit), no leading or trailing space, not a common password, not containing the username. Stored with bcrypt cost 12.
- Five wrong current passwords on the change form locks the form in that browser for 15 minutes.

**Requests**
- A state-changing request whose Origin or Referer names another site is refused.
- Every response carries a Content-Security-Policy (scripts and data only from this site, no framing, no plugins), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS over HTTPS. API answers are not cached.
- No CORS: the API answers only its own pages.
- Chart.js is served from the app (`public/vendor`), not a third-party CDN.

**Access**
- Every data route checks the brand against the session's brand list; a brand outside it gets 403.
- Section flags are enforced on the server (`FEATURE_GATES` in server.js), not only hidden in the menu.
- Creating campaigns, editing creators and re-running a video analysis are for Unilever and Mindshare accounts only. Marking a recommendation actioned is for Unilever and the admin.

**Output**
- Everything typed by people or read from platforms and AI (campaign names, creator handles, captions, hooks, recommendations, error text) is escaped before it is put on the page. Values passed into inline handlers go through `jsq()`; links go through `safeUrl()`, which drops anything but http and https.
- Names people type are checked on the server too (`cleanName()`): 120 characters, no control characters, no `<` or `>`.
- A failed request shows our own message when we refused it, and "Something went wrong" otherwise. Database errors and stack traces stay in the log.

**Cost and abuse**
- Ask Lens is limited per login: 60 questions an hour and 300 a day by default, set for a shared team login (`ASK_LENS_PER_HOUR`, `ASK_LENS_PER_DAY` on Render). It refuses questions if the limit cannot be counted.
- The open test route that called Gemini, the raw upload test page and the unused media queue routes are removed.

## Routine jobs

Most of these are done on the Admin page (admin role only): add a login, change its brands and sections, reset its password, switch it off. Every change there is written to `app_admin_log` and shown under Change log. Changes apply within a minute, including to people already signed in.

- **Someone leaves.** For a personal login, switch it off on the Admin page. They are signed out within a minute. For a shared login, change its password instead and give the new one to the people who stay: everyone on that login is signed out within a minute and signs in with the new password.
- **Every quarter.** Rotate the shared logins' passwords (Reset password on the Admin page). Check Usage on the Admin page and switch off logins nobody uses.
- **Backups.** Confirm in Supabase (Project Settings > Database > Backups) that daily backups, and point-in-time recovery if on the Pro plan, are on. Test a restore to a branch once a year.
- **Dependencies.** Run `npm audit` before each release.

## Known gaps

- Inline handlers (`onclick="..."`) mean the policy must allow inline scripts. Moving them to event listeners would let the policy forbid inline script entirely.
- Shared logins (one per category or agency) mean actions are recorded against the login, not the person.
- `npm audit` reports a moderate advisory in `uuid`, reached through `@google/genai`. It affects only `v3`, `v5` and `v6` with a buffer argument; the library uses `v4`, so it is not reachable. Upgrading `@google/genai` to 1.x clears it.
- `server/035_campaign_signoff.sql` holds the bcrypt hash of the media head's first temporary password. It was marked must-change; confirm it has been changed (query in the pull request).
- The n8n workflows and the database's base schema are outside this repository, so they are not covered by review.

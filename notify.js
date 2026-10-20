/**
 * notify.js — admin notifications for background creative processing
 *
 * No npm dependency: both transports are plain HTTPS calls.
 *
 *   Email  — set RESEND_API_KEY, NOTIFY_FROM, NOTIFY_TO
 *   Slack  — set SLACK_WEBHOOK_URL
 *
 * Both can be on at once. With neither set it logs and moves on, so a missing
 * key never fails a job — a notification is an aside, not part of the work.
 */

const RESEND_KEY   = process.env.RESEND_API_KEY || null;
const NOTIFY_FROM  = process.env.NOTIFY_FROM || 'Campaign Lens <onboarding@resend.dev>';
const NOTIFY_TO    = (process.env.NOTIFY_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const SLACK_HOOK   = process.env.SLACK_WEBHOOK_URL || null;
const APP_URL      = process.env.APP_URL || '';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendEmail(subject, html) {
  if (!RESEND_KEY || !NOTIFY_TO.length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: NOTIFY_FROM, to: NOTIFY_TO, subject, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

async function sendSlack(text) {
  if (!SLACK_HOOK) return false;
  const res = await fetch(SLACK_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}`);
  return true;
}

/** Creative processed and written to the database. */
async function notifySuccess(info) {
  const { creativeId, brand, campaign, platform, duration, hook, addedBy } = info;
  const subject = `Creative added — ${creativeId}`;
  const html = `
    <div style="font-family:Rubik,Arial,Helvetica,sans-serif;color:#1A1A4F;font-size:15px;line-height:22px;max-width:520px">
      <p style="margin:0 0 6px;font-size:16px">Creative added to the system</p>
      <p style="margin:0 0 18px;color:#4A4A75;font-size:14px">
        The video was analysed successfully and is now in the Creative Hub.
      </p>

      <p style="margin:0 0 6px;color:#4A4A75;font-size:13px">Creative ID — use this in the ad name, after the pipe</p>
      <div style="display:inline-block;padding:12px 16px;margin:0 0 20px;background:#F4F6F8;
                  border:1px solid #DCDCE6;border-radius:6px;
                  font-family:'Courier New',Courier,monospace;font-size:18px;
                  letter-spacing:.5px;color:#000050">
        ${esc(creativeId)}
      </div>

      <table style="border-collapse:collapse;font-size:14px;margin-bottom:4px">
        <tr><td style="padding:3px 18px 3px 0;color:#4A4A75">Brand</td><td>${esc(brand)}</td></tr>
        <tr><td style="padding:3px 18px 3px 0;color:#4A4A75">Campaign</td><td>${esc(campaign)}</td></tr>
        <tr><td style="padding:3px 18px 3px 0;color:#4A4A75">Platform</td><td>${esc(platform)}</td></tr>
        <tr><td style="padding:3px 18px 3px 0;color:#4A4A75">Duration</td><td>${duration == null ? 'not detected' : esc(duration) + 's'}</td></tr>
        ${addedBy ? `<tr><td style="padding:3px 18px 3px 0;color:#4A4A75">Added by</td><td>${esc(addedBy)}</td></tr>` : ''}
      </table>

      ${hook ? `<p style="margin:16px 0 0;padding:12px 14px;background:#F4F6F8;border-radius:6px;color:#4A4A75;font-size:14px"><strong style="color:#1A1A4F;font-weight:500">Hook</strong><br>${esc(hook)}</p>` : ''}
      ${APP_URL ? `<p style="margin:22px 0 0"><a href="${esc(APP_URL)}" style="color:#000050;font-weight:500">Open Campaign Lens</a></p>` : ''}
    </div>`;
  const slack = `:white_check_mark: Creative added — \`${creativeId}\`\n> ${brand} / ${campaign} · ${platform}${duration == null ? '' : ` · ${duration}s`}`;
  return dispatch(subject, html, slack);
}

/** Analysis failed after every retry. Nothing was written. */
async function notifyFailure(info) {
  const { creativeId, brand, campaign, link, error, attempts } = info;
  const subject = `Creative could not be added — ${campaign}`;
  const html = `
    <div style="font-family:Rubik,Arial,sans-serif;color:#1A1A4F;font-size:15px;line-height:22px">
      <p style="margin:0 0 6px;font-size:16px">Creative could not be added</p>
      <p style="margin:0 0 16px;color:#4A4A75;font-size:14px">
        The video failed to process after ${esc(attempts)} attempts.
        <strong style="color:#1A1A4F">Nothing was written to the database</strong> and no creative ID was
        issued — add it again to retry.
      </p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:3px 16px 3px 0;color:#4A4A75">Brand</td><td>${esc(brand)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;color:#4A4A75">Campaign</td><td>${esc(campaign)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;color:#4A4A75">Link</td><td style="word-break:break-all">${esc(link)}</td></tr>
      </table>
      <p style="margin:14px 0 0;padding:10px 12px;background:#FBEEF1;border-radius:6px;color:#A32040;font-size:14px">
        ${esc(error)}
      </p>
    </div>`;
  const slack = `:x: Creative could not be added — ${brand} / ${campaign} (${attempts} attempts, nothing saved)\n> ${error}`;
  return dispatch(subject, html, slack);
}

async function dispatch(subject, html, slackText) {
  const sent = [];
  // Each transport is caught separately: Slack being down must not stop the
  // email, and neither can be allowed to fail the job.
  try { if (await sendEmail(subject, html)) sent.push('email'); }
  catch (e) { console.error('[notify] email failed:', e.message); }
  try { if (await sendSlack(slackText)) sent.push('slack'); }
  catch (e) { console.error('[notify] slack failed:', e.message); }

  if (!sent.length) console.log(`[notify] (no transport configured) ${subject}`);
  else console.log(`[notify] sent via ${sent.join(' + ')}: ${subject}`);
  return sent;
}

/** A plain admin message from any background job (share of voice runs use it). */
function notifyAdmin(subject, html, slackText) {
  return dispatch(subject, html, slackText || subject);
}

module.exports = { notifySuccess, notifyFailure, notifyAdmin, esc };

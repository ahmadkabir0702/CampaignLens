/**
 * worker.js — background creative processor
 *
 * Does everything /api/add-creative used to do inline, minus the initial row
 * insert (which stays in the route so the creative appears immediately):
 *
 *   1. resolve a CDN link via RapidAPI
 *   2. stream the mp4 to a temp file
 *   3. upload to Gemini, wait for processing
 *   4. ask for hook + a fixed-interval timeline + duration
 *   5. write the analysis back to `creatives`
 *
 * Runs two ways, same code:
 *   - in-process, started from server.js (default — no extra Render service)
 *   - standalone, `node worker.js`, when you want a dedicated service
 *
 * At ~17 videos a day the in-process worker is free and sufficient. Splitting
 * it out later is a start command, not a rewrite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { query } = require('./db');
const { notifySuccess, notifyFailure } = require('./notify');

// Gemini model. Google retires these on their own schedule — 2.5-flash was
// pulled for new users — so it is an env var, changeable without a deploy.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Cost levers, all env-tunable so they can be tried without a deploy.
//   GEMINI_THINKING_BUDGET  thinking tokens bill at OUTPUT rates. Describing
//                           what is on screen needs little reasoning, so a low
//                           budget is cheaper and faster. -1 = model default,
//                           0 = off where the model allows it.
//   GEMINI_MEDIA_RESOLUTION video input is ~60% of the cost. 'low' cuts it
//                           substantially; the trade is small on-screen text.
const THINKING_BUDGET = process.env.GEMINI_THINKING_BUDGET === undefined
  ? null : Number(process.env.GEMINI_THINKING_BUDGET);
const MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || null;

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST
  || 'instagram-tiktok-youtube-downloader.p.rapidapi.com';

// Segment granularity. Fixed intervals, not scene changes: retention data is
// time-indexed, so to say "hold rate collapses at 6s and here is what was on
// screen at 6s" the descriptions have to sit on the same time grid.
const SEG_SECONDS = Number(process.env.SEGMENT_SECONDS || 2);
const MAX_SEGMENTS = Number(process.env.MAX_SEGMENTS || 60);

/**
 * Widen the interval rather than truncating long videos. A 149s video at 2s
 * needs 75 windows; capping at 60 described only the first 120s and left the
 * last 29 unanalysed. Stepping to 3s covers the whole thing in 50 windows,
 * which also keeps output tokens — and the model's tendency to give up on
 * long lists — under control.
 */
function stepFor(duration) {
  if (!duration || duration <= 0) return SEG_SECONDS;
  let step = SEG_SECONDS;
  while (Math.ceil(duration / step) > MAX_SEGMENTS) step += 1;
  return step;
}

// Structured output. responseMimeType alone asks for JSON without saying what
// shape; a schema constrains it, which is what stops the model returning an
// object where an array is expected or renaming keys.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    duration: { type: 'number' },
    format: {
      type: 'string',
      enum: ['music_video', 'product_demo', 'talking_head', 'testimonial',
             'lifestyle', 'tutorial', 'ugc', 'animation', 'other'],
    },
    product_role: { type: 'string', enum: ['hero', 'featured', 'incidental', 'absent'] },
    format_note: { type: 'string' },
    hook: { type: 'string' },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number' },
          d: { type: 'string' },
        },
        required: ['t', 'd'],
      },
    },
  },
  required: ['duration', 'format', 'product_role', 'format_note', 'hook', 'timeline'],
  propertyOrdering: ['duration', 'format', 'product_role', 'format_note', 'hook', 'timeline'],
};

function buildPrompt(hintDuration) {
  const dur = hintDuration && hintDuration > 0 ? hintDuration : null;
  const step = stepFor(dur);
  const n = dur ? Math.ceil(dur / step) : null;

  return `Watch this video carefully and describe it on a fixed time grid.

Return ONE JSON object with these keys:

"duration": the exact length of the video in seconds (number).

"format": what kind of video this is. Exactly one of:
  "music_video" — a song is the primary content and someone performs it on screen or as the audio.
  "product_demo" — the product and how it is used or what it does is the main subject.
  "talking_head" — a person addresses the camera directly for most of the runtime.
  "testimonial" — a person recounts their own experience with the product.
  "lifestyle" — mood, scenery and daily-life moments; the product is incidental to the scene.
  "tutorial" — the video teaches steps, a routine or a how-to.
  "ugc" — casual, handheld, creator-style footage.
  "animation" — animated or motion graphics with no live footage.
  "other" — none of the above fit.

"product_role": how present the product is. Exactly one of "hero" (the product is the main subject and on screen most of the time), "featured" (it has a clear moment but is not the subject throughout), "incidental" (it appears briefly or as a prop), "absent" (it never appears on screen).

"format_note": one sentence explaining the classification, naming who is on screen and what they are doing in relation to the brand. Example: "Original song performed by the artist on screen; the lotion appears as a prop in the closing scene." If someone sings, say so here and do not describe the singing as speech.

"hook": 1-2 sentences describing the opening hook — what grabs attention in the first two seconds.

"timeline": an array of ${n ? `exactly ${n}` : ''} objects, one per ${step}-second window, covering the whole video from 0 to the end with no gaps. Each object:
  { "t": <window start in seconds, a multiple of ${step}>,
    "d": "<one sentence, present tense, describing what is on screen and what is said or heard in that window>" }
Cover EVERY window in order. Do NOT merge, skip or group windows — a window where little happens still gets its own entry saying so. ${n ? `The array must contain ${n} entries: t = 0, ${step}, ${step * 2}, and so on up to ${(n - 1) * step}.` : ''} If a window is visually similar to the one before, say what changed rather than repeating the text. Name what matters for performance: who is on screen, what they do, on-screen text, product visibility, scene cuts, and audio or voiceover. When someone speaks or sings, write the actual words as close to verbatim as you can make out — do not just note that speech or a voiceover is happening. If a word is genuinely unclear, give your best guess followed by a question mark rather than skip it.

TRANSCRIBE IN THE LANGUAGE SPOKEN. Sri Lankan content is often in Sinhala or Tamil, sometimes mixed with English in the same line. Write the words in the language they are sung or spoken in, using that language's own script, and do not translate them. Never leave words out because they are not in English.

LYRICS COUNT AS SPEECH. In a music video the lyrics are the content, so a window over a sung line must contain that line. Descriptions like "she sings into a microphone", "the chorus plays" or "rap section performed" without the words are not acceptable on their own — the words are what is being asked for. Instrumental passages with no vocals are the one exception; say so plainly for those windows.

Return only the JSON object. No markdown, no commentary.`;
}

// ── Step 1: CDN link ──────────────────────────────────────────────────────────
async function resolveMediaUrl(mediaUrl) {
  if (!process.env.RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY is not set.');

  const { data } = await axios.request({
    method: 'GET',
    url: `https://${RAPIDAPI_HOST}/fetch`,
    params: { url: mediaUrl },
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
    timeout: 60000,
  });

  // The API returns HTTP 200 with ok:false on failure, so the status code
  // alone is not enough to tell success from failure.
  if (!data || data.ok === false) {
    throw new Error(`API rejected the link: ${(data && (data.error || data.message)) || 'unknown reason'}`);
  }
  if (!data.download_url) throw new Error('API returned no download_url.');
  return data;
}

// ── Step 2: download ──────────────────────────────────────────────────────────
async function streamToFile(url, destPath) {
  // CDN links are signed and short-lived, and Instagram's fbcdn rejects
  // requests without a browser-ish user agent.
  const res = await axios({
    url, method: 'GET', responseType: 'stream',
    timeout: 180000, maxRedirects: 5,
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', err => {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });

  const { size } = fs.statSync(destPath);
  if (size < 10240) {
    fs.unlinkSync(destPath);
    throw new Error('Downloaded file was too small to be a video.');
  }

  // An image post downloads perfectly well and passes the size check, and is
  // then sent to Gemini labelled video/mp4. Gemini answers with a 500 INTERNAL
  // that says nothing about the real problem, and all three job attempts burn
  // identically. Check what the bytes actually are and say so.
  const kind = sniffMediaType(destPath);
  if (kind !== 'video') {
    fs.unlinkSync(destPath);
    throw new Error(kind === 'image'
      ? 'That link is a static image post, not a video. Only videos can be analysed.'
      : `Downloaded file is not a video (detected: ${kind}).`);
  }
  return destPath;
}

/**
 * Identify a file from its magic bytes rather than trusting the extension or
 * the URL: 'video', 'image', or a short label for anything else.
 */
function sniffMediaType(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16);
  try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }

  // ISO base media (mp4/mov/m4v): 'ftyp' at offset 4
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'video';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video'; // webm/mkv
  if (buf.slice(0, 3).toString('latin1') === 'FLV') return 'video';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'AVI ') return 'video';

  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image';                      // jpeg
  if (buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return 'image'; // png
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image';
  if (buf.slice(4, 12).toString('latin1') === 'ftypavif') return 'image';

  if (buf.slice(0, 5).toString('latin1') === '<!DOC' || buf.slice(0, 5).toString('latin1') === '<html') return 'an HTML page';
  return 'unrecognised format';
}

// ── Gemini call wrapper ───────────────────────────────────────────────────────
// Google returns 500 INTERNAL / 503 UNAVAILABLE intermittently. Left alone one
// of those fails the whole job, throwing away a download that succeeded. These
// retry in place, and the error is labelled so a failure says which call broke.
const GEMINI_TRANSIENT = /\b(429|500|502|503|504)\b|INTERNAL|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|socket hang up/i;

async function geminiCall(label, fn, { tries = 3, baseMs = 5000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) ? err.message : String(err);
      const transient = GEMINI_TRANSIENT.test(msg);
      if (!transient || attempt === tries) {
        err.message = `Gemini ${label} failed${transient ? ` after ${tries} attempts` : ''}: ${msg}`;
        throw err;
      }
      const wait = baseMs * Math.pow(2, attempt - 1);
      console.warn(`[gemini] ${label} transient error (attempt ${attempt}/${tries}), retrying in ${wait / 1000}s: ${msg.slice(0, 180)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Videos at or under this size are sent inline with the analysis request
// instead of through the Files API. Gemini caps a request at 20MB total and
// base64 inflates by about a third, so 12MB of video is the safe ceiling.
// This matters because the upload and status-poll calls are where the 500
// INTERNAL errors have been landing: inline removes both of them.
// Sending the video inline removes the Files API upload and status calls.
// Off by default: the Files API path is the one that has been running, and
// the 500s that prompted this turned out to be image posts rather than a
// problem with it. Set GEMINI_INLINE_MAX_BYTES to enable (12582912 = 12MB).
const INLINE_MAX_BYTES = Number(process.env.GEMINI_INLINE_MAX_BYTES || 0);

// ── Steps 3-4: Gemini ─────────────────────────────────────────────────────────
async function analyseVideo(ai, videoPath, hintDuration) {
  const { size } = fs.statSync(videoPath);
  const inline = size <= INLINE_MAX_BYTES;
  let geminiFile = null;
  let videoPart;

  if (inline) {
    // No upload, no status poll: the bytes travel with the request.
    console.log(`[gemini] ${(size / 1048576).toFixed(1)}MB — sending inline (no Files API)`);
    videoPart = {
      inlineData: { mimeType: 'video/mp4', data: fs.readFileSync(videoPath).toString('base64') },
    };
  } else {
    console.log(`[gemini] ${(size / 1048576).toFixed(1)}MB — too large for inline, using Files API`);
    geminiFile = await geminiCall('file upload',
      () => ai.files.upload({ file: videoPath, mimeType: 'video/mp4' }));
    let state = await geminiCall('file status', () => ai.files.get({ name: geminiFile.name }));
    const deadline = Date.now() + 5 * 60 * 1000;
    while (state.state === 'PROCESSING') {
      if (Date.now() > deadline) throw new Error('Gemini processing timed out after 5 minutes.');
      await new Promise(r => setTimeout(r, 3000));
      state = await geminiCall('file status', () => ai.files.get({ name: geminiFile.name }));
    }
    if (state.state === 'FAILED') {
      // Gemini returns a reason on the file object. Without it every failure
      // reads the same in the notification, so a transient backend wobble is
      // indistinguishable from an unsupported codec.
      const e = state.error || {};
      const why = e.message || e.reason || (Object.keys(e).length ? JSON.stringify(e) : 'no reason given');
      throw new Error(`Gemini processing failed: ${why}`);
    }
    videoPart = { fileData: { fileUri: geminiFile.uri, mimeType: 'video/mp4' } };
  }

  if (MEDIA_RESOLUTION) {
    videoPart.videoMetadata = { mediaResolution: `MEDIA_RESOLUTION_${MEDIA_RESOLUTION.toUpperCase()}` };
  }

  try {
    const result = await geminiCall('analysis', () => ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [
        videoPart,
        { text: buildPrompt(hintDuration) },
      ]}],
      // A 90s video at 2s granularity is ~45 timeline entries plus the four
      // quartile segments, and thinking tokens count toward this ceiling.
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: 16000,
        ...(THINKING_BUDGET !== null && Number.isFinite(THINKING_BUDGET)
          ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } }
          : {}),
      },
    }));
    // Log real token usage. Thinking tokens bill at output rates and are the
    // hardest part of the cost to predict, so measure rather than estimate.
    const u = result.usageMetadata || {};
    const inTok = u.promptTokenCount || 0;
    const outTok = u.candidatesTokenCount || 0;
    const think = u.thoughtsTokenCount || 0;
    const IN_RATE = Number(process.env.GEMINI_IN_RATE || 0.75) / 1e6;
    const OUT_RATE = Number(process.env.GEMINI_OUT_RATE || 3.75) / 1e6;
    const usage = {
      model: GEMINI_MODEL,
      input_tokens: inTok,
      output_tokens: outTok,
      thinking_tokens: think,
      total_tokens: u.totalTokenCount || (inTok + outTok + think),
      // Thinking tokens bill at output rates.
      cost_usd: Number((inTok * IN_RATE + (outTok + think) * OUT_RATE).toFixed(6)),
    };
    if (inTok || outTok) {
      console.log(`[gemini] model=${usage.model} in=${inTok} out=${outTok} thinking=${think} ` +
                  `total=${usage.total_tokens} cost=$${usage.cost_usd.toFixed(4)}`);
    }

    const parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    // Non-enumerable so it rides along for callers that want it without ever
    // showing up in JSON.stringify of the analysis itself.
    Object.defineProperty(parsed, '_usage', { value: usage, enumerable: false });
    return parsed;
  } finally {
    // Only the Files API path leaves anything to clean up.
    if (geminiFile) {
      try { await ai.files.delete({ name: geminiFile.name }); } catch (e) {}
    }
  }
}

/**
 * Models drift on shape: t may come back as "0", "0s" or "00:04", and windows
 * can arrive out of order or duplicated. Normalise to { t: <number>, d: <string> }
 * sorted and de-duplicated, so anything reading this can trust the grid.
 */
function normaliseTimeline(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];

  for (const item of raw) {
    if (!item) continue;
    const d = String(item.d || item.desc || item.description || '').trim();
    if (!d) continue;

    let t = item.t !== undefined ? item.t : (item.start !== undefined ? item.start : item.time);
    if (typeof t === 'string') {
      const mmss = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
      t = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : parseFloat(t.replace(/[^\d.]/g, ''));
    }
    t = Number(t);
    if (!Number.isFinite(t) || t < 0) continue;

    t = Math.round(t * 10) / 10;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ t, d });
  }

  out.sort((x, y) => x.t - y.t);
  // No hard slice: stepFor already bounds the count, and truncating here
  // would silently drop the end of a video the model described correctly.
  return out;
}

// ── The job ───────────────────────────────────────────────────────────────────
function makeProcessor(ai) {
  return async function processJob(job) {
    const d = job.data;
    const { mediaUrl, platform } = d;
    // let, not const: a collision with a different creative reassigns this below.
    let creativeId = d.creativeId;
    let videoPath = null;

    try {
      await job.updateProgress({ step: 'resolving', pct: 10 });
      const meta = await resolveMediaUrl(mediaUrl);

      await job.updateProgress({ step: 'downloading', pct: 30 });
      videoPath = path.join(os.tmpdir(), `creative_${job.id}.mp4`);
      await streamToFile(meta.download_url, videoPath);

      await job.updateProgress({ step: 'analysing', pct: 60 });
      const a = await analyseVideo(ai, videoPath, typeof meta.duration === 'number' ? meta.duration : null);

      // A partial analysis is not worth storing — the dashboard labels
      // segments by position, so a missing one mislabels the rest.
      if (!a.hook || !String(a.hook).trim()) {
        throw new Error('Analysis incomplete — no hook returned.');
      }

      const timeline = normaliseTimeline(a.timeline);
      if (!timeline.length) {
        throw new Error('Analysis incomplete — no timeline returned.');
      }

      // Models save output tokens by grouping windows ("0:14-0:30: she keeps
      // talking"). That returns valid JSON with a sparse timeline, which would
      // otherwise be stored as if complete. Check coverage against duration
      // and fail the job so the retry gets another go.
      const durForCheck = (typeof meta.duration === 'number' && meta.duration > 0)
        ? meta.duration
        : (Number.isFinite(parseFloat(a.duration)) ? parseFloat(a.duration) : null);

      if (durForCheck) {
        const step = stepFor(durForCheck);
        const expected = Math.ceil(durForCheck / step);
        // 70%: allows a window or two of slack at the tail without accepting
        // a timeline that has clearly been collapsed.
        if (timeline.length < Math.floor(expected * 0.7)) {
          throw new Error(
            `Timeline too sparse — got ${timeline.length} windows for ${durForCheck.toFixed(0)}s, ` +
            `expected about ${expected} at ${step}s. The model grouped intervals.`
          );
        }
        const lastCovered = timeline[timeline.length - 1].t + step;
        if (lastCovered < durForCheck * 0.8) {
          throw new Error(
            `Timeline stops at ${lastCovered.toFixed(0)}s of ${durForCheck.toFixed(0)}s — incomplete coverage.`
          );
        }
      }

      // Gemini estimates duration by watching, and that drives the retention
      // denominator. Anything outside 1-600s is a bad read, not a long video.
      // The API's own duration wins when it gives one: TikTok does, Instagram
      // returns null.
      const apiDur = typeof meta.duration === 'number' ? meta.duration : null;
      const aiDur = parseFloat(a.duration);
      const guess = apiDur !== null ? apiDur : (Number.isFinite(aiDur) ? aiDur : null);
      const safeDur = guess !== null && guess >= 1 && guess <= 600 ? guess : null;

      // Insert the complete row only now. Nothing reaches the database
      // without descriptions, so a failed job leaves no half-creative behind.
      await job.updateProgress({ step: 'saving', pct: 90 });
      // The upsert below makes a retry of this same job idempotent, which is
      // what it is for. But if the id has been taken by a *different*
      // creative since this job was queued, that same upsert would overwrite
      // someone else's row. Claim a fresh id in that case rather than
      // destroying it.
      const { rows: held } = await query(
        'select ig_link, fb_link, tt_link from creatives where creative_id = $1',
        [creativeId]);
      if (held.length) {
        const mine = [d.ig, d.fb, d.tt].filter(Boolean);
        const theirs = [held[0].ig_link, held[0].fb_link, held[0].tt_link].filter(Boolean);
        const sameCreative = mine.some(l => theirs.includes(l));
        if (!sameCreative) {
          const suffix = Date.now().toString(36).slice(-6).toUpperCase();
          const taken = creativeId;
          creativeId = `${creativeId}_${suffix}`;
          console.warn(`[worker] ${taken} was claimed by another creative — using ${creativeId}`);
        }
      }

      await query(
        `insert into creatives
           (creative_id, brand_id, date, campaign, type, is_repurposed,
            original_creative_id, content_type, ig_link, fb_link, tt_link,
            content_hook, duration_s, segments,
            format, product_role, format_note, creator_profile, creator_id)
         values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7,'Video',
                 $8,$9,$10,$11,$12,$13,
                 $14,$15,$16,$17,$18)
         on conflict (creative_id) do update set
           content_hook = excluded.content_hook,
           duration_s = coalesce(excluded.duration_s, creatives.duration_s),
           segments = excluded.segments,
           format = excluded.format,
           product_role = excluded.product_role,
           format_note = excluded.format_note`,
        [creativeId, d.brand, d.date, d.campaign, d.type, d.repurposed,
         d.originalId, d.ig, d.fb, d.tt,
         a.hook, safeDur, JSON.stringify(timeline),
         a.format || null, a.product_role || null, a.format_note || null,
         d.creator || null, d.creatorId || null]
      );

      console.log(`[worker] ${creativeId}: analysed ${platform} (${safeDur === null ? '?' : safeDur}s, ${timeline.length} segments) and added`);

      notifySuccess({
        creativeId, brand: d.brand, campaign: d.campaign, platform,
        duration: safeDur, hook: a.hook,
        addedBy: d.addedBy, addedByName: d.addedByName, addedByEmail: d.addedByEmail,
      }).catch(e => console.error('[worker] notify:', e.message));
      return {
        status: 'completed', creativeId, platform,
        hook: a.hook || null,
        timelineCount: timeline.length,
        duration: safeDur,
        caption: meta.caption || '',
        thumbnail: meta.thumbnail_url || '',
      };
    } finally {
      // Temp file only — nothing is served from disk, so there is no reason to
      // keep it, and Render's filesystem is ephemeral anyway.
      if (videoPath && fs.existsSync(videoPath)) {
        try { fs.unlinkSync(videoPath); } catch (e) {}
      }
    }
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startWorker(ai) {
  if (!process.env.REDIS_URL) {
    console.log('[worker] REDIS_URL not set — worker not started.');
    return null;
  }
  if (!ai) {
    console.warn('[worker] No Gemini client available — jobs will fail at the analysis step.');
  }

  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', e => console.error('[worker] redis:', e.message));

  const worker = new Worker('creative-downloads', makeProcessor(ai), {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
    // A deploy kills the process mid-job. Without these, BullMQ treats the
    // silence as a failed attempt and burns a retry on a job that was never
    // actually broken. lockDuration must exceed the longest analysis; a
    // 5-minute Gemini wait plus download and upload fits inside 10.
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 30 * 1000,
    maxStalledCount: 3,
  });

  // A job whose worker vanished is not a real failure: it never got to run.
  worker.on('stalled', (jobId) => {
    console.warn(`[worker] job ${jobId} stalled (worker restarted mid-job) — requeueing`);
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts && job.opts.attempts ? job.opts.attempts : 1;
    console.error(`[worker] job ${job.id} failed (attempt ${job.attemptsMade}/${attempts}): ${err.message}`);
    // Only notify once the retries are exhausted — otherwise a transient
    // rate-limit sends three emails for one creative.
    if (job.attemptsMade >= attempts) {
      notifyFailure({
        creativeId: job.data.creativeId, brand: job.data.brand,
        campaign: job.data.campaign, link: job.data.mediaUrl,
        error: err.message, attempts,
        addedByName: job.data.addedByName, addedByEmail: job.data.addedByEmail,
      }).catch(e => console.error('[worker] notify:', e.message));
    }
  });
  worker.on('completed', job => console.log(`[worker] job ${job.id} completed`));

  attachShutdown(worker, connection);

  console.log('[worker] active and listening for background download tasks');
  return worker;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Render sends SIGTERM on every deploy and waits ~30s before SIGKILL. Without
// a handler the process dies mid-job, the analysis is lost, and the attempt is
// counted against the job's retries. worker.close() stops taking new work and
// waits for what is already running, so a deploy during a batch costs a short
// wait instead of failed creatives.
function attachShutdown(worker, connection) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[worker] ${signal} received — finishing in-flight jobs, no new ones accepted`);
    try {
      await worker.close();            // waits for active jobs
      console.log('[worker] all in-flight jobs finished');
    } catch (e) {
      console.error('[worker] shutdown error:', e.message);
    }
    try { await connection.quit(); } catch (e) { /* redis already gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { startWorker, buildPrompt, normaliseTimeline, RESPONSE_SCHEMA, analyseVideo };

// Standalone mode: node worker.js
if (require.main === module) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;
  startWorker(ai);
}

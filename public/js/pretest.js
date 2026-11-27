/**
 * pretest.js — CampaignLens Pre-testing and the Pre-test Score.
 *
 *   Pre-tests page   list of the brand's pre-tests, new pre-test form, report
 *   Creative cards   a Pre-test Score badge, and a section in the detail
 *   Download PDF     a print layout of any report, saved through the browser
 *
 * The video goes from this browser to private temporary storage (or, on a
 * server without it, straight to the scoring service). Campaign Lens hands
 * out a one-file upload link and the server does the rest: the Pre-test
 * Score, plus Sound and Funnel fit. Reports are summaries Campaign Lens keeps
 * (numbers only); heatmaps are fetched when a report is opened, because
 * their links expire after an hour.
 *
 * Users never see the scoring vendor's name anywhere in this file.
 */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // An argument inside an inline handler: a JS string first, then escaped
  // for the attribute, so a quote in the value cannot end the string.
  const jsq = s => esc(JSON.stringify(String(s == null ? '' : s)));

  // Score ratings -> one of four looks.
  const TONE = {
    positive: 'pos', veryPositive: 'pos',
    medium: 'warn',
    negative: 'neg', veryNegative: 'neg', negativeTooLow: 'neg', negativeTooHigh: 'neg',
    notAvailable: 'na',
  };
  const tone = r => TONE[r] || 'na';
  const TONE_WORD = { pos: 'Strong', warn: 'Mixed', neg: 'Weak', na: 'Not scored' };
  // Sound and Funnel fit use one colour rule: green 70+, amber 50 to 69, red below 50.
  const RAG_TONE = { green: 'pos', amber: 'warn', red: 'neg' };
  const ragTone = r => RAG_TONE[r] || 'na';
  const ragOf = n => (n == null ? null : n >= 70 ? 'green' : n >= 50 ? 'amber' : 'red');

  const STATUS = {
    uploading: 'Uploading', queued: 'Queued', analysing: 'Analysing', succeeded: 'Ready',
    failed: 'Failed', expired: 'Report deleted', skipped: 'Not scored',
  };
  const RUNNING = new Set(['uploading', 'queued', 'analysing']);
  const PLACEMENT = {
    tiktok: 'TikTok', instagram_reel: 'Instagram Reel', instagram_story: 'Instagram Story',
    instagram_feed: 'Instagram Feed', facebook_reel: 'Facebook Reel', facebook_story: 'Facebook Story',
    facebook_feed: 'Facebook Feed', youtube: 'YouTube', youtube_shorts: 'YouTube Shorts',
  };
  const isYouTube = c => c === 'youtube' || c === 'youtube_shorts';
  const MAX_BYTES = 500 * 1024 * 1024;
  const REFRESH_MS = 20000;

  const state = { data: null, loading: false, timer: null, page: null, file: null, busy: false, reportId: null };

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', '
      + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function timeLeft(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'Deleting soon';
    const h = Math.floor(ms / 3600000);
    if (h >= 48) return `${Math.floor(h / 24)} days left`;
    if (h >= 1) return `${h} h left`;
    return `${Math.max(1, Math.round(ms / 60000))} min left`;
  }

  function size(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  // The scoring service's own pass mark, in words.
  function passMark(n) {
    if (!n || !n.type) return '';
    if (n.type === 'traffic' && n.high != null) {
      return n.highPositive === false
        ? `Green below ${n.low}, red above ${n.high}` : `Green above ${n.high}, red below ${n.low}`;
    }
    if (n.type === 'categorical' && n.high != null) return `Green above ${n.high}, red below ${n.low}`;
    if (n.type === 'invertedU' && n.tooLow != null) return `Best between ${n.tooLow} and ${n.tooHigh}`;
    if ((n.type === 'binary' || n.type === 'trafficBinary') && n.threshold != null) {
      return n.threshold >= 1 ? 'Pass or fail' : `Pass at ${n.threshold} or more`;
    }
    return '';
  }

  // ── The report (shared by pre-tests and creatives) ─────────────────────────
  function bar(label, value, rating, opts = {}) {
    const t = tone(rating);
    const pct = value == null ? 0 : Math.max(2, Math.min(100, value));
    return `<div class="bs-bar${opts.current ? ' is-current' : ''}">
      <span class="bs-bar-label">${esc(label)}${opts.note ? ` <span class="bs-bar-note">${esc(opts.note)}</span>` : ''}</span>
      <span class="bs-bar-track"><span class="bs-bar-fill grow-x t-${t}" style="--i:${opts.i || 0};width:${pct}%"></span></span>
      <span class="bs-bar-val">${value == null ? '<span class="bs-quiet">N/A</span>' : Math.round(value)}</span>
    </div>`;
  }

  const fixRow = k => `<li class="bs-fix t-${tone(k.rating)}">
      <div class="bs-fix-head"><span class="bs-dot t-${tone(k.rating)}"></span>
        <span class="bs-fix-name">${esc(k.name)}</span>
        <span class="bs-fix-val">${esc(k.display)}</span></div>
      ${k.tip ? `<div class="bs-fix-tip">${esc(k.tip)}</div>` : ''}
      ${passMark(k.norm) ? `<div class="bs-fix-mark">${esc(passMark(k.norm))}</div>` : ''}
    </li>`;

  // The pieces of a scored summary, built once and laid out by either report.
  function summaryParts(s, opts = {}) {
    const here = s.channel;
    const placements = Object.entries(s.placements || {})
      .filter(([, p]) => p.total != null)
      .sort((a, b) => b[1].total - a[1].total);
    const best = placements[0];
    const worst = placements[placements.length - 1];

    const fixes = (s.kpis || []).filter(k => ['neg', 'warn'].includes(tone(k.rating)))
      .sort((a, b) => (tone(a.rating) === 'neg' ? 0 : 1) - (tone(b.rating) === 'neg' ? 0 : 1)
        || (b.weighted ? 1 : 0) - (a.weighted ? 1 : 0));
    const works = (s.kpis || []).filter(k => tone(k.rating) === 'pos');

    const strategic = (s.categories || []).find(c => c.name === 'Strategic Fit');
    const noMessage = strategic && strategic.score == null;

    const catBars = (s.categories || []).map((c, i) => bar(c.name, c.score, c.rating, {
      note: c.unweighted ? 'not in total' : '', i,
    })).join('');

    const placeBars = placements.map(([p, v], i) => bar(PLACEMENT[p] || p, v.total, v.rating, {
      current: p === here, note: p === here ? 'tested for' : '', i,
    })).join('');

    const groups = {};
    for (const k of s.kpis || []) (groups[k.category] = groups[k.category] || []).push(k);
    const allRows = Object.entries(groups).map(([cat, ks]) => `
      <tr class="bs-cat-row"><th colspan="3">${esc(cat)}</th></tr>
      ${ks.map(k => `<tr><td><span class="bs-dot t-${tone(k.rating)}"></span>${esc(k.name)}</td>
        <td class="bs-num">${esc(k.display)}</td><td class="bs-quiet">${esc(passMark(k.norm))}</td></tr>`).join('')}`).join('');

    const messageHint = noMessage ? `<div class="bs-sec-hint">${opts.kind === 'pretest'
      ? 'Strategic Fit needs a key message. Add one when you run the next pre-test.'
      : 'Strategic Fit needs a key message, which added creatives do not have.'}</div>` : '';
    const media = `<section class="bs-sec bs-media" data-job="${esc(opts.jobId || '')}" data-video="${opts.kind === 'pretest' ? '1' : ''}">
        <h4 class="bs-h">Where attention goes</h4>
        <div class="bs-media-body"><div class="bs-media-sk" aria-busy="true"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></div>
      </section>`;
    const all = `<details class="bs-all"><summary>All ${(s.kpis || []).length} checks and their pass marks</summary>
        <table class="bs-table"><tbody>${allRows}</tbody></table></details>`;
    return { here, best, worst, fixes, works, catBars, placeBars, messageHint, media, all };
  }

  function reportHTML(s, opts = {}) {
    if (!s || !s.total) return '<div class="organic-empty">No report.</div>';
    const t = tone(s.total.rating);
    const { here, best, worst, fixes, works, catBars, placeBars, messageHint, media, all } = summaryParts(s, opts);
    const fixRows = fixes.map(fixRow).join('');

    return `<div class="bs-report">
      <div class="bs-hero">
        <div class="bs-total t-${t}">
          <svg class="bs-ring" viewBox="0 0 96 96" aria-hidden="true">
            <circle class="bs-ring-bg" cx="48" cy="48" r="42"/>
            <circle class="bs-ring-fg" cx="48" cy="48" r="42"
              style="stroke-dashoffset:${(263.9 * (1 - Math.max(0, Math.min(100, s.total.score || 0)) / 100)).toFixed(1)}"/>
          </svg>
          <div class="bs-total-num">${s.total.score == null ? '–' : Math.round(s.total.score)}</div>
          <div class="bs-total-sub">${TONE_WORD[t]}</div>
        </div>
        <div class="bs-hero-text">
          <div class="bs-hero-title">Pre-test Score for ${esc(PLACEMENT[here] || here)}, out of 100</div>
          ${best && worst && best[0] !== worst[0] ? `<div class="bs-hero-line">Best placement is ${esc(PLACEMENT[best[0]] || best[0])} (${Math.round(best[1].total)}). Weakest is ${esc(PLACEMENT[worst[0]] || worst[0])} (${Math.round(worst[1].total)}).</div>` : ''}
          <div class="bs-hero-line">${fixes.length ? `${fixes.length} check${fixes.length === 1 ? '' : 's'} to improve, ${works.length} working well.` : `All ${works.length} scored checks are working well.`}</div>
        </div>
      </div>

      <div class="bs-cols">
        <section class="bs-sec"><h4 class="bs-h">By category</h4>${catBars}${messageHint}</section>
        <section class="bs-sec"><h4 class="bs-h">By placement</h4>${placeBars}</section>
      </div>

      ${fixes.length ? `<section class="bs-sec"><h4 class="bs-h">What to improve</h4><ul class="bs-fixes">${fixRows}</ul></section>` : ''}

      ${works.length ? `<section class="bs-sec"><h4 class="bs-h">What works</h4>
        <div class="bs-chips">${works.map(k => `<span class="bs-chip">${esc(k.name)}</span>`).join('')}</div></section>` : ''}

      ${opts.lens ? lensHTML(opts.lens, { kind: opts.kind }) : ''}

      ${media}

      ${all}

    </div>`;
  }

  // ── The pre-test report, judged on its objective ───────────────────────────
  // One final report. The headline is the score for the objective chosen at
  // upload (or, on a pre-test with none, for what the video reads as). The
  // other two objectives sit beside it. Each is the Pre-test Score with its
  // categories weighted for that objective, so the overall score appears only
  // as their base, never as a second verdict.
  //   p.lensReport  Sound and the three objective scores (always present here)
  //   p.summary     the scored checks, or nothing when scoring did not finish
  function objectiveReportHTML(p, opts = {}) {
    const l = p.lensReport, f = l.funnel, s = p.summary && p.summary.total ? p.summary : null;
    const focus = f.focus || f.intent;
    const st = f.stages[focus] || {};
    const t = ragTone(st.rag);
    const low = String(focus).toLowerCase();
    const others = STAGE_ORDER.filter(k => k !== focus && f.stages[k] && f.stages[k].score != null);
    const parts = s ? summaryParts(s, { jobId: p.id, kind: 'pretest' }) : null;

    // Scored checks to improve, split by whether they count toward this objective.
    const mine = new Set(st.kpis || []);
    const fixesIn = parts ? parts.fixes.filter(k => mine.has(k.id)) : [];
    const fixesOut = parts ? parts.fixes.filter(k => !mine.has(k.id)) : [];

    const made = (st.parts || []).length ? `<details class="bs-all lens-made"><summary>How the ${esc(low)} score is worked out</summary>
        <table class="bs-table"><tbody>
          ${st.parts.map(c => `<tr><td><span class="bs-dot t-${ragTone(ragOf(c.score))}"></span>${esc(c.name)}</td>
            <td>${esc(c.score)}</td><td class="bs-quiet">${esc(c.share)}% of the score</td></tr>`).join('')}
        </tbody></table>
        <div class="bs-sec-hint">The ${esc(low)} score is the Pre-test Score${f.base != null ? ` (${esc(f.base)})` : ''} with its categories counted for ${esc(low)}: the same checks and pass marks, weighted differently for each objective.
          ${f.soundShare ? `Sound counts for ${esc(f.soundShare)}%.` : ''}${focus === 'Conversion' ? ' Conversion also counts the ask (offer, call to action, urgency), which the Pre-test Score has no checks for.' : ''}</div>
      </details>` : '';


    return `<div class="bs-report">
      ${!s ? `<div class="bs-banner">The scored checks did not finish${p.error ? ` (${esc(String(p.error).replace(/\.$/, ''))})` : ''}. The objective scores are the Pre-test Score weighted for each objective, so there are none without it. Run the pre-test again for the full report.</div>` : ''}
      <div class="bs-hero">
        <div class="bs-total t-${t}">
          <svg class="bs-ring" viewBox="0 0 96 96" aria-hidden="true">
            <circle class="bs-ring-bg" cx="48" cy="48" r="42"/>
            <circle class="bs-ring-fg" cx="48" cy="48" r="42"
              style="stroke-dashoffset:${(263.9 * (1 - Math.max(0, Math.min(100, st.score || 0)) / 100)).toFixed(1)}"/>
          </svg>
          <div class="bs-total-num">${st.score == null ? '–' : esc(st.score)}</div>
          <div class="bs-total-sub">${esc(st.word || '')}</div>
        </div>
        <div class="bs-hero-text">
          <div class="bs-hero-title">${esc(focus)} score, out of 100</div>
          ${f.base != null ? `<div class="bs-hero-line bs-quiet">Pre-test Score ${esc(f.base)}, weighted for ${esc(low)}</div>` : ''}
          <div class="bs-hero-line">${esc(f.verdict)}</div>
          ${!f.objective && opts.kind !== 'creative' ? `<div class="bs-hero-line bs-quiet">No objective was set for this pre-test, so it is scored for what the video reads as.</div>` : ''}
          ${others.length ? `<div class="bs-hero-others">${others.map(k => `<span class="bs-hero-other">${esc(k)} <b class="t-${ragTone(f.stages[k].rag)}">${esc(f.stages[k].score)}</b></span>`).join('')}</div>` : ''}
        </div>
      </div>

      ${lensHTML(l, { kind: 'pretest', inReport: true, part: 'funnel' })}

      ${made}

      ${lensHTML(l, { kind: 'pretest', inReport: true, part: 'sound' })}

      ${fixesIn.length ? `<section class="bs-sec"><h4 class="bs-h">What to improve for ${esc(low)}</h4>
        <ul class="bs-fixes">${fixesIn.map(fixRow).join('')}</ul></section>` : ''}
      ${fixesOut.length ? `<section class="bs-sec"><h4 class="bs-h">Other checks to improve</h4>
        <div class="bs-sec-hint" style="margin:-4px 0 10px">Not part of the ${esc(low)} score. Worth fixing after the ones above.</div>
        <ul class="bs-fixes">${fixesOut.map(fixRow).join('')}</ul></section>` : ''}

      ${parts && parts.works.length ? `<section class="bs-sec"><h4 class="bs-h">What works</h4>
        <div class="bs-chips">${parts.works.map(k => `<span class="bs-chip">${esc(k.name)}</span>`).join('')}</div></section>` : ''}

      ${parts ? parts.media : ''}

      ${parts ? parts.all : ''}

    </div>`;
  }

  // Shown instead of a report until every part of it is in.
  function waitingHTML(p) {
    const finishing = p.status === 'succeeded';
    return `<div class="bs-wait" role="status">
      <span class="bs-status is-running"><i></i>${finishing ? 'Finishing the report' : 'Scoring'}</span>
      <div class="bs-wait-title">${finishing ? 'Almost there' : 'About 5 minutes'}</div>
      <p>The full report appears here in one go when it is ready${p.objective ? `, scored for ${esc(p.objective.toLowerCase())}` : ''}. Nothing is shown before then, so the numbers you see are final.</p>
    </div>`;
  }

  // Returns the same promise to every caller, so the PDF can wait for
  // heatmaps that are still on their way.
  function loadMedia(root) {
    const sec = root && root.querySelector('.bs-media');
    if (!sec || !sec.dataset.job) return Promise.resolve();
    if (!sec._loading) sec._loading = fetchMedia(sec);
    return sec._loading;
  }

  async function fetchMedia(sec) {
    sec.dataset.loaded = '1';
    const body = sec.querySelector('.bs-media-body');
    try {
      const m = await api(`/api/pretest-scores/jobs/${encodeURIComponent(sec.dataset.job)}/media`);
      if (m.gone || (!m.montage && !(m.stills || []).length && !m.heatmovie)) {
        body.innerHTML = '<div class="bs-quiet">Heatmaps are no longer available for this test. The scores above are kept.</div>';
        return;
      }
      body.innerHTML = `
        ${m.heatmovie && sec.dataset.video ? `<video class="bs-video" src="${esc(m.heatmovie)}" controls preload="none" playsinline></video>
          <div class="bs-cap">Attention heatmap over the whole video. Red is where most people look.</div>` : ''}
        ${(m.stills || []).length ? `<div class="bs-stills">${m.stills.map((x, i) => `
          <figure><img data-k="still${i}" src="${esc(x.url)}" alt="${esc(x.label)} heatmap" loading="lazy"
            onerror="this.closest('figure').remove()"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>` : ''}
        ${m.montage ? `<figure class="bs-montage"><img data-k="montage" src="${esc(m.montage)}" alt="Scenes detected in the video" loading="lazy"
            onerror="this.closest('figure').remove()"><figcaption>Every scene detected in the video</figcaption></figure>` : ''}`;
    } catch (e) {
      body.innerHTML = `<div class="bs-quiet">Could not load heatmaps: ${esc(e.message)}</div>`;
      delete sec.dataset.loaded;
      sec._loading = null;
    }
  }


  // ── Sound and Funnel fit (shared by pre-tests and creatives) ───────────────
  const STAGE_ORDER = ['Awareness', 'Consideration', 'Conversion'];

  function loudChart(ld) {
    const pts = (ld && ld.series) || [];
    if (pts.length < 3) return '';
    const W = 600, H = 120, top = -5, bot = -40;
    const dur = Math.max(1, pts[pts.length - 1][0]);
    const x = t => (t / dur) * W;
    const y = v => ((top - Math.max(bot, Math.min(top, v))) / (top - bot)) * H;
    const line = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ticks = [];
    const step = dur <= 15 ? 3 : dur <= 40 ? 5 : dur <= 90 ? 10 : 30;
    for (let t = 0; t <= dur; t += step) ticks.push(`<text x="${x(t).toFixed(1)}" y="${H + 14}" text-anchor="middle">${t}s</text>`);
    return `<figure class="lens-loud">
      <svg viewBox="0 -4 ${W} ${H + 22}" preserveAspectRatio="none" role="img" aria-label="Loudness over the video">
        <rect class="lens-loud-band" x="0" y="${y(-12).toFixed(1)}" width="${W}" height="${(y(-16) - y(-12)).toFixed(1)}"/>
        <polyline class="lens-loud-line" points="${line}"/>
        ${ticks.join('')}
      </svg>
      <figcaption>Loudness through the video. The shaded band is the platform level, -16 to -12 LUFS.</figcaption>
    </figure>`;
  }

  function checkRow(c) {
    const t = c.result === 'pass' ? 'pos' : c.result === 'partial' ? 'warn' : c.result === 'fail' ? 'neg' : 'na';
    return `<li class="bs-fix t-${t}">
      <div class="bs-fix-head"><span class="bs-dot t-${t}"></span>
        <span class="bs-fix-name">${esc(c.name)}</span>
        <span class="bs-fix-val">${esc(c.value)}</span></div>
      ${c.fix ? `<div class="bs-fix-tip">${esc(c.fix)}</div>` : ''}
      ${c.target ? `<div class="bs-fix-mark">Aim for ${esc(c.target)}</div>` : ''}
    </li>`;
  }

  function lensHTML(l, opts = {}) {
    if (!l || l.status === 'none') return '';
    if (l.status === 'running') {
      return `<section class="bs-sec lens-sec"><h4 class="bs-h">Funnel fit and sound</h4>
        <div class="bs-quiet">Being worked out. Usually ready within a few minutes.</div></section>`;
    }
    if (l.status === 'failed') {
      return `<section class="bs-sec lens-sec"><h4 class="bs-h">Funnel fit and sound</h4>
        <div class="bs-quiet">Could not be worked out for this video${l.error ? `: ${esc(l.error)}` : '.'}</div></section>`;
    }
    const f = l.funnel, s = l.sound;
    // opts.inReport: inside the pre-test report, whose headline already
    // carries the verdict. opts.part: only 'funnel' or only 'sound'.
    const want = part => !opts.part || opts.part === part;
    let out = '';
    if (f && f.stages && want('funnel')) {
      const focus = f.focus || f.intent;
      const cards = STAGE_ORDER.filter(k => f.stages[k]).map((k, i) => {
        const st = f.stages[k];
        const t = ragTone(st.rag);
        const built = k === focus;
        return `<div class="lens-stage${built ? ' is-built' : ''}">
          <div class="lens-stage-head"><span class="lens-stage-name">${esc(k)}</span>
            ${built ? `<span class="lens-tag">${f.objective ? 'Objective' : 'Built for'}</span>` : ''}
            <span class="lens-stage-num t-${t}">${st.score == null ? '–' : st.score}</span></div>
          <span class="bs-bar-track"><span class="bs-bar-fill grow-x t-${t}" style="--i:${i};width:${st.score == null ? 0 : Math.max(2, st.score)}%"></span></span>
          <div class="lens-stage-word t-${t}">${esc(st.word)}</div>
          ${(st.helps || []).length ? `<div class="lens-k">Helps</div><ul class="lens-list">${st.helps.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
          ${(st.gaps || []).length ? `<div class="lens-k">To fit better</div><ul class="lens-list is-gap">${st.gaps.map(g => `<li>${esc(g.fix || g.name)}</li>`).join('')}</ul>` : ''}
        </div>`;
      }).join('');
      const found = [
        (f.reasons || []).length ? `<span class="lens-found"><b>Reasons to buy:</b> ${f.reasons.map(esc).join(', ')}</span>` : '',
        f.offer ? `<span class="lens-found"><b>Offer:</b> ${esc(f.offer)}</span>` : '',
        f.ctaText ? `<span class="lens-found"><b>Call to action:</b> ${esc(f.ctaText)}</span>` : '',
      ].filter(Boolean).join('');
      out += `<section class="bs-sec lens-sec"><h4 class="bs-h">${opts.inReport ? 'All three objectives' : 'Funnel fit'}</h4>
        ${opts.inReport ? '' : `<p class="lens-verdict">${esc(f.verdict)}</p>`}
        <div class="lens-stages">${cards}</div>
        ${found ? `<div class="lens-founds">${found}</div>` : ''}
        <div class="bs-sec-hint">${f.basis === 'full'
          ? `Each score is the Pre-test Score weighted for that objective.${f.soundShare ? ` Sound counts for ${esc(f.soundShare)}%.` : ''}`
          : opts.kind === 'pretest' ? 'The scores are worked out from the Pre-test Score, which is not in.'
          : 'Scores need the Pre-test Score, which this creative does not have. What it is built for comes from the video analysis.'}
          Green 70 and above, amber 50 to 69, red below 50.</div>
      </section>`;
    }
    if (s && want('sound')) {
      const t = ragTone(s.rag);
      out += `<section class="bs-sec lens-sec"><h4 class="bs-h">Sound
          ${s.score != null ? `<span class="bs-score t-${t} lens-h-score">${s.score}</span><span class="lens-h-word t-${t}">${esc(s.word)}</span>` : ''}</h4>
        ${s.note ? `<div class="bs-quiet">${esc(s.note)}</div>` : ''}
        ${(s.checks || []).length ? `<ul class="bs-fixes">${s.checks.map(checkRow).join('')}</ul>` : ''}
        ${loudChart(s.loudness)}
      </section>`;
    }
    return out;
  }

  // A tracked creative's own section in the panel.
  // Only for creatives with no pre-test: the Pre-test section carries the
  // objective scores and Sound for the rest.
  function lensSection(d) {
    if (!d || (!d.lensIntent && d.lensSound == null)) return '';
    if (d.bsStatus && d.bsStatus !== 'skipped') return '';
    const head = d.lensIntent
      ? `Built for ${d.lensIntent.toLowerCase()}${d.lensFit != null ? ` · fit ${d.lensFit}` : ''}${d.lensSound != null ? ` · sound ${d.lensSound}` : ''}`
      : `Sound ${d.lensSound}`;
    return `<details class="org-details bs-detail lens-detail" style="margin-top:12px;" ontoggle="PreTest.loadLens(this, ${jsq(d.id)})">
      <summary class="org-summary">Funnel fit and sound <span style="color:var(--c-muted);font-size:10px;">${esc(head)} ▼</span></summary>
      <div class="org-content">${lineSkeleton(3)}</div>
    </details>`;
  }

  const lensCache = new Map();
  async function loadLens(el, id) {
    if (!el.open) return;
    const box = el.querySelector('.org-content');
    if (!box || box.dataset.loadedFor === id) return;
    try {
      let r = lensCache.get(id);
      if (!r) {
        r = await api(`/api/lens/creative/${encodeURIComponent(id)}`);
        if (r.status === 'succeeded') lensCache.set(id, r);
      }
      box.innerHTML = r.status === 'none'
        ? '<div class="organic-empty">Not worked out for this creative yet.</div>'
        : `<div class="bs-report">${lensHTML(r, { kind: 'creative' })}</div>`;
      box.dataset.loadedFor = id;
    } catch (e) {
      box.innerHTML = `<div class="organic-empty">Could not load the funnel fit and sound: ${esc(e.message)}</div>`;
    }
  }

  // The small chip on a card: what it is built for, coloured by how well it fits.
  function lensChip(d) {
    if (!d || !d.lensIntent) return '';
    const t = ragTone(ragOf(d.lensFit));
    return `<span class="bs-badge lens-chip t-${t}" title="Built for ${esc(d.lensIntent.toLowerCase())}${d.lensFit != null ? `, fit ${d.lensFit} of 100` : ''}">${esc(d.lensIntent)}${d.lensFit != null ? ` <b>${d.lensFit}</b>` : ''}</span>`;
  }

  // ── Download PDF ───────────────────────────────────────────────────────────
  // Builds a copy of the report with its own header and footer, draws each
  // section as it looks on screen (colours, bars, heatmaps) and saves an A4
  // PDF straight to the downloads folder. No print dialog. The two libraries
  // are served from this site and load only on the first download. If they
  // cannot load, the browser's print dialog is the fallback.
  const PDF_BTN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14"/></svg>Download PDF';
  const PDF_LIBS = ['/js/vendor/html2canvas-1.4.1.min.js', '/js/vendor/jspdf-2.5.2.umd.min.js'];

  function pdfButton() {
    return `<button type="button" class="modal-btn bs-pdf-btn" data-press onclick="PreTest.downloadPdf(this)">${PDF_BTN}</button>`;
  }

  function pdfMeta(meta) {
    return esc(JSON.stringify(meta));
  }

  function imagesReady(root, ms) {
    const imgs = [...root.querySelectorAll('img')];
    imgs.forEach(i => { i.loading = 'eager'; });
    const each = imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })).filter(Boolean);
    return Promise.race([Promise.all(each), new Promise(r => setTimeout(r, ms))]);
  }

  const scriptLoads = {};
  function loadScript(src) {
    if (!scriptLoads[src]) {
      scriptLoads[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = resolve;
        s.onerror = () => { delete scriptLoads[src]; reject(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptLoads[src];
  }

  // The copy of the report that becomes the PDF (also used by the print fallback).
  async function buildPdfCopy(host, report, meta) {
    let box = document.getElementById('pt-print');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pt-print';
      document.body.appendChild(box);
    }
    const clone = report.cloneNode(true);
    // A PDF cannot play video; the stills carry the heatmap instead.
    clone.querySelectorAll('video, .bs-cap, .bs-pdf-btn').forEach(el => el.remove());
    clone.querySelectorAll('details').forEach(d => { d.open = true; });
    // Heatmaps come through this site, so they can be drawn into the PDF.
    const job = (host.querySelector('.bs-media') || {}).dataset ? host.querySelector('.bs-media').dataset.job : null;
    clone.querySelectorAll('img[data-k]').forEach(img => {
      img.removeAttribute('loading');
      if (job) img.src = `/api/pretest-scores/jobs/${encodeURIComponent(job)}/media/file?k=${encodeURIComponent(img.dataset.k)}`;
    });
    clone.querySelectorAll('.bs-media').forEach(sec => { if (!sec.querySelector('img')) sec.remove(); });
    box.innerHTML = `<header class="pt-head">
        <div class="pt-kicker">CampaignLens Pre-testing report</div>
        <h1 class="pt-title">${esc(meta.title || 'Pre-test')}</h1>
        ${(meta.lines || []).length ? `<div class="pt-meta">${meta.lines.map(esc).join(' · ')}</div>` : ''}
        ${meta.keyMessage ? `<div class="pt-meta">Key message: ${esc(meta.keyMessage)}</div>` : ''}
      </header>`;
    box.appendChild(clone);
    box.insertAdjacentHTML('beforeend', `<footer class="pt-foot">Downloaded ${esc(when(new Date().toISOString()))} from Campaign Lens.
      The Pre-test Score predicts how well the creative will work before any media spend. It is not a performance result.</footer>`);
    return box;
  }

  // SVG drawn into a canvas loses the page's stylesheet, so the colours of
  // the score ring and the sound chart are written onto each shape first.
  function inlineSvgStyles(root) {
    const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-opacity', 'fill-opacity', 'opacity', 'font-size', 'font-family', 'font-weight'];
    root.querySelectorAll('svg, svg *').forEach(n => {
      const cs = getComputedStyle(n);
      n.setAttribute('style', (n.getAttribute('style') || '') + ';' + PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
  }

  // Where a tall section may be cut between pages: between rows, never through one.
  function cutPoints(el) {
    const top = el.getBoundingClientRect().top;
    const pts = [...el.querySelectorAll('tr, li, .bs-fix, figure, .lens-stage, .bs-bar, .bs-sec, p')]
      .map(n => n.getBoundingClientRect().top - top).filter(v => v > 0);
    return [...new Set(pts.map(Math.round))].sort((a, b) => a - b);
  }

  async function savePdf(box, fileName) {
    for (const src of PDF_LIBS) await loadScript(src);
    const { jsPDF } = window.jspdf;
    box.classList.add('pt-pdf');
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await imagesReady(box, 15000);
      box.querySelectorAll('.bs-media').forEach(sec => { if (!sec.querySelector('img')) sec.remove(); });
      inlineSvgStyles(box);

      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      const PW = 210, PH = 297, M = 12, CW = PW - 2 * M, GAP = 3, BOTTOM = PH - M - 6;
      let y = M;
      const report = box.querySelector('.bs-report');
      const blocks = [box.querySelector('.pt-head'), ...(report ? report.children : []), box.querySelector('.pt-foot')]
        .filter(el => el && el.offsetHeight > 0);
      for (const el of blocks) {
        const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
        const pxPerMm = canvas.width / CW;
        const hMm = canvas.height / pxPerMm;
        if (hMm <= BOTTOM - M) {
          if (y + hMm > BOTTOM) { pdf.addPage(); y = M; }
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', M, y, CW, hMm);
          y += hMm + GAP;
          continue;
        }
        // Taller than a page: cut it between rows.
        const scale = canvas.height / el.offsetHeight;
        const cuts = cutPoints(el).map(v => v * scale);
        let from = 0;
        while (from < canvas.height - 1) {
          if (BOTTOM - y < 30) { pdf.addPage(); y = M; }
          const room = (BOTTOM - y) * pxPerMm;
          let to = Math.min(canvas.height, from + room);
          if (to < canvas.height) {
            const ok = cuts.filter(c => c > from + 40 && c <= to);
            if (ok.length) to = ok[ok.length - 1];
          }
          const part = document.createElement('canvas');
          part.width = canvas.width; part.height = Math.ceil(to - from);
          const ctx = part.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, part.width, part.height);
          ctx.drawImage(canvas, 0, from, canvas.width, to - from, 0, 0, canvas.width, to - from);
          const h = (to - from) / pxPerMm;
          pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', M, y, CW, h);
          y += h + GAP;
          from = to;
          if (from < canvas.height - 1) { pdf.addPage(); y = M; }
        }
      }
      const n = pdf.getNumberOfPages();
      for (let i = 1; i <= n; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8); pdf.setTextColor(140);
        pdf.text(`Campaign Lens · Page ${i} of ${n}`, PW - M, PH - 6, { align: 'right' });
      }
      pdf.save(`${fileName}.pdf`);
    } finally {
      box.classList.remove('pt-pdf');
    }
  }

  // The browser's print dialog, kept for when the PDF libraries cannot load.
  function printFallback(box, fileName) {
    const oldTitle = document.title;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.body.classList.remove('pt-printing');
      document.title = oldTitle;
      box.innerHTML = '';
      window.removeEventListener('afterprint', finish);
    };
    document.title = fileName;
    document.body.classList.add('pt-printing');
    window.addEventListener('afterprint', finish);
    window.print();
    setTimeout(() => { if (!window.matchMedia('print').matches) finish(); }, 1000);
  }

  async function downloadPdf(btn) {
    const host = btn.closest('[data-pdf-root]') || btn.closest('.org-content, .bs-detail') || document;
    const report = host && host.querySelector('.bs-report');
    if (!report) return;
    btn.disabled = true;
    btn.textContent = 'Preparing PDF…';
    let box = null;
    try {
      await loadMedia(host.querySelector ? host : document);
      let meta = {};
      try { meta = JSON.parse((host.dataset && host.dataset.pdfMeta) || '{}'); } catch (e) { /* plain header */ }
      const fileName = meta.fileName || 'Pre-test report';
      box = await buildPdfCopy(host, report, meta);
      try {
        await savePdf(box, fileName);
        box.innerHTML = '';
      } catch (e) {
        console.warn('PDF download fell back to print:', e);
        await imagesReady(box, 6000);
        printFallback(box, fileName);
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = PDF_BTN;
    }
  }

  function fileDate(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toISOString().slice(0, 10);
  }

  // ── Pre-tests page ─────────────────────────────────────────────────────────
  function pageEl() { return document.getElementById('page-pretests'); }

  // Placeholders in the shape of the page: the fact chips, the button, the
  // table. Same .sk sweep as the Creative Hub.
  function skeleton() {
    const row = (a, b) => `<div class="bs-sk-row">
        <div><div class="sk" style="width:${a}%;height:13px;margin-bottom:7px"></div><div class="sk" style="width:${a - 18}%;height:10px"></div></div>
        <div class="sk" style="width:70%;height:12px"></div><div class="sk" style="width:60%;height:12px"></div>
        <div><div class="sk" style="width:${b}%;height:12px;margin-bottom:7px"></div><div class="sk" style="width:46%;height:10px"></div></div>
        <div class="sk" style="width:58%;height:12px"></div><div class="sk" style="width:30px;height:24px;margin-left:auto;border-radius:7px"></div>
      </div>`;
    return `<div class="content bs-page" aria-busy="true">
      <div class="bs-page-head"><div class="sk-row">${[96, 250, 210, 170].map(w => `<div class="sk" style="width:${w}px;height:28px;border-radius:7px"></div>`).join('')}</div>
        <div class="sk" style="width:118px;height:36px;border-radius:8px"></div></div>
      <div class="bs-card bs-sk-table">
        <div class="bs-sk-row bs-sk-head">${[40, 50, 34, 46, 40, 30].map(w => `<div class="sk" style="width:${w}px;height:10px"></div>`).join('')}</div>
        ${[[62, 70], [54, 80], [70, 64], [48, 72], [58, 66]].map(([a, b]) => row(a, b)).join('')}
      </div></div>`;
  }

  // The report modal and the creative panel's score, while they load.
  const reportSkeleton = () => `<div class="cm-body" aria-busy="true">
      <div class="sk" style="height:22px;width:45%;margin-bottom:10px"></div>
      <div class="sk" style="height:13px;width:32%;margin-bottom:22px"></div>
      <div class="sk" style="height:96px;margin-bottom:14px;border-radius:var(--r-card)"></div>
      <div class="sk" style="height:180px;margin-bottom:14px;border-radius:var(--r-card)"></div>
      <div class="sk" style="height:140px;border-radius:var(--r-card)"></div></div>`;
  const lineSkeleton = (n = 3) => `<div aria-busy="true" style="padding:4px 0">${Array.from({ length: n }, (_, i) =>
      `<div class="sk" style="height:12px;width:${[82, 64, 74, 56][i % 4]}%;margin-bottom:9px"></div>`).join('')}</div>`;

  async function refresh({ quiet = false } = {}) {
    const page = pageEl();
    if (!page) return;
    if (!quiet && !state.data) {
      page.innerHTML = skeleton();
      state.fromSkeleton = true;
    }
    state.loading = true;
    try {
      state.data = await api('/api/pretests');
      renderPage();
    } catch (e) {
      if (!quiet) page.innerHTML = `<div class="content"><div class="load-msg load-msg-error">Couldn't load pre-tests. ${esc((typeof connectionMessage === 'function' ? connectionMessage(e) : e.message))}
        <button class="load-retry" onclick="PreTest.refresh()">Try again</button></div></div>`;
    } finally {
      state.loading = false;
      schedule();
    }
  }

  // Still being worked on: the scored checks, or the video analysis that
  // finishes the report. Nothing is shown for a pre-test until both are in.
  const isWaiting = p => RUNNING.has(p.status) || (p.status === 'succeeded' && !!p.lensPending);

  // Re-check while anything is running and the page is open; stop otherwise.
  function schedule() {
    clearTimeout(state.timer);
    const running = state.data && state.data.pretests.some(isWaiting);
    if (running && state.page === 'pretests' && !document.hidden) {
      state.timer = setTimeout(() => refresh({ quiet: true }), REFRESH_MS);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.page === 'pretests') refresh({ quiet: true }); });

  function statusCell(p) {
    const label = STATUS[p.status] || p.status;
    if (p.status === 'succeeded' && p.lensPending) return '<span class="bs-status is-running"><i></i>Finishing</span>';
    if (RUNNING.has(p.status)) return `<span class="bs-status is-running"><i></i>${esc(label)}</span>`;
    if (p.status === 'failed') return `<span class="bs-status t-neg"><i></i>${esc(label)}</span>`;
    if (p.status === 'expired') return `<span class="bs-status bs-quiet"><i></i>${esc(label)}</span>`;
    return `<span class="bs-status is-done"><i></i>${esc(label)}</span>`;
  }

  function renderPage() {
    const page = pageEl();
    const d = state.data;
    if (!page || !d) return;
    const s = d.settings || {};
    const list = d.pretests || [];
    const brandReady = d.brand && d.brand.businessGroup && d.brand.category;

    const warn = !s.configured
      ? '<div class="bs-banner">Pre-testing is not connected on this server yet. Pre-tests will work once the API keys are added.</div>'
      : !s.queue ? '<div class="bs-banner">Background processing is off on this server (no Redis), so pre-tests cannot run.</div>'
      : !brandReady ? `<div class="bs-banner">${esc(d.brand ? d.brand.name : 'This brand')} has no pre-test category yet. You can still choose one in the form.</div>` : '';

    const dash = '<span class="bs-quiet">–</span>';
    const rows = list.map(p => {
      const lensDone = !!(p.lens && p.lens.status === 'succeeded');
      // A report opens only once it is final: no half report while the
      // scored checks or the video analysis are still on their way.
      const open = !isWaiting(p) && (p.status === 'succeeded' || (p.status === 'failed' && lensDone));
      // The headline number is the score for the objective. A report with
      // no objective score (run before this, or on a server without storage)
      // keeps the overall score.
      const fit = open && lensDone && p.lens.fit != null ? p.lens.fit : null;
      const score = fit != null
        ? `<span class="bs-score t-${ragTone(ragOf(fit))}" title="Score for ${esc(String(p.lens.builtFor || 'the objective').toLowerCase())}, out of 100">${esc(fit)}</span>`
        : open && p.totalScore != null
          ? `<span class="bs-score t-${tone(p.totalRating)}" title="Overall quality check, out of 100">${Math.round(p.totalScore)}</span>` : dash;
      const objective = p.objective ? esc(p.objective)
        : open && lensDone && p.lens.builtFor ? `${esc(p.lens.builtFor)}<div class="bs-row-sub">not set, reads as</div>` : dash;
      const extra = p.status === 'failed' && p.error ? `<div class="bs-row-err">${esc(p.error)}</div>`
        : p.status === 'succeeded' && open ? `<div class="bs-row-sub">${esc(timeLeft(p.expiresAt))}</div>`
        : isWaiting(p) && p.status !== 'uploading' ? '<div class="bs-row-sub">Scoring, about 5 minutes. The report opens when it is final.</div>' : '';
      return `<tr class="${open ? 'is-open' : ''}" ${open ? `tabindex="0" data-press onclick="PreTest.openReport(${jsq(p.id)})" onkeydown="if(event.key==='Enter')PreTest.openReport(${jsq(p.id)})"` : ''}>
        <td><div class="bs-row-name">${esc(p.assetName)}</div>${extra}</td>
        <td>${esc(p.channelLabel)}</td>
        <td>${esc(p.contentOrigin === 'Creator' ? 'Others Say' : 'Brand Say')}</td>
        <td>${esc(p.requestedBy || '')}<div class="bs-row-sub">${esc(when(p.createdAt))}</div></td>
        <td>${statusCell(p)}</td>
        <td>${objective}</td>
        <td class="bs-num">${score}</td>
      </tr>`;
    }).join('');

    const can = s.configured && s.queue;
    const newBtn = `<button class="btn-primary bs-new" data-press onclick="PreTest.openForm()" ${can ? '' : 'disabled'}>New pre-test</button>`;
    const facts = `<div class="bs-facts">
        <span class="bs-fact"><b>${esc(list.length)}</b> ${list.length === 1 ? 'report' : 'reports'} on file</span>
        <span class="bs-fact">Reports are deleted <b>${esc(s.ttlHours || 72)} hours</b> after they finish</span>
        <span class="bs-fact">Up to <b>${esc(s.dailyCap)}</b> a day across Campaign Lens</span>
        <span class="bs-fact">Never shown in Creative Hub</span>
      </div>`;
    const arrive = state.fromSkeleton ? ' page-in' : '';
    state.fromSkeleton = false;
    page.innerHTML = `<div class="content bs-page${arrive}">
      <div class="bs-page-head">${facts}${list.length ? newBtn : ''}</div>
      ${warn}
      ${list.length ? `<div class="bs-card"><table class="bs-list">
        <thead><tr><th>Asset</th><th>Placement</th><th>Type</th><th>Run by</th><th>Status</th><th>Objective</th><th class="bs-num">Score</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="bs-card bs-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7.5 14h9"/></svg>
          <div class="bs-empty-title">No pre-tests for ${esc(d.brand ? d.brand.name : 'this brand')} yet</div>
          <p>Upload a video to see how it is likely to perform, and what to change, before it goes live.</p>
          ${newBtn}
        </div>`}
    </div>`;
  }

  // ── Report modal ───────────────────────────────────────────────────────────
  async function openReport(id, { quiet = false } = {}) {
    state.reportId = id;
    clearTimeout(state.reportTimer);
    const modal = document.getElementById('bsReportModal');
    const box = document.getElementById('bs-report-content');
    if (!quiet) box.innerHTML = reportSkeleton();
    modal.style.display = 'flex';
    try {
      const p = await api(`/api/pretests/${encodeURIComponent(id)}`);
      if (state.reportId !== id) return;
      const l = p.lensReport;
      const scored = !!(l && l.status === 'succeeded' && l.funnel && l.funnel.stages);
      const waiting = isWaiting(p);
      // Final only: scored and analysed, or one of the two has ended for good.
      const ready = !waiting && (p.status === 'succeeded' || (p.status === 'failed' && scored));
      const type = p.contentOrigin === 'Creator' ? 'Others Say' : 'Brand Say';
      const meta = [p.objective ? `Objective: ${p.objective}` : '', p.channelLabel, type,
        `run by ${p.requestedBy || 'unknown'}`, when(p.completedAt || p.createdAt)].filter(Boolean);
      const brandName = state.data && state.data.brand ? state.data.brand.name : '';
      const pdf = {
        title: p.assetName,
        lines: [brandName, p.campaign, p.objective ? `Objective: ${p.objective}` : '', p.channelLabel, type,
          p.ctaOverlay ? `CTA overlay: ${p.ctaOverlay === 'yes' ? 'yes' : 'no'}` : '',
          `Run by ${p.requestedBy || 'unknown'}`, `Scored ${when(p.completedAt || p.createdAt)}`].filter(Boolean),
        keyMessage: p.keyMessage,
        fileName: `Pre-test - ${p.assetName} - ${fileDate(p.completedAt || p.createdAt)}`,
      };
      const body = waiting ? waitingHTML(p)
        // Judged on its objective: the report for every pre-test with Sound and the objective scores.
        : ready && scored ? objectiveReportHTML(p)
        // No objective scores (run before they existed, or they could not be worked out): the overall report.
        : p.status === 'succeeded' ? reportHTML(p.summary, { jobId: p.id, kind: 'pretest', lens: l })
        : `<div class="organic-empty">Pre-test: ${esc(STATUS[p.status] || p.status)}${p.error ? `: ${esc(p.error)}` : ''}</div>`;
      box.innerHTML = `<div class="cm-body" data-pdf-root data-pdf-meta="${pdfMeta(pdf)}">
        <div class="detail-header">
          <div>
            <div class="detail-title">${esc(p.assetName)}</div>
            <div class="detail-meta">${esc(meta.join(' · '))}</div>
            ${p.keyMessage ? `<div class="detail-meta">Key message: ${esc(p.keyMessage)}</div>` : ''}
            ${ready && p.status === 'succeeded' ? `<div class="bs-expiry">Deleted automatically on ${esc(when(p.expiresAt))} (${esc(timeLeft(p.expiresAt))})</div>` : ''}
          </div>
          <div class="bs-head-actions">
            ${ready ? pdfButton() : ''}
            <button class="close-btn" data-press onclick="PreTest.closeReport()" aria-label="Close">×</button>
          </div>
        </div>
        ${body}
        ${p.canManage && ready && p.status === 'succeeded' ? `<div class="modal-actions">
          <button class="modal-btn modal-cancel bs-danger" onclick="PreTest.remove(${jsq(p.id)})">Delete report now</button></div>` : ''}
      </div>`;
      if (waiting) {
        // Look again shortly, quietly, for as long as this report stays open.
        state.reportTimer = setTimeout(() => { if (state.reportId === id) openReport(id, { quiet: true }); }, REFRESH_MS);
      } else {
        loadMedia(box);
      }
    } catch (e) {
      // A quiet re-check that failed leaves the waiting panel as it is and tries again.
      if (quiet) {
        state.reportTimer = setTimeout(() => { if (state.reportId === id) openReport(id, { quiet: true }); }, REFRESH_MS);
        return;
      }
      box.innerHTML = `<div class="cm-body"><div class="load-msg load-msg-error">Couldn't load the report. ${esc((typeof connectionMessage === 'function' ? connectionMessage(e) : e.message))}</div>
        <div class="modal-actions"><button class="modal-btn" onclick="PreTest.closeReport()">Close</button></div></div>`;
    }
  }

  function closeReport() {
    state.reportId = null;
    clearTimeout(state.reportTimer);
    const modal = document.getElementById('bsReportModal');
    if (modal) modal.style.display = 'none';
    const v = modal && modal.querySelector('video');
    if (v) v.pause();
  }

  async function remove(id) {
    if (!confirm('Delete this report now? The scores cannot be brought back.')) return;
    try {
      await api(`/api/pretests/${encodeURIComponent(id)}`, { method: 'DELETE' });
      closeReport();
      refresh({ quiet: true });
    } catch (e) { toast(`Could not delete: ${e.message}`, 'error'); }
  }

  // ── New pre-test form ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function fillSelect(el, options, selected) {
    el.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }

  async function openForm() {
    if (!state.data) {
      try { state.data = await api('/api/pretests'); } catch (e) { toast(`Pre-tests are unavailable: ${e.message}`, 'error'); return; }
    }
    const d = state.data, s = d.settings || {}, b = d.brand || {};
    resetForm();
    fillSelect($('bs-channel'), Object.entries(s.channels || PLACEMENT), 'tiktok');
    $('bs-cta-overlay').value = '';
    fillSelect($('bs-language'), Object.entries(s.languages || { 'en-US': 'English' }), b.language || 'en-US');
    const bg = (s.businessGroups || []).map(x => [x, x]);
    const cats = (s.categories || []).map(x => [x, x]);
    fillSelect($('bs-business-group'), b.businessGroup ? bg : [['', 'Choose a business group'], ...bg], b.businessGroup || '');
    fillSelect($('bs-category'), b.category ? cats : [['', 'Choose a category'], ...cats], b.category || '');
    const camps = (typeof CAMPAIGNS !== 'undefined' && CAMPAIGNS) || [];
    $('bs-campaigns').innerHTML = camps.map(c => `<option value="${esc(c)}">`).join('');
    $('bs-form-desc').textContent = `For ${b.name || 'this brand'}. Scores the video against its objective. Usually ready in about 5 minutes.`;
    $('bsPretestModal').style.display = 'flex';
    if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn('bsPretestModal');
    if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
    labelFields();
    onChannel();
    setTimeout(() => $('bs-drop').focus(), 50);
  }

  // YouTube needs one extra answer; the other placements do not ask it.
  function onChannel() {
    const yt = isYouTube($('bs-channel').value);
    $('bs-cta-row').hidden = !yt;
    if (!yt) $('bs-cta-overlay').value = '';
    if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
  }

  function labelFields() {
    document.querySelectorAll('#bs-form .bs-field').forEach((f, i) => {
      const lab = f.querySelector('.field-label');
      const ctl = f.querySelector('input, select, textarea');
      if (!lab || !ctl) return;
      lab.id = lab.id || `bs-lab-${i}`;
      ctl.setAttribute('aria-labelledby', lab.id);
      const btn = f.querySelector('.dd-btn');
      if (btn) btn.setAttribute('aria-labelledby', lab.id);
    });
  }

  function resetForm() {
    state.file = null; state.busy = false;
    $('bs-form').reset();
    $('bs-drop').classList.remove('has-file', 'drag-over');
    $('bs-drop-title').textContent = 'Drop a video here, or click to choose';
    $('bs-drop-hint').textContent = 'MP4 or MOV, up to 500 MB';
    $('bs-progress').hidden = true;
    setError('');
    setBusy(false);
  }

  function closeForm() {
    if (state.busy && !confirm('The upload is still running. Stop it?')) return;
    if (state.xhr) { try { state.xhr.abort(); } catch (e) { /* already done */ } }
    $('bsPretestModal').style.display = 'none';
    resetForm();
  }

  function setError(msg) {
    const el = $('bs-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setBusy(on, label) {
    state.busy = on;
    $('bs-submit').disabled = on;
    $('bs-submit').textContent = on ? (label || 'Working…') : 'Run pre-test';
    $('bs-form').querySelectorAll('input, select, textarea').forEach(el => { el.disabled = on; });
  }

  function progress(text, pct) {
    $('bs-progress').hidden = false;
    $('bs-progress-text').textContent = text;
    $('bs-progress-pct').textContent = pct == null ? '' : `${Math.round(pct)}%`;
    $('bs-progress-fill').style.width = `${pct == null ? 100 : pct}%`;
    $('bs-progress-fill').classList.toggle('is-indeterminate', pct == null);
  }

  function pickFile(f) {
    setError('');
    if (!f) return;
    if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm)$/i.test(f.name)) { setError('Choose a video file (MP4 or MOV).'); return; }
    if (f.size > MAX_BYTES) { setError(`That file is ${size(f.size)}. The limit is 500 MB.`); return; }
    state.file = f;
    $('bs-drop').classList.add('has-file');
    $('bs-drop-title').textContent = f.name;
    $('bs-drop-hint').textContent = `${size(f.size)} · click to choose a different file`;
    const name = $('bs-asset-name');
    if (!name.value.trim()) name.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
  }

  function dragOver(e) { e.preventDefault(); $('bs-drop').classList.add('drag-over'); }
  function dragLeave() { $('bs-drop').classList.remove('drag-over'); }
  function drop(e) {
    e.preventDefault();
    dragLeave();
    if (!state.busy) pickFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  }

  // Stored mode: one PUT of the raw file to a signed link (type and size are
  // part of the signature). Direct mode: a form post to the scoring
  // service's storage, the form fields first and the file last.
  function upload(form, file, onProgress) {
    return new Promise((resolve, reject) => {
      const put = form.method === 'PUT';
      let fd = null;
      if (!put) {
        fd = new FormData();
        for (const [k, v] of Object.entries(form.fields)) fd.append(k, v);
        fd.append('file', file, file.name);
      }
      const xhr = new XMLHttpRequest();
      state.xhr = xhr;
      let host = '';
      try { host = new URL(form.url).host; } catch (e) { /* shown as unknown */ }
      // If the browser's security policy blocks the upload it only looks
      // like a dropped connection, so listen for the policy's own event.
      let blocked = null;
      const onBlock = (ev) => { if (String(ev.blockedURI || '').includes(host)) blocked = ev.violatedDirective || 'security policy'; };
      document.addEventListener('securitypolicyviolation', onBlock);
      const done = () => document.removeEventListener('securitypolicyviolation', onBlock);
      const report = (msg) => {
        try {
          fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where: 'pretest-upload', message: msg }) }).catch(() => {});
        } catch (e) { /* never a second error */ }
      };
      xhr.open(put ? 'PUT' : 'POST', form.url);
      if (put) for (const [k, v] of Object.entries(form.headers || {})) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total * 100); };
      xhr.onload = () => {
        state.xhr = null; done();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          const expired = /expired|Policy|Request has expired/i.test(xhr.responseText || '');
          const err = new Error(expired ? 'upload window expired' : `the upload failed (HTTP ${xhr.status})`);
          err.expired = expired || xhr.status === 403;
          if (!err.expired) report(`HTTP ${xhr.status} from ${host}: ${String(xhr.responseText || '').slice(0, 300)}`);
          reject(err);
        }
      };
      xhr.onerror = () => {
        state.xhr = null;
        // The policy event can arrive just after the error; give it a moment.
        setTimeout(() => {
          done();
          const msg = blocked
            ? `the browser blocked the upload to ${host || 'storage'} (${blocked})`
            : `the connection to ${host || 'storage'} dropped during the upload`;
          report(`${msg}; online=${navigator.onLine}; size=${file.size}`);
          reject(new Error(msg));
        }, 50);
      };
      xhr.onabort = () => { state.xhr = null; done(); const e = new Error('the upload was stopped'); e.aborted = true; reject(e); };
      xhr.send(put ? file : fd);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (state.busy) return;
    setError('');
    if (!state.file) { setError('Choose a video to test.'); return; }
    const assetName = $('bs-asset-name').value.trim();
    if (!assetName) { setError('Give the asset a name.'); $('bs-asset-name').focus(); return; }
    if (!$('bs-objective').value) { setError('Choose an objective: what this video is for.'); return; }
    const words = $('bs-key-message').value.trim().split(/\s+/).filter(Boolean).length;
    if (words > 50) { setError(`The key message is ${words} words. Keep it to 50 or fewer.`); return; }
    if (!$('bs-business-group').value || !$('bs-category').value) { setError('Choose a business group and category.'); return; }
    if (isYouTube($('bs-channel').value) && !$('bs-cta-overlay').value) {
      setError('Say whether the video uses YouTube\'s call-to-action overlay.'); return;
    }

    const file = state.file;
    const fields = {
      asset_name: assetName,
      objective: $('bs-objective').value,
      campaign: $('bs-campaign').value.trim(),
      channel: $('bs-channel').value,
      content_type: $('bs-content-type').value,
      language: $('bs-language').value,
      business_group: $('bs-business-group').value,
      category: $('bs-category').value,
      key_message: $('bs-key-message').value.trim(),
      cta_overlay: $('bs-cta-overlay').value || undefined,
      file_name: file.name,
      file_size: file.size,
    };

    setBusy(true, 'Uploading…');
    progress('Preparing the upload', null);
    let created = null;
    let startSent = false;
    try {
      created = await api('/api/pretests', { method: 'POST', body: JSON.stringify(fields) });
      const onP = pct => progress(`Uploading · ${size(file.size)}`, pct);
      onP(0);
      try {
        await upload(created.upload, file, onP);
      } catch (err) {
        if (!err.expired) throw err;
        // The upload form lasts 5 minutes. Ask for a fresh one and try once more.
        const fresh = await api(`/api/pretests/${created.id}/upload-url`, { method: 'POST' });
        await upload(fresh.upload, file, onP);
      }
      progress('Starting the test', null);
      startSent = true;
      await api(`/api/pretests/${created.id}/start`, { method: 'POST' });
      state.busy = false;
      $('bsPretestModal').style.display = 'none';
      resetForm();
      notice(`"${assetName}" is being scored. It usually takes about 5 to 10 minutes; this page updates on its own.`);
      if (state.page !== 'pretests' && typeof setNav === 'function') setNav('pretests');
      else refresh({ quiet: true });
    } catch (err) {
      setBusy(false);
      $('bs-progress').hidden = true;
      if (startSent && (!err.status || err.status >= 500 && err.status !== 502)) {
        // The start request may have reached the scoring service even though the answer
        // did not come back. Leave the test alone; the list shows how it ends.
        $('bsPretestModal').style.display = 'none';
        resetForm();
        notice('The upload finished but the start was not confirmed. Check the list in a few minutes.');
        if (state.page !== 'pretests' && typeof setNav === 'function') setNav('pretests');
        else refresh({ quiet: true });
        return;
      }
      // Tell the server the upload never finished, so it is closed now rather than in a day.
      if (created && created.id && !startSent) api(`/api/pretests/${created.id}`, { method: 'DELETE' }).catch(() => {});
      if (!err.aborted) setError(created ? `The test did not start: ${err.message}. Try again.` : err.message);
    }
  }

  function notice(msg) {
    // The app-wide toast, so every confirmation looks and moves the same.
    if (typeof toast === 'function') return toast(msg);
    let el = $('bs-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bs-notice';
      el.className = 'bs-notice';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('is-on'), 6000);
  }

  // ── Creative cards and detail ──────────────────────────────────────────────
  // The card shows one pre-test number: the score for what the video is
  // built for. The Pre-test Score itself appears only as that score's base,
  // inside the creative. While scoring, a Scoring badge instead.
  function cardBadge(d) {
    const running = d && RUNNING.has(d.bsStatus) ? '<span class="bs-badge is-running" title="This video is being pre-tested">Scoring</span>' : '';
    const chip = running ? '' : lensChip(d);
    return chip || running ? `<span class="card-badges">${chip}${running}</span>` : '';
  }

  function detailSection(d) {
    if (!d || !d.bsStatus || d.bsStatus === 'skipped') return '';
    const head = d.bsStatus === 'succeeded' && d.lensIntent && d.lensFit != null
      ? `${d.lensIntent} ${d.lensFit} of 100`
      : d.bsStatus === 'succeeded' && d.bsScore != null ? `${Math.round(d.bsScore)} of 100`
      : RUNNING.has(d.bsStatus) ? 'Scoring now' : STATUS[d.bsStatus] || '';
    return `<details class="org-details bs-detail" style="margin-top:12px;" ontoggle="PreTest.loadCreative(this, ${jsq(d.id)})">
      <summary class="org-summary">Pre-test <span style="color:var(--c-muted);font-size:10px;">${esc(head)} ▼</span></summary>
      <div class="org-content">${lineSkeleton(3)}</div>
    </details>`;
  }

  const creativeCache = new Map();
  async function loadCreative(el, id) {
    if (!el.open) return;
    const box = el.querySelector('.org-content');
    if (!box || box.dataset.loadedFor === id) return;
    try {
      let r = creativeCache.get(id);
      if (!r) {
        const [score, lens] = await Promise.all([
          api(`/api/pretest-scores/creative/${encodeURIComponent(id)}`),
          api(`/api/lens/creative/${encodeURIComponent(id)}`).catch(() => null),
        ]);
        r = { ...score, lens };
        if (r.status === 'succeeded') creativeCache.set(id, r);
      }
      if (r.status === 'succeeded') {
        const d = (typeof findCreative === 'function' && findCreative(id)) || {};
        const pdf = {
          title: d.short || id,
          lines: [typeof BRAND_NAME !== 'undefined' ? BRAND_NAME : '', d.campaign, r.channelLabel, d.type,
            d.short && d.short !== id ? id : '', `Scored ${when(r.completedAt)}`].filter(Boolean),
          fileName: `Pre-test - ${id} - ${fileDate(r.completedAt)}`,
        };
        box.dataset.pdfRoot = '';
        box.dataset.pdfMeta = JSON.stringify(pdf);
        // The same report as a pre-test: the score for what it is built for,
        // weighted from the Pre-test Score, with Sound and the checks.
        const l = r.lens, f = l && l.status === 'succeeded' && l.funnel;
        const focus = f && (f.focus || f.intent);
        const weighted = !!(f && f.stages && focus && f.stages[focus] && f.stages[focus].parts && f.stages[focus].score != null);
        box.innerHTML = (weighted
          ? objectiveReportHTML({ id: r.id, summary: r.summary, lensReport: l }, { kind: 'creative' })
          : reportHTML(r.summary, { jobId: r.id, kind: 'creative', lens: l && l.status === 'succeeded' ? l : null }))
          + `<div class="bs-detail-foot"><div class="bs-fine">Scored for ${esc(r.channelLabel)}${r.reused ? ', reusing the score of an identical video' : ''}, ${esc(when(r.completedAt))}.</div>${pdfButton()}</div>`;
        box.dataset.loadedFor = id;
        loadMedia(box);
      } else if (RUNNING.has(r.status)) {
        box.innerHTML = '<div class="organic-empty">This video is being scored. It usually takes about 5 minutes.</div>';
      } else if (r.status === 'failed') {
        box.innerHTML = `<div class="organic-empty">This video could not be scored: ${esc(r.error || 'unknown error')}</div>`;
      } else {
        box.innerHTML = `<div class="organic-empty">${esc(r.error || 'Not pre-tested.')}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="organic-empty">Could not load the Pre-test Score: ${esc(e.message)}</div>`;
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function onPage(page) {
    state.page = page;
    if (page === 'pretests') refresh();
    else clearTimeout(state.timer);
  }

  function onBrandChange(page) {
    state.data = null;
    creativeCache.clear();
    lensCache.clear();
    if (page === 'pretests') refresh();
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('bsReportModal') && $('bsReportModal').style.display === 'flex') closeReport();
    else if ($('bsPretestModal') && $('bsPretestModal').style.display === 'flex') closeForm();
  });

  window.PreTest = {
    onPage, onBrandChange, refresh, openForm, closeForm, submit, pickFile, dragOver, dragLeave, drop, onChannel,
    openReport, closeReport, remove, cardBadge, detailSection, loadCreative, downloadPdf,
    lensSection, loadLens,
    // Kept for any old button still calling the previous modal.
    reportHTML,
  };
  window.openPretestModal = openForm;
})();

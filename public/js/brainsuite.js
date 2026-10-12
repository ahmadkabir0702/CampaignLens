/**
 * brainsuite.js — Brainsuite pre-tests and creative scores.
 *
 *   Pre-tests page   list of the brand's pre-tests, new pre-test form, report
 *   Creative cards   a score badge, and a Brainsuite section in the detail
 *
 * The video goes from this browser straight to Brainsuite's upload storage.
 * Campaign Lens only hands out a one-file upload form and starts the test.
 * Reports are summaries Campaign Lens keeps (numbers only); heatmaps are
 * fetched from Brainsuite when a report is opened, because their links
 * expire after an hour.
 */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Brainsuite ratings -> one of four looks.
  const TONE = {
    positive: 'pos', veryPositive: 'pos',
    medium: 'warn',
    negative: 'neg', veryNegative: 'neg', negativeTooLow: 'neg', negativeTooHigh: 'neg',
    notAvailable: 'na',
  };
  const tone = r => TONE[r] || 'na';
  const TONE_WORD = { pos: 'Strong', warn: 'Mixed', neg: 'Weak', na: 'Not scored' };

  const STATUS = {
    uploading: 'Uploading', queued: 'Queued', analysing: 'Analysing', succeeded: 'Ready',
    failed: 'Failed', expired: 'Report deleted', skipped: 'Not scored',
  };
  const RUNNING = new Set(['uploading', 'queued', 'analysing']);
  const PLACEMENT = {
    tiktok: 'TikTok', instagram_reel: 'Instagram Reel', instagram_story: 'Instagram Story',
    instagram_feed: 'Instagram Feed', facebook_reel: 'Facebook Reel', facebook_story: 'Facebook Story',
    facebook_feed: 'Facebook Feed',
  };
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

  // Brainsuite's own pass mark, in words.
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
      <span class="bs-bar-track"><span class="bs-bar-fill t-${t}" style="width:${pct}%"></span></span>
      <span class="bs-bar-val">${value == null ? '<span class="bs-quiet">N/A</span>' : Math.round(value)}</span>
    </div>`;
  }

  function reportHTML(s, opts = {}) {
    if (!s || !s.total) return '<div class="organic-empty">No report.</div>';
    const t = tone(s.total.rating);
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

    const catBars = (s.categories || []).map(c => bar(c.name, c.score, c.rating, {
      note: c.unweighted ? 'not in total' : '',
    })).join('');

    const placeBars = placements.map(([p, v]) => bar(PLACEMENT[p] || p, v.total, v.rating, {
      current: p === here, note: p === here ? 'tested for' : '',
    })).join('');

    const fixRows = fixes.map(k => `<li class="bs-fix t-${tone(k.rating)}">
        <div class="bs-fix-head"><span class="bs-dot t-${tone(k.rating)}"></span>
          <span class="bs-fix-name">${esc(k.name)}</span>
          <span class="bs-fix-val">${esc(k.display)}</span></div>
        ${k.tip ? `<div class="bs-fix-tip">${esc(k.tip)}</div>` : ''}
        ${passMark(k.norm) ? `<div class="bs-fix-mark">${esc(passMark(k.norm))}</div>` : ''}
      </li>`).join('');

    const groups = {};
    for (const k of s.kpis || []) (groups[k.category] = groups[k.category] || []).push(k);
    const allRows = Object.entries(groups).map(([cat, ks]) => `
      <tr class="bs-cat-row"><th colspan="3">${esc(cat)}</th></tr>
      ${ks.map(k => `<tr><td><span class="bs-dot t-${tone(k.rating)}"></span>${esc(k.name)}</td>
        <td class="bs-num">${esc(k.display)}</td><td class="bs-quiet">${esc(passMark(k.norm))}</td></tr>`).join('')}`).join('');

    return `<div class="bs-report">
      <div class="bs-hero">
        <div class="bs-total t-${t}">
          <div class="bs-total-num">${s.total.score == null ? '–' : Math.round(s.total.score)}</div>
          <div class="bs-total-sub">${TONE_WORD[t]}</div>
        </div>
        <div class="bs-hero-text">
          <div class="bs-hero-title">Brainsuite score for ${esc(PLACEMENT[here] || here)}, out of 100</div>
          ${best && worst && best[0] !== worst[0] ? `<div class="bs-hero-line">Best placement is ${esc(PLACEMENT[best[0]] || best[0])} (${Math.round(best[1].total)}). Weakest is ${esc(PLACEMENT[worst[0]] || worst[0])} (${Math.round(worst[1].total)}).</div>` : ''}
          <div class="bs-hero-line">${fixes.length ? `${fixes.length} check${fixes.length === 1 ? '' : 's'} to improve, ${works.length} working well.` : `All ${works.length} scored checks are working well.`}</div>
        </div>
      </div>

      <div class="bs-cols">
        <section class="bs-sec"><h4 class="bs-h">By category</h4>${catBars}
          ${noMessage ? `<div class="bs-sec-hint">${opts.kind === 'pretest'
            ? 'Strategic Fit needs a key message. Add one when you run the next pre-test.'
            : 'Strategic Fit needs a key message, which added creatives do not have.'}</div>` : ''}
        </section>
        <section class="bs-sec"><h4 class="bs-h">By placement</h4>${placeBars}</section>
      </div>

      ${fixes.length ? `<section class="bs-sec"><h4 class="bs-h">What to improve</h4><ul class="bs-fixes">${fixRows}</ul></section>` : ''}

      ${works.length ? `<section class="bs-sec"><h4 class="bs-h">What works</h4>
        <div class="bs-chips">${works.map(k => `<span class="bs-chip">${esc(k.name)}</span>`).join('')}</div></section>` : ''}

      <section class="bs-sec bs-media" data-job="${esc(opts.jobId || '')}" data-video="${opts.kind === 'pretest' ? '1' : ''}">
        <h4 class="bs-h">Where attention goes</h4>
        <div class="bs-media-body"><div class="bs-quiet">Loading heatmaps…</div></div>
      </section>

      <details class="bs-all"><summary>All ${(s.kpis || []).length} checks and their pass marks</summary>
        <table class="bs-table"><tbody>${allRows}</tbody></table></details>

      ${opts.weblink ? `<div class="bs-foot"><a href="${esc(opts.weblink)}" target="_blank" rel="noopener">Open the full report in Brainsuite</a> <span class="bs-quiet">(needs a Brainsuite login)</span></div>` : ''}
    </div>`;
  }

  async function loadMedia(root) {
    const sec = root && root.querySelector('.bs-media');
    if (!sec || !sec.dataset.job || sec.dataset.loaded) return;
    sec.dataset.loaded = '1';
    const body = sec.querySelector('.bs-media-body');
    try {
      const m = await api(`/api/brainsuite/jobs/${encodeURIComponent(sec.dataset.job)}/media`);
      if (m.gone || (!m.montage && !(m.stills || []).length && !m.heatmovie)) {
        body.innerHTML = '<div class="bs-quiet">Heatmaps are no longer available from Brainsuite. The scores above are kept.</div>';
        return;
      }
      body.innerHTML = `
        ${m.heatmovie && sec.dataset.video ? `<video class="bs-video" src="${esc(m.heatmovie)}" controls preload="none" playsinline></video>
          <div class="bs-cap">Attention heatmap over the whole video. Red is where most people look.</div>` : ''}
        ${(m.stills || []).length ? `<div class="bs-stills">${m.stills.map(x => `
          <figure><img src="${esc(x.url)}" alt="${esc(x.label)} heatmap" loading="lazy"
            onerror="this.closest('figure').remove()"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>` : ''}
        ${m.montage ? `<figure class="bs-montage"><img src="${esc(m.montage)}" alt="Scenes detected by Brainsuite" loading="lazy"
            onerror="this.closest('figure').remove()"><figcaption>Every scene Brainsuite detected</figcaption></figure>` : ''}`;
    } catch (e) {
      body.innerHTML = `<div class="bs-quiet">Could not load heatmaps: ${esc(e.message)}</div>`;
      delete sec.dataset.loaded;
    }
  }

  // ── Pre-tests page ─────────────────────────────────────────────────────────
  function pageEl() { return document.getElementById('page-pretests'); }

  async function refresh({ quiet = false } = {}) {
    const page = pageEl();
    if (!page) return;
    if (!quiet && !state.data) {
      page.innerHTML = '<div class="content"><div class="load-msg">Loading pre-tests…</div></div>';
    }
    state.loading = true;
    try {
      state.data = await api('/api/pretests');
      renderPage();
    } catch (e) {
      if (!quiet) page.innerHTML = `<div class="content"><div class="load-msg load-msg-error">Couldn't load pre-tests. ${esc(e.message)}
        <button class="load-retry" onclick="BS.refresh()">Try again</button></div></div>`;
    } finally {
      state.loading = false;
      schedule();
    }
  }

  // Re-check while anything is running and the page is open; stop otherwise.
  function schedule() {
    clearTimeout(state.timer);
    const running = state.data && state.data.pretests.some(p => RUNNING.has(p.status));
    if (running && state.page === 'pretests' && !document.hidden) {
      state.timer = setTimeout(() => refresh({ quiet: true }), REFRESH_MS);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.page === 'pretests') refresh({ quiet: true }); });

  function statusCell(p) {
    const label = STATUS[p.status] || p.status;
    if (RUNNING.has(p.status)) return `<span class="bs-status is-running"><span class="bs-spin"></span>${esc(label)}</span>`;
    if (p.status === 'failed') return `<span class="bs-status t-neg">${esc(label)}</span>`;
    if (p.status === 'expired') return `<span class="bs-status bs-quiet">${esc(label)}</span>`;
    return `<span class="bs-status">${esc(label)}</span>`;
  }

  function renderPage() {
    const page = pageEl();
    const d = state.data;
    if (!page || !d) return;
    const s = d.settings || {};
    const list = d.pretests || [];
    const brandReady = d.brand && d.brand.businessGroup && d.brand.category;

    const warn = !s.configured
      ? '<div class="bs-banner">Brainsuite is not connected on this server yet. Pre-tests will work once the API keys are added.</div>'
      : !s.queue ? '<div class="bs-banner">Background processing is off on this server (no Redis), so pre-tests cannot run.</div>'
      : !brandReady ? `<div class="bs-banner">${esc(d.brand ? d.brand.name : 'This brand')} has no Brainsuite category yet. You can still choose one in the form.</div>` : '';

    const rows = list.map(p => {
      const open = p.status === 'succeeded';
      const score = p.totalScore != null && open
        ? `<span class="bs-score t-${tone(p.totalRating)}">${Math.round(p.totalScore)}</span>` : '<span class="bs-quiet">–</span>';
      const extra = p.status === 'failed' && p.error ? `<div class="bs-row-err">${esc(p.error)}</div>`
        : p.status === 'succeeded' ? `<div class="bs-row-sub">${esc(timeLeft(p.expiresAt))}</div>` : '';
      return `<tr class="${open ? 'is-open' : ''}" ${open ? `tabindex="0" data-press onclick="BS.openReport('${esc(p.id)}')" onkeydown="if(event.key==='Enter')BS.openReport('${esc(p.id)}')"` : ''}>
        <td><div class="bs-row-name">${esc(p.assetName)}</div>${extra}</td>
        <td>${esc(p.channelLabel)}</td>
        <td>${esc(p.contentOrigin === 'Creator' ? 'Others Say' : 'Brand Say')}</td>
        <td>${esc(p.requestedBy || '')}<div class="bs-row-sub">${esc(when(p.createdAt))}</div></td>
        <td>${statusCell(p)}</td>
        <td class="bs-num">${score}</td>
      </tr>`;
    }).join('');

    page.innerHTML = `<div class="content bs-page">
      <div class="bs-page-head">
        <div>
          <p class="bs-lede">Score a video with Brainsuite before it runs. Each report is deleted ${esc(s.ttlHours || 72)} hours after it finishes, and pre-tests never appear in Creative Hub.</p>
        </div>
        <button class="btn-outline primary" data-press onclick="BS.openForm()" ${s.configured && s.queue ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>New pre-test</button>
      </div>
      ${warn}
      ${list.length ? `<div class="bs-card"><table class="bs-list">
        <thead><tr><th>Asset</th><th>Placement</th><th>Type</th><th>Run by</th><th>Status</th><th class="bs-num">Score</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="bs-card bs-empty">No pre-tests for ${esc(d.brand ? d.brand.name : 'this brand')} yet. Use New pre-test to score a video before it goes live.</div>`}
      <div class="bs-fine">Each pre-test uses one Brainsuite test. Up to ${esc(s.dailyCap)} pre-tests a day across Campaign Lens.</div>
    </div>`;
  }

  // ── Report modal ───────────────────────────────────────────────────────────
  async function openReport(id) {
    state.reportId = id;
    const modal = document.getElementById('bsReportModal');
    const box = document.getElementById('bs-report-content');
    box.innerHTML = '<div class="cm-body"><div class="load-msg">Loading report…</div></div>';
    modal.style.display = 'flex';
    try {
      const p = await api(`/api/pretests/${encodeURIComponent(id)}`);
      if (state.reportId !== id) return;
      const meta = [p.channelLabel, p.contentOrigin === 'Creator' ? 'Others Say' : 'Brand Say',
        `run by ${p.requestedBy || 'unknown'}`, when(p.completedAt || p.createdAt)].filter(Boolean);
      box.innerHTML = `<div class="cm-body">
        <div class="detail-header">
          <div>
            <div class="detail-title">${esc(p.assetName)}</div>
            <div class="detail-meta">${esc(meta.join(' · '))}</div>
            ${p.keyMessage ? `<div class="detail-meta">Key message: ${esc(p.keyMessage)}</div>` : ''}
            ${p.status === 'succeeded' ? `<div class="bs-expiry">Deleted automatically on ${esc(when(p.expiresAt))} (${esc(timeLeft(p.expiresAt))})</div>` : ''}
          </div>
          <button class="close-btn" data-press onclick="BS.closeReport()" aria-label="Close">×</button>
        </div>
        ${p.status === 'succeeded' ? reportHTML(p.summary, { jobId: p.id, weblink: p.weblink, kind: 'pretest' })
          : `<div class="organic-empty">${esc(STATUS[p.status] || p.status)}${p.error ? `: ${esc(p.error)}` : ''}</div>`}
        ${p.canManage && p.status === 'succeeded' ? `<div class="modal-actions">
          <button class="modal-btn modal-cancel bs-danger" onclick="BS.remove('${esc(p.id)}')">Delete report now</button></div>` : ''}
      </div>`;
      loadMedia(box);
    } catch (e) {
      box.innerHTML = `<div class="cm-body"><div class="load-msg load-msg-error">Couldn't load the report. ${esc(e.message)}</div>
        <div class="modal-actions"><button class="modal-btn" onclick="BS.closeReport()">Close</button></div></div>`;
    }
  }

  function closeReport() {
    state.reportId = null;
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
    } catch (e) { alert(`Could not delete: ${e.message}`); }
  }

  // ── New pre-test form ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function fillSelect(el, options, selected) {
    el.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }

  async function openForm() {
    if (!state.data) {
      try { state.data = await api('/api/pretests'); } catch (e) { alert(`Pre-tests are unavailable: ${e.message}`); return; }
    }
    const d = state.data, s = d.settings || {}, b = d.brand || {};
    resetForm();
    fillSelect($('bs-channel'), Object.entries(s.channels || PLACEMENT), 'tiktok');
    fillSelect($('bs-language'), Object.entries(s.languages || { 'en-US': 'English' }), b.language || 'en-US');
    const bg = (s.businessGroups || []).map(x => [x, x]);
    const cats = (s.categories || []).map(x => [x, x]);
    fillSelect($('bs-business-group'), b.businessGroup ? bg : [['', 'Choose a business group'], ...bg], b.businessGroup || '');
    fillSelect($('bs-category'), b.category ? cats : [['', 'Choose a category'], ...cats], b.category || '');
    const camps = (typeof CAMPAIGNS !== 'undefined' && CAMPAIGNS) || [];
    $('bs-campaigns').innerHTML = camps.map(c => `<option value="${esc(c)}">`).join('');
    $('bs-form-desc').textContent = `For ${b.name || 'this brand'}. Brainsuite scores the video for attention, branding and recall. Usually ready in about 5 minutes.`;
    $('bsPretestModal').style.display = 'flex';
    if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn('bsPretestModal');
    if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
    labelFields();
    setTimeout(() => $('bs-drop').focus(), 50);
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

  // Straight to Brainsuite's storage: the form fields first, the file last.
  function upload(form, file, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form.fields)) fd.append(k, v);
      fd.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      state.xhr = xhr;
      xhr.open('POST', form.url);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total * 100); };
      xhr.onload = () => {
        state.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          const expired = /expired|Policy/i.test(xhr.responseText || '');
          const err = new Error(expired ? 'upload window expired' : `the upload failed (HTTP ${xhr.status})`);
          err.expired = expired || xhr.status === 403;
          reject(err);
        }
      };
      xhr.onerror = () => { state.xhr = null; reject(new Error('the connection dropped during the upload')); };
      xhr.onabort = () => { state.xhr = null; const e = new Error('the upload was stopped'); e.aborted = true; reject(e); };
      xhr.send(fd);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (state.busy) return;
    setError('');
    if (!state.file) { setError('Choose a video to test.'); return; }
    const assetName = $('bs-asset-name').value.trim();
    if (!assetName) { setError('Give the asset a name.'); $('bs-asset-name').focus(); return; }
    const words = $('bs-key-message').value.trim().split(/\s+/).filter(Boolean).length;
    if (words > 50) { setError(`The key message is ${words} words. Keep it to 50 or fewer.`); return; }
    if (!$('bs-business-group').value || !$('bs-category').value) { setError('Choose a business group and category.'); return; }

    const file = state.file;
    const fields = {
      asset_name: assetName,
      campaign: $('bs-campaign').value.trim(),
      channel: $('bs-channel').value,
      content_type: $('bs-content-type').value,
      language: $('bs-language').value,
      business_group: $('bs-business-group').value,
      category: $('bs-category').value,
      key_message: $('bs-key-message').value.trim(),
      file_name: file.name,
      file_size: file.size,
    };

    setBusy(true, 'Uploading…');
    progress('Checking with Brainsuite', null);
    let created = null;
    let startSent = false;
    try {
      created = await api('/api/pretests', { method: 'POST', body: JSON.stringify(fields) });
      const onP = pct => progress(`Uploading to Brainsuite · ${size(file.size)}`, pct);
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
      notice(`"${assetName}" is being scored. It usually takes about 5 minutes; this page updates on its own.`);
      if (state.page !== 'pretests' && typeof setNav === 'function') setNav('pretests');
      else refresh({ quiet: true });
    } catch (err) {
      setBusy(false);
      $('bs-progress').hidden = true;
      if (startSent && (!err.status || err.status >= 500 && err.status !== 502)) {
        // The start request may have reached Brainsuite even though the answer
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
  function cardBadge(d) {
    if (!d || !d.bsStatus) return '';
    if (d.bsStatus === 'succeeded' && d.bsScore != null) {
      return `<span class="bs-badge t-${tone(d.bsRating)}" title="Brainsuite score: ${Math.round(d.bsScore)} of 100">Brainsuite <b>${Math.round(d.bsScore)}</b></span>`;
    }
    if (RUNNING.has(d.bsStatus)) return '<span class="bs-badge is-running" title="Brainsuite is scoring this video">Scoring</span>';
    return '';
  }

  function detailSection(d) {
    if (!d || !d.bsStatus || d.bsStatus === 'skipped') return '';
    const head = d.bsStatus === 'succeeded' && d.bsScore != null
      ? `${Math.round(d.bsScore)} of 100 · ${TONE_WORD[tone(d.bsRating)]}`
      : RUNNING.has(d.bsStatus) ? 'Scoring now' : STATUS[d.bsStatus] || '';
    return `<details class="org-details bs-detail" style="margin-top:12px;" ontoggle="BS.loadCreative(this, '${esc(d.id)}')">
      <summary class="org-summary">Brainsuite score <span style="color:var(--c-muted);font-size:10px;">${esc(head)} ▼</span></summary>
      <div class="org-content"><div class="organic-empty">Loading…</div></div>
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
        r = await api(`/api/brainsuite/creative/${encodeURIComponent(id)}`);
        if (r.status === 'succeeded') creativeCache.set(id, r);
      }
      if (r.status === 'succeeded') {
        box.innerHTML = reportHTML(r.summary, { jobId: r.id, weblink: r.weblink, kind: 'creative' })
          + `<div class="bs-fine">Scored for ${esc(r.channelLabel)}${r.reused ? ', reusing the score of an identical video' : ''}, ${esc(when(r.completedAt))}.</div>`;
        box.dataset.loadedFor = id;
        loadMedia(box);
      } else if (RUNNING.has(r.status)) {
        box.innerHTML = '<div class="organic-empty">Brainsuite is scoring this video. It usually takes about 5 minutes.</div>';
      } else if (r.status === 'failed') {
        box.innerHTML = `<div class="organic-empty">Brainsuite could not score this video: ${esc(r.error || 'unknown error')}</div>`;
      } else {
        box.innerHTML = `<div class="organic-empty">${esc(r.error || 'Not scored by Brainsuite.')}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="organic-empty">Could not load the Brainsuite score: ${esc(e.message)}</div>`;
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
    if (page === 'pretests') refresh();
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('bsReportModal') && $('bsReportModal').style.display === 'flex') closeReport();
    else if ($('bsPretestModal') && $('bsPretestModal').style.display === 'flex') closeForm();
  });

  window.BS = {
    onPage, onBrandChange, refresh, openForm, closeForm, submit, pickFile, dragOver, dragLeave, drop,
    openReport, closeReport, remove, cardBadge, detailSection, loadCreative,
    // Kept for any old button still calling the previous modal.
    reportHTML,
  };
  window.openPretestModal = openForm;
})();

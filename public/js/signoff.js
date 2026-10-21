/**
 * signoff.js — Campaign sign-off (Unilever social-first sign-off)
 *
 * Three views in #page-signoff:
 *   board   every checklist for the brands this account sees, in four
 *           columns: Draft, With media head, Changes requested, Approved
 *   detail  one checklist: every item with its value, the media head's
 *           marks and notes, his section, the activity log, versions
 *   form    create or edit (creators, while a draft or sent back)
 *
 * The server (server/signoff/routes.js) decides who may do what; this file
 * only shows the buttons that will work. The checklist is defined once in
 * signoff-items.js, which the server uses too.
 */
(function () {
  'use strict';

  const I = window.SignoffItems;
  const host = () => document.getElementById('page-signoff');

  let ME = { reviewer: false, canCreate: false, username: '' };
  let BRANDS = [];          // [{ id, name }]
  let LIST = [];
  let FILTER = { brand: '', q: '' };
  let CURRENT = null;       // detail payload
  let DRAFT = null;         // the record being edited { id, brand_id, meta, fields, review }

  const STATUS = {
    draft:             { label: 'Draft',              cls: 'sg-st-draft' },
    submitted:         { label: 'With media head',    cls: 'sg-st-review' },
    changes_requested: { label: 'Changes requested',  cls: 'sg-st-changes' },
    approved:          { label: 'Approved',           cls: 'sg-st-approved' },
    superseded:        { label: 'Replaced by a newer version', cls: 'sg-st-old' },
  };
  const ACTION_WORDS = {
    created: 'created the checklist', submitted: 'sent it to the media head',
    resubmitted: 'sent it back to the media head', changes_requested: 'asked for changes',
    approved: 'approved it', amended: 'started an amendment', superseded: 'replaced it with a newer version',
  };

  // ---- Small helpers ----------------------------------------------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  function iso(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const x = new Date(d);
    if (isNaN(x)) return '';
    return new Date(x.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  }
  function fmtDate(d) {
    const s = iso(d);
    if (!s) return '';
    const [y, m, day] = s.split('-').map(Number);
    return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
  }
  function fmtWhen(d) {
    if (!d) return '';
    const x = new Date(d);
    return `${fmtDate(d)}, ${x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo' })}`;
  }
  const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
  const daysUntil = (isoDay) => (isoDay ? Math.round((Date.parse(isoDay) - Date.parse(I.todayIso())) / 86400000) : null);
  const say = (msg, tone) => (typeof toast === 'function' ? toast(msg, tone) : alert(msg));
  const brandName = (id) => (BRANDS.find((b) => b.id === id) || {}).name || id || '';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) { const err = new Error(data.error || 'Could not reach the server. Try again.'); err.data = data; err.status = res.status; throw err; }
    return data;
  }

  async function loadBrands() {
    if (BRANDS.length) return BRANDS;
    try {
      const data = await api('GET', '/api/brands');
      BRANDS = (data.brands || []).map((b) => ({ id: b.brand_id, name: b.name }));
    } catch (e) { BRANDS = []; }
    return BRANDS;
  }

  /** The record shape signoff-items.js reads, from a list or detail row. */
  const asRecord = (s) => ({
    brand_id: s.brand_id,
    meta: s.meta || {
      campaignName: s.campaign_name || '', market: s.market || '', goLive: iso(s.go_live_date),
      clientLead: s.client_lead_name || '', variant: s.variant || '', format: s.format || '',
      datePrepared: iso(s.date_prepared),
    },
    fields: s.fields || I.blankFields(),
  });

  function progressBar(p, small) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `<div class="sg-prog${small ? ' sg-prog-sm' : ''}" title="${p.done} of ${p.total} required items filled in">
      <div class="sg-prog-track"><i style="width:${pct}%"></i></div>
      <span>${p.done} of ${p.total}</span></div>`;
  }

  /** Go-live warning: amber inside 7 days, red when passed, unless approved. */
  function goLiveTag(s) {
    const d = iso(s.go_live_date || (s.meta && s.meta.goLive));
    if (!d) return '<span class="sg-golive">No go-live date</span>';
    const left = daysUntil(d);
    const open = s.status !== 'approved' && s.status !== 'superseded';
    let cls = '', note = '';
    if (open && left < 0) { cls = ' is-late'; note = ' · passed'; }
    else if (open && left <= 7) { cls = ' is-soon'; note = left === 0 ? ' · today' : ` · in ${plural(left, 'day')}`; }
    return `<span class="sg-golive${cls}">Go-live ${fmtDate(d)}${note}</span>`;
  }

  function waitingSince(s) {
    if (s.status === 'submitted') return s.submitted_at;
    if (s.status === 'changes_requested') return s.returned_at;
    return null;
  }

  // =======================================================================
  //  BOARD
  // =======================================================================
  async function render() {
    const el = host();
    if (!el) return;
    el.innerHTML = `<div class="sg-wrap"><div class="sg-loading">Loading checklists…</div></div>`;
    try {
      await loadBrands();
      const data = await api('GET', '/api/signoffs');
      LIST = data.signoffs || [];
      ME = data.me || ME;
    } catch (e) {
      el.innerHTML = `<div class="sg-wrap"><div class="sg-empty">${esc(e.message)}</div></div>`;
      return;
    }
    drawBoard();
    refreshBadge();
  }

  function drawBoard() {
    const el = host();
    const q = FILTER.q.trim().toLowerCase();
    const rows = LIST.filter((s) => s.status !== 'superseded')
      .filter((s) => !FILTER.brand || s.brand_id === FILTER.brand)
      .filter((s) => !q || `${s.campaign_name} ${s.brand_name} ${s.created_by_name} ${s.client_lead_name}`.toLowerCase().includes(q));

    const cols = [
      { key: 'draft', title: 'Draft', empty: 'Nothing being drafted.' },
      { key: 'submitted', title: 'With media head', empty: 'Nothing waiting for review.' },
      { key: 'changes_requested', title: 'Changes requested', empty: 'Nothing sent back.' },
      { key: 'approved', title: 'Approved', empty: 'Nothing approved yet.' },
    ];
    const mine = ME.reviewer ? 'submitted' : 'changes_requested';
    const waiting = rows.filter((s) => s.status === mine).length;

    const card = (s) => {
      const since = waitingSince(s);
      const d = daysSince(since);
      const flagged = Object.values((s.review || {}).items || {}).filter((v) => v === 'change').length;
      return `<button class="sg-card${s.status === mine ? ' is-mine' : ''}" onclick="Signoff.open(${s.id})">
        <div class="sg-card-top">
          <span class="sg-card-brand">${esc(s.brand_name || s.brand_id)}</span>
          ${s.version > 1 ? `<span class="sg-ver">v${s.version}</span>` : ''}
        </div>
        <div class="sg-card-name">${esc(s.campaign_name || 'Untitled campaign')}</div>
        ${s.status === 'approved'
          ? `<div class="sg-card-line sg-ok">Approved ${fmtDate(s.approved_at)}</div>`
          : progressBar(s.progress, true)}
        ${s.status === 'changes_requested' && flagged ? `<div class="sg-card-line sg-warn">${plural(flagged, 'item')} to change</div>` : ''}
        <div class="sg-card-foot">
          ${goLiveTag(s)}
          ${d !== null ? `<span class="sg-wait${d >= 3 ? ' is-long' : ''}">${d === 0 ? 'Since today' : `Waiting ${plural(d, 'day')}`}</span>` : ''}
        </div>
        <div class="sg-card-by">${esc(s.created_by_name || s.created_by || '')}${s.notes ? ` · ${plural(s.notes, 'note')}` : ''}</div>
      </button>`;
    };

    el.innerHTML = `<div class="sg-wrap sg-board-wrap">
      <div class="sg-toolbar">
        <div class="sg-tools">
          <select class="sg-select" aria-label="Brand" onchange="Signoff.filter('brand', this.value)">
            <option value="">All brands</option>
            ${BRANDS.map((b) => `<option value="${esc(b.id)}"${FILTER.brand === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select>
          <input class="sg-search" type="search" placeholder="Search campaign, brand or person" value="${esc(FILTER.q)}"
                 oninput="Signoff.filter('q', this.value)" aria-label="Search checklists">
        </div>
        ${ME.canCreate ? `<button class="btn-primary" onclick="Signoff.create()">New checklist</button>` : ''}
      </div>
      ${waiting ? `<div class="sg-callout">${ME.reviewer
        ? `<b>${plural(waiting, 'checklist')} waiting for your review.</b> Open one to go through it, mark each item, then approve or send it back.`
        : `<b>${plural(waiting, 'checklist')} sent back with changes.</b> Open one to see what the media head asked for.`}</div>` : ''}
      <div class="sg-board">
        ${cols.map((c) => {
          const list = rows.filter((s) => s.status === c.key);
          return `<section class="sg-col sg-col-${c.key}">
            <header><span>${c.title}</span><b>${list.length}</b></header>
            <div class="sg-col-body">${list.map(card).join('') || `<div class="sg-col-empty">${c.empty}</div>`}</div>
          </section>`;
        }).join('')}
      </div>
    </div>`;
    const search = el.querySelector('.sg-search');
    if (search && FILTER.q && document.activeElement !== search && FILTER._typing) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function filter(k, v) {
    FILTER[k] = v;
    FILTER._typing = k === 'q';
    drawBoard();
  }

  async function refreshBadge() {
    const nav = document.querySelector(`.nav-item[onclick*="setNav('signoff'"]`);
    if (!nav) return;
    try {
      const d = await api('GET', '/api/signoffs/summary');
      let b = nav.querySelector('.sg-nav-badge');
      if (!b) { b = document.createElement('span'); b.className = 'sg-nav-badge'; nav.appendChild(b); }
      b.textContent = d.waiting;
      b.hidden = !d.waiting;
      b.title = d.reviewer ? 'Waiting for your review' : 'Sent back with changes';
    } catch (e) { /* the badge is a convenience */ }
  }

  // =======================================================================
  //  DETAIL
  // =======================================================================
  async function open(id) {
    const el = host();
    el.innerHTML = `<div class="sg-wrap"><div class="sg-loading">Loading…</div></div>`;
    try {
      await loadBrands();
      CURRENT = await api('GET', `/api/signoffs/${id}`);
      ME = CURRENT.me || ME;
    } catch (e) {
      el.innerHTML = `<div class="sg-wrap"><button class="sg-back" onclick="Signoff.render()">← All checklists</button><div class="sg-empty">${esc(e.message)}</div></div>`;
      return;
    }
    drawDetail();
    window.scrollTo({ top: 0 });
  }

  /** What a person sees as the value of one item. */
  function valueHTML(key, rec) {
    const m = rec.meta, f = rec.fields || {};
    const fu = f.funnel || {}, se = f.setup || {}, co = f.costs || {}, de = f.delivery || {};
    const v = (x) => (has(x) ? esc(x) : '<span class="sg-none">Not filled in</span>');
    const list = (a) => (a && a.length ? a.map((x) => `<span class="sg-tag">${esc(x)}</span>`).join('') : '<span class="sg-none">Not filled in</span>');
    switch (key) {
      case 'details': return `<dl class="sg-dl">
          <dt>Brand</dt><dd>${esc(brandName(rec.brand_id))}</dd>
          <dt>Market</dt><dd>${v(m.market)}</dd>
          <dt>Go-live</dt><dd>${has(m.goLive) ? fmtDate(m.goLive) : v('')}</dd>
          <dt>Client lead</dt><dd>${v(m.clientLead)}</dd>
          <dt>Variant</dt><dd>${v(m.variant)}</dd>
          <dt>Format</dt><dd>${v(m.format)}</dd>
          <dt>Prepared</dt><dd>${has(m.datePrepared) ? fmtDate(m.datePrepared) : v('')}</dd></dl>`;
      case 'funnel_types': return `<dl class="sg-dl"><dt>TOFU</dt><dd>${v(fu.tofu)}</dd><dt>MOFU</dt><dd>${v(fu.mofu)}</dd><dt>BOFU</dt><dd>${v(fu.bofu)}</dd></dl>`;
      case 'funnel_budget': { const b = fu.budget || {}; return `<div class="sg-split"><span>TOFU <b>${esc(b.tofu ?? 0)}%</b></span><span>MOFU <b>${esc(b.mofu ?? 0)}%</b></span><span>BOFU <b>${esc(b.bofu ?? 0)}%</b></span></div>`; }
      case 'funnel_bid': { const b = fu.bid || {}; return `<dl class="sg-dl"><dt>TOFU</dt><dd>${v(b.TOFU)}</dd><dt>MOFU</dt><dd>${v(b.MOFU)}</dd><dt>BOFU</dt><dd>${v(b.BOFU)}</dd></dl>`; }
      case 'delivery': {
        const got = I.DELIVERY_FIELDS.filter(([k]) => has(de[k]));
        return got.length ? `<dl class="sg-dl sg-dl-grid">${got.map(([k, l]) => `<dt>${l}</dt><dd>${esc(de[k])}</dd>`).join('')}</dl>` : v('');
      }
      case 'audience': return v(se.audienceDone);
      case 'dates': return has(se.startDate) || has(se.endDate) ? `${has(se.startDate) ? fmtDate(se.startDate) : '?'} to ${has(se.endDate) ? fmtDate(se.endDate) : '?'}` : v('');
      case 'tg_size': return v(se.tgSize);
      case 'creative_types': return list(se.creativeTypes);
      case 'landing_links': return has(se.landingLinks)
        ? `<div class="sg-links">${esc(se.landingLinks).split(/\s+/).filter(Boolean).map((u) => /^https?:\/\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${u}</a>` : u).join(' ')}</div>` : v('');
      case 'cost_platform': return v(co.platform);
      case 'cost_data': return v(co.data);
      case 'cost_adserving': return v(co.adServing);
      case 'cost_verification': return v(co.verification);
      case 'cost_1pd': return v(co.pd1);
      case 'cost_retainer': return v(co.retainer);
      case 'cost_ustore': return v(co.ustore);
      case 'cost_google': return list(co.google);
      case 'cost_other': return has(co.other) ? esc(co.other) : '<span class="sg-none">None</span>';
      default: return '';
    }
  }

  function markChip(mark) {
    if (mark === 'ok') return '<span class="sg-mark sg-mark-ok">OK</span>';
    if (mark === 'change') return '<span class="sg-mark sg-mark-change">Needs change</span>';
    if (mark === 'recheck') return '<span class="sg-mark sg-mark-recheck">Updated, check again</span>';
    return '';
  }

  function noteHTML(n) {
    return `<div class="sg-note${n.is_reviewer ? ' is-reviewer' : ''}">
      <div class="sg-note-head"><b>${esc(n.author_name || n.author)}</b>${n.is_reviewer ? '<span class="sg-role">Media head</span>' : ''}<span>${fmtWhen(n.created_at)}</span></div>
      <div class="sg-note-body">${esc(n.body)}</div></div>`;
  }

  function drawDetail() {
    const { signoff: s, notes, events, versions } = CURRENT;
    const rec = asRecord(s);
    const st = STATUS[s.status] || { label: s.status, cls: '' };
    const review = s.review || {};
    const marks = review.items || {};
    const reviewing = ME.reviewer && s.status === 'submitted';
    const editable = ME.canCreate && (s.status === 'draft' || s.status === 'changes_requested');
    const notesBy = {};
    for (const n of notes) (notesBy[n.item_key || '_'] ||= []).push(n);
    const flagged = Object.entries(marks).filter(([, v]) => v === 'change').map(([k]) => k);

    // The one line under the title saying where it stands.
    let banner = '';
    if (s.status === 'draft') banner = `<div class="sg-banner">Draft. ${ME.canCreate ? 'Fill in every item, then send it to the media head.' : 'Not sent for review yet.'}</div>`;
    if (s.status === 'submitted') banner = `<div class="sg-banner sg-banner-review">${ME.reviewer
      ? 'Waiting for your review. Mark each item, fill in your section, then approve or send it back.'
      : `With the media head since ${fmtDate(s.submitted_at)}. It can't be edited while he reviews it.`}</div>`;
    if (s.status === 'changes_requested') banner = `<div class="sg-banner sg-banner-changes">Sent back on ${fmtDate(s.returned_at)}${flagged.length ? ` with ${plural(flagged.length, 'item')} to change: ${flagged.map((k) => esc((I.ITEMS.find((i) => i.key === k) || {}).label || k)).join(', ')}` : ''}. ${ME.canCreate ? 'Edit, then send it back.' : ''}</div>`;
    if (s.status === 'approved') banner = `<div class="sg-banner sg-banner-ok">Approved by ${esc(nameOf(events, 'approved') || s.approved_by)} on ${fmtDate(s.approved_at)}. <b>${esc(s.campaign_name)}</b> is now a campaign in Campaign Lens for ${esc(s.brand_name)}.</div>`;
    if (s.status === 'superseded') banner = `<div class="sg-banner">This version was replaced by a newer approved version.</div>`;

    const actions = [];
    if (editable) actions.push(`<button class="btn-outline" onclick="Signoff.edit()">Edit</button>`);
    if (editable) actions.push(`<button class="btn-primary" onclick="Signoff.submitFromDetail()">Send to media head</button>`);
    if (ME.canCreate && s.status === 'draft' && !s.submitted_at) actions.push(`<button class="btn-outline sg-danger" onclick="Signoff.remove()">Delete</button>`);
    if (ME.canCreate && s.status === 'approved') actions.push(`<button class="btn-outline" onclick="Signoff.amend()">Amend</button>`);
    if (ME.canCreate) actions.push(`<button class="btn-outline" onclick="Signoff.duplicate()">Copy to new</button>`);
    actions.push(`<button class="btn-outline" onclick="Signoff.pdf()">Download PDF</button>`);

    const itemRow = (it) => {
      const missing = it.required ? it.problem(rec) : null;
      const mark = marks[it.key];
      const thread = notesBy[it.key] || [];
      return `<div class="sg-item${mark === 'change' ? ' is-change' : ''}${mark === 'recheck' ? ' is-recheck' : ''}" id="sg-item-${it.key}">
        <div class="sg-item-head">
          <div class="sg-item-label">${esc(it.label)}${it.required ? '' : '<span class="sg-opt">optional</span>'}</div>
          <div class="sg-item-side">
            ${reviewing ? `<div class="sg-markbtns" role="group" aria-label="Mark ${esc(it.label)}">
                <button class="${mark === 'ok' ? 'on-ok' : ''}" onclick="Signoff.mark('${it.key}','ok')">OK</button>
                <button class="${mark === 'change' ? 'on-change' : ''}" onclick="Signoff.mark('${it.key}','change')">Needs change</button></div>`
              : markChip(mark)}
          </div>
        </div>
        <div class="sg-item-value">${valueHTML(it.key, rec)}</div>
        ${missing && s.status !== 'approved' ? `<div class="sg-missing">${esc(missing)}</div>` : ''}
        <div class="sg-thread">
          ${thread.map(noteHTML).join('')}
          ${canNote(s) ? `<button class="sg-addnote" onclick="Signoff.noteBox('${it.key}', this)">${thread.length ? 'Reply' : 'Add a note'}</button>` : ''}
        </div>
      </div>`;
    };

    const reviewSection = reviewing ? `
      <div class="sg-panel">
        <h3>Media head's section</h3>
        <label class="sg-field"><span>Approved budget <i>required to approve</i></span><input id="sg-r-budget" value="${esc(review.approvedBudget || '')}" placeholder="e.g. LKR 4,500,000" onchange="Signoff.saveReview()"></label>
        <label class="sg-field">Agreed KPIs<textarea id="sg-r-kpis" placeholder="e.g. CPM under LKR 90, VTR above 25%" onchange="Signoff.saveReview()">${esc(review.kpis || '')}</textarea></label>
        <label class="sg-field">Conditions of approval<textarea id="sg-r-conditions" placeholder="Anything that must happen before or during the campaign" onchange="Signoff.saveReview()">${esc(review.conditions || '')}</textarea></label>
        <div class="sg-decide">
          <button class="btn-primary" onclick="Signoff.approve()">Approve</button>
          <button class="btn-outline" onclick="Signoff.returnBox(this)">Send back for changes</button>
        </div>
        <div class="sg-return" id="sg-return" hidden>
          <label class="sg-field">What needs to change<textarea id="sg-return-note" placeholder="Optional if you have marked the items; it goes on the checklist as a note"></textarea></label>
          <div class="sg-decide"><button class="btn-primary" onclick="Signoff.sendBack()">Send back</button><button class="btn-outline" onclick="Signoff.returnBox()">Cancel</button></div>
        </div>
      </div>`
      : (has(review.approvedBudget) || has(review.kpis) || has(review.conditions)) ? `
      <div class="sg-panel">
        <h3>Media head's section</h3>
        <dl class="sg-dl sg-dl-stack">
          <dt>Approved budget</dt><dd>${has(review.approvedBudget) ? esc(review.approvedBudget) : '<span class="sg-none">Not filled in</span>'}</dd>
          ${has(review.kpis) ? `<dt>Agreed KPIs</dt><dd>${esc(review.kpis)}</dd>` : ''}
          ${has(review.conditions) ? `<dt>Conditions of approval</dt><dd>${esc(review.conditions)}</dd>` : ''}
        </dl>
      </div>` : '';

    const overall = notesBy._ || [];
    host().innerHTML = `<div class="sg-wrap sg-detail">
      <button class="sg-back" onclick="Signoff.render()">← All checklists</button>
      <div class="sg-detail-head">
        <div>
          <div class="sg-detail-kicker">${esc(s.brand_name)}${s.version > 1 ? ` · version ${s.version}` : ''}</div>
          <h2>${esc(s.campaign_name || 'Untitled campaign')}</h2>
          <div class="sg-detail-sub">Created by ${esc(s.created_by_name)} on ${fmtDate(s.created_at)} · ${goLiveTag(s)}</div>
        </div>
        <span class="sg-status ${st.cls}">${st.label}</span>
      </div>
      ${banner}
      <div class="sg-actions">${actions.join('')}</div>
      <div class="sg-detail-grid">
        <div class="sg-main">
          ${s.status !== 'approved' ? `<div class="sg-progress-row">${progressBar(s.progress)}<span class="sg-progress-note">required items filled in</span></div>` : ''}
          ${I.SECTIONS.map((sec) => `<section class="sg-section">
              <h3>${esc(sec.title)}</h3>
              ${I.ITEMS.filter((it) => it.section === sec.key).map(itemRow).join('')}
            </section>`).join('')}
        </div>
        <aside class="sg-side">
          ${reviewSection}
          <div class="sg-panel">
            <h3>Notes on the whole checklist</h3>
            <div class="sg-thread sg-thread-main">
              ${overall.map(noteHTML).join('') || '<div class="sg-none">No notes yet.</div>'}
              ${canNote(s) ? `<button class="sg-addnote" onclick="Signoff.noteBox('', this)">Add a note</button>` : ''}
            </div>
          </div>
          <div class="sg-panel">
            <h3>Activity</h3>
            <ol class="sg-log">${events.slice().reverse().map((e) => `<li><b>${esc(e.actor_name || e.actor)}</b> ${ACTION_WORDS[e.action] || esc(e.action)}${e.action === 'changes_requested' && e.detail && e.detail.items && e.detail.items.length ? ` (${plural(e.detail.items.length, 'item')})` : ''}<span>${fmtWhen(e.at)}</span></li>`).join('')}</ol>
          </div>
          ${versions.length > 1 ? `<div class="sg-panel"><h3>Versions</h3><ol class="sg-versions">${versions.map((v) =>
            `<li${v.id === s.id ? ' class="is-here"' : ''}>${v.id === s.id ? `<b>Version ${v.version}</b>` : `<a href="#" onclick="Signoff.open(${v.id});return false">Version ${v.version}</a>`} <span>${(STATUS[v.status] || {}).label || v.status}</span></li>`).join('')}</ol></div>` : ''}
        </aside>
      </div>
    </div>`;
  }

  const nameOf = (events, action) => { const e = events.slice().reverse().find((x) => x.action === action); return e && (e.actor_name || e.actor); };
  const canNote = (s) => s.status !== 'superseded' && (ME.reviewer || ME.canCreate);

  // ---- Notes ------------------------------------------------------------
  function noteBox(key, btn) {
    const wrap = btn.parentElement;
    if (wrap.querySelector('.sg-notebox')) { wrap.querySelector('textarea').focus(); return; }
    const box = document.createElement('div');
    box.className = 'sg-notebox';
    box.innerHTML = `<textarea placeholder="Write a note" maxlength="2000"></textarea>
      <div><button class="btn-primary">Add note</button><button class="btn-outline">Cancel</button></div>`;
    const [save, cancel] = box.querySelectorAll('button');
    cancel.onclick = () => { box.remove(); btn.hidden = false; };
    save.onclick = async () => {
      const body = box.querySelector('textarea').value.trim();
      if (!body) return;
      save.disabled = true;
      try {
        const d = await api('POST', `/api/signoffs/${CURRENT.signoff.id}/notes`, { item_key: key || null, body });
        CURRENT.notes.push(d.note);
        drawDetail();
        const target = key ? document.getElementById(`sg-item-${key}`) : document.querySelector('.sg-thread-main');
        if (target) target.scrollIntoView({ block: 'nearest' });
      } catch (e) { say(e.message, 'error'); save.disabled = false; }
    };
    btn.hidden = true;
    wrap.appendChild(box);
    box.querySelector('textarea').focus();
  }

  // ---- Media head --------------------------------------------------------
  function reviewBody() {
    const g = (id) => (document.getElementById(id) || {}).value || '';
    return { approvedBudget: g('sg-r-budget'), kpis: g('sg-r-kpis'), conditions: g('sg-r-conditions'), items: (CURRENT.signoff.review || {}).items || {} };
  }

  async function mark(key, value) {
    const s = CURRENT.signoff;
    const items = Object.assign({}, (s.review || {}).items);
    items[key] = items[key] === value ? null : value;
    const body = Object.assign(reviewBody(), { items });
    try {
      const d = await api('PUT', `/api/signoffs/${s.id}/review`, body);
      s.review = d.review;
      const y = window.scrollY;
      drawDetail();
      window.scrollTo({ top: y });
    } catch (e) { say(e.message, 'error'); }
  }

  async function saveReview() {
    const s = CURRENT.signoff;
    try {
      const d = await api('PUT', `/api/signoffs/${s.id}/review`, reviewBody());
      s.review = d.review;
    } catch (e) { say(e.message, 'error'); }
  }

  function returnBox() {
    const box = document.getElementById('sg-return');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector('textarea').focus();
  }

  async function sendBack() {
    const s = CURRENT.signoff;
    const note = (document.getElementById('sg-return-note') || {}).value || '';
    try {
      await api('POST', `/api/signoffs/${s.id}/return`, Object.assign(reviewBody(), { note }));
      say('Sent back for changes.');
      open(s.id);
      refreshBadge();
    } catch (e) { say(e.message, 'error'); }
  }

  async function approve() {
    const s = CURRENT.signoff;
    const body = reviewBody();
    if (!body.approvedBudget.trim()) { say('Fill in the approved budget before approving.', 'error'); document.getElementById('sg-r-budget').focus(); return; }
    try {
      const d = await api('POST', `/api/signoffs/${s.id}/approve`, body);
      say(`Approved. ${d.campaign} is now a campaign in Campaign Lens.`);
      if (typeof loadCampaigns === 'function') { try { loadCampaigns(); } catch (e) { /* the hub reloads them on its own */ } }
      open(s.id);
      refreshBadge();
    } catch (e) { say(e.message, 'error'); }
  }

  // ---- Creators: detail actions -------------------------------------------
  async function submitFromDetail() {
    const s = CURRENT.signoff;
    try {
      await api('POST', `/api/signoffs/${s.id}/submit`, {});
      say('Sent to the media head.');
      open(s.id);
      refreshBadge();
    } catch (e) {
      if (e.data && e.data.problems) { say(`${plural(e.data.problems.length, 'item')} still to fill in. Edit the checklist to finish them.`, 'error'); }
      else say(e.message, 'error');
    }
  }

  async function remove() {
    const s = CURRENT.signoff;
    if (!confirmInline(`Delete the draft for ${s.campaign_name}? This can't be undone.`)) return;
    try { await api('DELETE', `/api/signoffs/${s.id}`); say('Draft deleted.'); render(); }
    catch (e) { say(e.message, 'error'); }
  }
  // A plain confirm for the one action that cannot be undone.
  const confirmInline = (msg) => window.confirm(msg);

  async function duplicate() {
    const s = CURRENT.signoff;
    try { const d = await api('POST', `/api/signoffs/${s.id}/duplicate`, {}); say('Copied into a new draft.'); await open(d.id); edit(); }
    catch (e) { say(e.message, 'error'); }
  }

  async function amend() {
    const s = CURRENT.signoff;
    try { const d = await api('POST', `/api/signoffs/${s.id}/amend`, {}); say(`Version ${s.version + 1} started. Edit it and send it for approval.`); await open(d.id); edit(); }
    catch (e) { if (e.data && e.data.id) { say('An amendment is already open.'); open(e.data.id); } else say(e.message, 'error'); }
  }

  // =======================================================================
  //  FORM
  // =======================================================================
  async function create() {
    await loadBrands();
    DRAFT = {
      id: null, brand_id: BRANDS.length === 1 ? BRANDS[0].id : '',
      meta: { campaignName: '', market: 'Sri Lanka', goLive: '', clientLead: '', variant: '', format: '', datePrepared: I.todayIso() },
      fields: I.blankFields(), review: {}, notes: [],
    };
    drawForm();
  }

  function edit() {
    const s = CURRENT.signoff;
    const rec = asRecord(s);
    DRAFT = { id: s.id, status: s.status, version: s.version, brand_id: s.brand_id, meta: Object.assign({}, rec.meta),
              fields: JSON.parse(JSON.stringify(Object.assign(I.blankFields(), rec.fields))), review: s.review || {}, notes: CURRENT.notes || [] };
    drawForm();
  }

  function drawForm() {
    const d = DRAFT, f = d.fields, m = d.meta;
    const marks = (d.review || {}).items || {};
    const notesFor = (k) => (d.notes || []).filter((n) => n.item_key === k && n.is_reviewer);
    // An item the media head flagged carries his mark and notes into the form.
    const flag = (k) => {
      if (marks[k] !== 'change' && marks[k] !== 'recheck') return '';
      const ns = notesFor(k);
      return `<div class="sg-flag"><b>${marks[k] === 'change' ? 'The media head asked for a change here.' : 'Changed since the last review.'}</b>${ns.map((n) => `<div>${esc(n.body)}</div>`).join('')}</div>`;
    };
    const seg = (group, key, val, opts, fn) => `<div class="so-seg" data-group="${group}.${key}">${opts.map((o) =>
      `<button type="button" class="so-seg-btn${val === o ? ' active' : ''}" onclick="Signoff.${fn}('${group}','${key}','${o}',this)">${o}</button>`).join('')}</div>`;
    const chips = (group, key, vals, opts) => `<div class="so-chips">${opts.map((o) =>
      `<button type="button" class="so-chip${(vals || []).includes(o) ? ' active' : ''}" onclick="Signoff.chip('${group}','${key}','${o}',this)">${o}</button>`).join('')}</div>`;
    const itemWrap = (k, label, inner) => `<div class="so-item sg-fitem${marks[k] === 'change' ? ' is-change' : ''}" data-item="${k}">
      <div class="so-item-label">${label}</div>${flag(k)}${inner}</div>`;
    const firstDraft = !d.id || (d.status === 'draft' && d.version === 1);

    host().innerHTML = `<div class="sg-wrap sg-form">
      <button class="sg-back" onclick="${d.id ? `Signoff.open(${d.id})` : 'Signoff.render()'}">← ${d.id ? 'Back to the checklist' : 'All checklists'}</button>
      <div class="sg-form-head">
        <div><h2>${d.id ? 'Edit checklist' : 'New checklist'}</h2>
          <div class="sg-detail-sub">Save as you go. Send it to the media head when every required item is filled in.</div></div>
        <div class="sg-form-prog" id="sg-form-prog"></div>
      </div>

      <div class="so-card">
        <div class="so-sec-title">Campaign details</div>
        ${flag('details')}
        <div class="so-meta-form">
          <label>Campaign name<input data-meta="campaignName" value="${esc(m.campaignName)}" placeholder="e.g. Surf Excel x FIFA WC 2026"></label>
          <label>Brand
            <select data-brand ${firstDraft ? '' : 'disabled'}>
              <option value="">Pick a brand</option>
              ${BRANDS.map((b) => `<option value="${esc(b.id)}"${d.brand_id === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
          </label>
          <label>Market<input data-meta="market" value="${esc(m.market)}"></label>
          <label>Go-live target<input data-meta="goLive" type="date" value="${esc(m.goLive)}"></label>
          <label>Client lead<input data-meta="clientLead" value="${esc(m.clientLead)}" placeholder="Name"></label>
          <label>Variant (product)<input data-meta="variant" value="${esc(m.variant)}" placeholder="e.g. Surf Excel Liquid"></label>
          <label>Format (product)<input data-meta="format" value="${esc(m.format)}" placeholder="e.g. 500ml pouch"></label>
          <label>Date prepared<input data-meta="datePrepared" type="date" value="${esc(m.datePrepared)}"></label>
        </div>
      </div>

      <div class="so-card">
        <div class="so-sec-title">Funnel plan</div>
        ${itemWrap('funnel_types', 'Campaign types across the funnel', `
          <div class="so-funnel-row"><span class="so-ftag so-ftag-t">TOFU</span><input data-f="funnel.tofu" value="${esc(f.funnel.tofu)}" placeholder="e.g. Reach and frequency, video views"></div>
          <div class="so-funnel-row"><span class="so-ftag so-ftag-m">MOFU</span><input data-f="funnel.mofu" value="${esc(f.funnel.mofu)}" placeholder="e.g. Engagement, traffic, ThruPlay"></div>
          <div class="so-funnel-row"><span class="so-ftag so-ftag-b">BOFU</span><input data-f="funnel.bofu" value="${esc(f.funnel.bofu)}" placeholder="e.g. Conversions, catalogue sales"></div>`)}
        ${itemWrap('funnel_budget', 'Budget split across funnel areas <span class="sg-hint" id="sg-budget-sum"></span>', `
          <div class="so-tri-inputs">
            <label>TOFU %<input data-f="funnel.budget.tofu" type="number" min="0" max="100" value="${esc(f.funnel.budget.tofu)}"></label>
            <label>MOFU %<input data-f="funnel.budget.mofu" type="number" min="0" max="100" value="${esc(f.funnel.budget.mofu)}"></label>
            <label>BOFU %<input data-f="funnel.budget.bofu" type="number" min="0" max="100" value="${esc(f.funnel.budget.bofu)}"></label>
          </div>`)}
        ${itemWrap('funnel_bid', 'Bidding metrics by funnel', Object.entries(I.FUNNEL_BID).map(([stage, opts]) => `
          <div class="so-bid-row"><span class="so-bid-name">${stage}</span>${seg('bid', stage, f.funnel.bid[stage], opts, 'bid')}</div>`).join(''))}
      </div>

      <div class="so-card">
        <div class="so-sec-title">Estimated delivery</div>
        ${itemWrap('delivery', 'Fill in the estimates that apply', `<div class="so-egrid">${I.DELIVERY_FIELDS.map(([k, l]) =>
          `<label>${l}<input data-f="delivery.${k}" value="${esc(f.delivery[k] || '')}" placeholder="—"></label>`).join('')}</div>`)}
      </div>

      <div class="so-card">
        <div class="so-sec-title">Setup and targeting</div>
        ${itemWrap('audience', 'Audience specification done?', seg('setup', 'audienceDone', f.setup.audienceDone, I.YES_NO, 'pick'))}
        ${itemWrap('dates', 'Start and end dates', `<div class="so-dates"><input data-f="setup.startDate" type="date" value="${esc(f.setup.startDate)}" aria-label="Start date"><input data-f="setup.endDate" type="date" value="${esc(f.setup.endDate)}" aria-label="End date"></div>`)}
        ${itemWrap('tg_size', 'TG size', `<input data-f="setup.tgSize" value="${esc(f.setup.tgSize)}" placeholder="e.g. 2.4M">`)}
        ${itemWrap('creative_types', 'Creative types', chips('setup', 'creativeTypes', f.setup.creativeTypes, I.CREATIVE_TYPES))}
        ${itemWrap('landing_links', 'Landing page links', `<textarea data-f="setup.landingLinks" placeholder="Paste landing page or destination links, or write N/A">${esc(f.setup.landingLinks)}</textarea>`)}
      </div>

      <div class="so-card">
        <div class="so-sec-title">Costs and allocations</div>
        ${itemWrap('cost_platform', 'Platform costs', `<input data-f="costs.platform" value="${esc(f.costs.platform)}" placeholder="e.g. LKR 450,000">`)}
        ${itemWrap('cost_data', 'Data costs', `<input data-f="costs.data" value="${esc(f.costs.data)}" placeholder="Amount, or N/A">`)}
        ${itemWrap('cost_adserving', 'Ad serving costs', `<input data-f="costs.adServing" value="${esc(f.costs.adServing)}" placeholder="Amount, or N/A">`)}
        ${itemWrap('cost_verification', 'Verification costs included?', seg('costs', 'verification', f.costs.verification, I.YES_NO, 'pick'))}
        ${itemWrap('cost_1pd', '1PD data allocation done?', seg('costs', 'pd1', f.costs.pd1, I.YES_NO, 'pick'))}
        ${itemWrap('cost_retainer', 'Retainer payment allocated?', seg('costs', 'retainer', f.costs.retainer, I.YES_NO, 'pick'))}
        ${itemWrap('cost_ustore', 'uStore allocation done?', seg('costs', 'ustore', f.costs.ustore, I.YES_NO, 'pick'))}
        ${itemWrap('cost_google', 'Google allocation', chips('costs', 'google', f.costs.google, I.GOOGLE_ALLOC))}
        ${itemWrap('cost_other', 'Other costs <span class="sg-opt">optional</span>', `<textarea data-f="costs.other" placeholder="Any other costs">${esc(f.costs.other)}</textarea>`)}
      </div>

      <div class="sg-problems" id="sg-problems" hidden></div>
      <div class="sg-form-bar">
        <button class="btn-outline" onclick="${d.id ? `Signoff.open(${d.id})` : 'Signoff.render()'}">Cancel</button>
        <button class="btn-outline" onclick="Signoff.save()">Save draft</button>
        <button class="btn-primary" onclick="Signoff.submitForm()">Send to media head</button>
      </div>
    </div>`;

    host().querySelectorAll('[data-meta],[data-f],[data-brand]').forEach((el) => {
      el.addEventListener('input', () => { readForm(); updateFormProgress(); });
      el.addEventListener('change', () => { readForm(); updateFormProgress(); });
    });
    updateFormProgress();
    window.scrollTo({ top: 0 });
  }

  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts.at(-1)] = val;
  }

  function readForm() {
    const el = host();
    el.querySelectorAll('[data-meta]').forEach((i) => { DRAFT.meta[i.dataset.meta] = i.value; });
    el.querySelectorAll('[data-f]').forEach((i) => setPath(DRAFT.fields, i.dataset.f, i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value));
    const b = el.querySelector('[data-brand]');
    if (b && !b.disabled) DRAFT.brand_id = b.value;
  }

  function updateFormProgress() {
    const rec = { brand_id: DRAFT.brand_id, meta: DRAFT.meta, fields: DRAFT.fields };
    const p = I.progress(rec);
    const box = document.getElementById('sg-form-prog');
    if (box) box.innerHTML = progressBar(p);
    const b = DRAFT.fields.funnel.budget;
    const sum = (Number(b.tofu) || 0) + (Number(b.mofu) || 0) + (Number(b.bofu) || 0);
    const hint = document.getElementById('sg-budget-sum');
    if (hint) { hint.textContent = `adds up to ${Math.round(sum * 10) / 10}%`; hint.classList.toggle('is-off', Math.abs(sum - 100) > 0.01); }
    host().querySelectorAll('.sg-fitem').forEach((el) => {
      const it = I.ITEMS.find((i) => i.key === el.dataset.item);
      el.classList.toggle('is-done', !!it && it.required && !it.problem(rec));
    });
  }

  function bid(_g, stage, val, btn) {
    DRAFT.fields.funnel.bid[stage] = DRAFT.fields.funnel.bid[stage] === val ? null : val;
    btn.parentElement.querySelectorAll('.so-seg-btn').forEach((x) => x.classList.toggle('active', x === btn && DRAFT.fields.funnel.bid[stage] === val));
    updateFormProgress();
  }
  function pick(group, key, val, btn) {
    DRAFT.fields[group][key] = DRAFT.fields[group][key] === val ? null : val;
    btn.parentElement.querySelectorAll('.so-seg-btn').forEach((x) => x.classList.toggle('active', x === btn && DRAFT.fields[group][key] === val));
    updateFormProgress();
  }
  function chip(group, key, val, btn) {
    let arr = DRAFT.fields[group][key] || [];
    if (arr.includes(val)) arr = arr.filter((x) => x !== val);
    else if (val === 'Not used') arr = ['Not used'];
    else arr = arr.filter((x) => x !== 'Not used').concat(val);
    DRAFT.fields[group][key] = arr;
    btn.parentElement.querySelectorAll('.so-chip').forEach((x) => x.classList.toggle('active', arr.includes(x.textContent)));
    updateFormProgress();
  }

  function body() {
    return { brand_id: DRAFT.brand_id, meta: DRAFT.meta, fields: DRAFT.fields };
  }

  /** Save; returns the id. A new checklist needs a name and a brand first. */
  async function persist() {
    readForm();
    if (!DRAFT.meta.campaignName.trim()) throw new Error('Give the campaign a name first.');
    if (!DRAFT.brand_id) throw new Error('Pick a brand first.');
    if (!DRAFT.id) {
      const d = await api('POST', '/api/signoffs', body());
      DRAFT.id = d.id; DRAFT.status = 'draft'; DRAFT.version = 1;
    } else {
      await api('PUT', `/api/signoffs/${DRAFT.id}`, body());
    }
    return DRAFT.id;
  }

  async function save() {
    try { await persist(); say('Draft saved.'); open(DRAFT.id); }
    catch (e) { say(e.message, 'error'); }
  }

  async function submitForm() {
    readForm();
    const problems = I.submitProblems({ brand_id: DRAFT.brand_id, meta: DRAFT.meta, fields: DRAFT.fields });
    const box = document.getElementById('sg-problems');
    if (problems.length) {
      box.hidden = false;
      box.innerHTML = `<b>${plural(problems.length, 'item')} to finish before this can be sent:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
      box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try { if (DRAFT.meta.campaignName.trim() && DRAFT.brand_id) await persist(); } catch (e) { /* kept on screen anyway */ }
      return;
    }
    box.hidden = true;
    try {
      const id = await persist();
      await api('POST', `/api/signoffs/${id}/submit`, body());
      say('Sent to the media head.');
      open(id);
      refreshBadge();
    } catch (e) {
      if (e.data && e.data.problems) {
        box.hidden = false;
        box.innerHTML = `<b>${esc(e.message)}</b><ul>${e.data.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
      } else say(e.message, 'error');
    }
  }

  // =======================================================================
  //  PDF: a clean printable copy in a new window
  // =======================================================================
  function pdf() {
    const { signoff: s, notes, events } = CURRENT;
    const rec = asRecord(s);
    const review = s.review || {};
    const marks = review.items || {};
    const st = STATUS[s.status] || { label: s.status };
    const w = window.open('', '_blank');
    if (!w) { say('Allow pop-ups for Campaign Lens to download the PDF.', 'error'); return; }
    const markWord = (k) => ({ ok: 'OK', change: 'Needs change', recheck: 'Updated' })[marks[k]] || '';
    const rows = I.SECTIONS.map((sec) => `<h2>${esc(sec.title)}</h2><table>${I.ITEMS.filter((i) => i.section === sec.key).map((it) => `
      <tr><th>${esc(it.label)}</th><td>${valueHTML(it.key, rec)}${(notes.filter((n) => n.item_key === it.key)).map((n) => `<div class="n"><b>${esc(n.author_name || n.author)}:</b> ${esc(n.body)}</div>`).join('')}</td><td class="m">${markWord(it.key)}</td></tr>`).join('')}</table>`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.campaign_name)} sign-off</title>
      <style>
        body{font:13px/1.45 -apple-system,Segoe UI,Arial,sans-serif;color:#111318;margin:32px}
        h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 6px;color:#0F6E8C}
        .sub{color:#646A76;margin-bottom:14px} .st{display:inline-block;padding:3px 10px;border-radius:99px;background:#E7F4EE;color:#1F8A5B;font-weight:600;font-size:12px}
        table{width:100%;border-collapse:collapse} th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid #E4E6EA}
        th{width:34%;font-weight:600;color:#2E323A} td.m{width:90px;color:#1F8A5B;font-weight:600}
        dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0} dt{color:#646A76} dd{margin:0}
        .sg-none{color:#8A909B} .sg-tag{display:inline-block;margin-right:6px} .sg-split span{margin-right:14px}
        .n{color:#4B505B;font-size:12px;margin-top:4px} .box{border:1px solid #E4E6EA;border-radius:8px;padding:10px 12px;margin-top:8px}
        a{color:#0F6E8C;word-break:break-all}
      </style></head><body>
      <h1>${esc(s.campaign_name)}</h1>
      <div class="sub">${esc(s.brand_name)}${s.version > 1 ? ` · version ${s.version}` : ''} · Campaign sign-off · <span class="st">${esc(st.label)}</span></div>
      ${s.status === 'approved' ? `<div class="box">Approved by ${esc(nameOf(events, 'approved') || s.approved_by)} on ${fmtDate(s.approved_at)}</div>` : ''}
      ${has(review.approvedBudget) || has(review.kpis) || has(review.conditions) ? `<h2>Media head's section</h2><table>
        <tr><th>Approved budget</th><td>${esc(review.approvedBudget || '')}</td><td></td></tr>
        ${has(review.kpis) ? `<tr><th>Agreed KPIs</th><td>${esc(review.kpis)}</td><td></td></tr>` : ''}
        ${has(review.conditions) ? `<tr><th>Conditions of approval</th><td>${esc(review.conditions)}</td><td></td></tr>` : ''}</table>` : ''}
      ${rows}
      <h2>Activity</h2><table>${events.map((e) => `<tr><th>${fmtWhen(e.at)}</th><td>${esc(e.actor_name || e.actor)} ${ACTION_WORDS[e.action] || esc(e.action)}</td><td></td></tr>`).join('')}</table>
      <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
      </body></html>`);
    w.document.close();
  }

  window.Signoff = {
    render, open, filter, create, edit, save, submitForm, submitFromDetail, remove, duplicate, amend,
    mark, saveReview, returnBox, sendBack, approve, noteBox, pdf, bid, pick, chip, refreshBadge,
  };
})();

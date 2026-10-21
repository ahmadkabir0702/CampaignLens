/**
 * repurpose.js — Assign agency for repurposing
 *
 *   panelBlock(d)  the "Repurposing" block in a creative's detail panel:
 *                  assign (agency + due date), or the open request with
 *                  the actions this account has, and past requests
 *   render()       the Repurposing section: every request this account
 *                  can see, in three columns, with agency turnaround
 *   card tags      "With Litmus · due 3 Nov" on Creative Hub cards
 *
 * Unilever and Mindshare assign; the agency marks done; Unilever approves
 * or reopens with a note; the media head only looks. The server
 * (server/repurpose/routes.js) enforces all of it.
 */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isoDay = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && d.length <= 10) return d;
    return new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  };
  const fmt = (d) => { const s = isoDay(d); if (!s) return ''; const [, m, day] = s.split('-').map(Number); return `${day} ${MON[m - 1]}`; };
  const fmtY = (d) => { const s = isoDay(d); return s ? `${fmt(s)} ${s.slice(0, 4)}` : ''; };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : alert(m));
  let TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error(data.error || 'Could not reach the server. Try again.');
    return data;
  }

  /** Due date with its warning: amber within 2 days, red when passed. */
  function dueTag(t) {
    const due = isoDay(t.due_date);
    if (t.status === 'approved') return `<span class="rp-due">Due ${fmt(due)}</span>`;
    const left = daysBetween(TODAY, due);
    if (t.status === 'assigned' && left < 0) return `<span class="rp-due is-late">Overdue · was due ${fmt(due)}</span>`;
    if (t.status === 'assigned' && left <= 2) return `<span class="rp-due is-soon">Due ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : fmt(due)}</span>`;
    return `<span class="rp-due">Due ${fmt(due)}</span>`;
  }
  const STATUS = {
    assigned: { label: 'With agency', cls: 'sg-st-review' },
    done: { label: 'Done, waiting for approval', cls: 'sg-st-changes' },
    approved: { label: 'Approved', cls: 'sg-st-approved' },
    cancelled: { label: 'Withdrawn', cls: 'sg-st-old' },
  };
  const WORDS = { assigned: 'assigned it', done: 'marked it done', approved: 'approved it', reopened: 'reopened it', cancelled: 'withdrew it', due_changed: 'changed the due date' };

  // =======================================================================
  //  Creative panel block
  // =======================================================================
  let PANEL = { id: null, data: null };

  function panelBlock(d) {
    if (!d || !d.id) return '';
    PANEL = { id: d.id, data: null };
    setTimeout(() => loadPanel(d.id), 0);
    return `<section class="rp-panel" id="rp-panel" aria-busy="true">
      <div class="rp-panel-head"><h4>Repurposing</h4></div>
      <div class="sk" style="width:56%;height:12px;margin-bottom:9px"></div><div class="sk" style="width:38%;height:12px"></div></section>`;
  }

  async function loadPanel(id) {
    try {
      const data = await api('GET', `/api/repurpose/creative/${encodeURIComponent(id)}`);
      if (PANEL.id !== id) return;
      PANEL.data = data;
      if (data.today) TODAY = data.today;
      drawPanel();
    } catch (e) {
      const el = document.getElementById('rp-panel');
      if (el && PANEL.id === id) el.outerHTML = '';
    }
  }

  function drawPanel() {
    const el = document.getElementById('rp-panel');
    if (!el) return;
    const { tasks, events, me, eligible, reason, agencies } = PANEL.data;
    const open = tasks.find((t) => t.status === 'assigned' || t.status === 'done');
    const past = tasks.filter((t) => t !== open && t.status !== 'cancelled');
    const evFor = (id) => events.filter((e) => e.task_id === id);
    let body = '';

    if (open) {
      const st = STATUS[open.status];
      const reopen = open.status === 'assigned' && open.reopened && open.last_reopen_note
        ? `<div class="rp-note"><b>Reopened:</b> ${esc(open.last_reopen_note)}</div>` : '';
      const doneNote = (() => { const e = evFor(open.id).filter((x) => x.action === 'done').pop(); return open.status === 'done' && e && e.note ? `<div class="rp-note rp-note-agency"><b>${esc(e.actor_name)}:</b> ${esc(e.note)}</div>` : ''; })();
      const acts = [];
      if (me.isAgency && open.status === 'assigned') acts.push(`<button class="btn-primary" data-press onclick="Repurpose.doneBox(this, ${open.id})">Mark done</button>`);
      if (me.canApprove && open.status === 'done') {
        acts.push(`<button class="btn-primary" data-press onclick="Repurpose.approve(${open.id})">Approve</button>`);
        acts.push(`<button class="btn-outline" data-press onclick="Repurpose.reopenBox(this, ${open.id})">Reopen</button>`);
      }
      if (me.canAssign) {
        acts.push(`<button class="btn-outline" data-press onclick="Repurpose.dueBox(this, ${open.id}, '${isoDay(open.due_date)}')">Change due date</button>`);
        acts.push(`<button class="btn-outline rp-quiet" data-press onclick="Repurpose.cancel(${open.id})">Withdraw</button>`);
      }
      body = `<div class="rp-open">
          <div class="rp-open-top"><span class="sg-status ${st.cls}">${st.label}</span>${dueTag(open)}</div>
          <div class="rp-open-line">With <b>${esc(open.agency_name)}</b> · assigned by ${esc(open.assigned_by_name)} on ${fmtY(open.assigned_at)}${open.reopened ? ` · reopened ${plural(open.reopened, 'time')}` : ''}</div>
          ${reopen}${doneNote}
          ${acts.length ? `<div class="rp-acts">${acts.join('')}</div>` : ''}
          <div class="rp-box" hidden></div>
        </div>`;
    } else if (me.canAssign) {
      if (!eligible) body = `<div class="rp-muted">${esc(reason)}</div>`;
      else if (!agencies.length) body = `<div class="rp-muted">No agency has a login for this brand yet, so there is no one to assign it to.</div>`;
      else {
        const min = TODAY;
        const def = new Date(Date.parse(TODAY) + 7 * 86400000).toISOString().slice(0, 10);
        body = `<div class="rp-assign">
          <label>Agency<select id="rp-agency">${agencies.length > 1 ? '<option value="">Pick an agency</option>' : ''}${agencies.map((a) => `<option value="${esc(a.key)}">${esc(a.name)}</option>`).join('')}</select></label>
          <label>Due date<input id="rp-due" type="date" min="${min}" value="${def}"></label>
          <button class="btn-primary" data-press onclick="Repurpose.assign('${esc(PANEL.id)}')">Assign agency for repurposing</button>
        </div>`;
      }
    } else {
      body = `<div class="rp-muted">${me.isAgency ? 'Not assigned to your agency.' : 'Not assigned to an agency.'}</div>`;
    }

    const history = past.length ? `<div class="rp-history"><div class="rp-history-title">Earlier requests</div>${past.map((t) =>
      `<div class="rp-history-row"><span>${esc(t.agency_name)}</span><span>${t.status === 'approved' ? `approved by ${esc(t.approved_by_name)} on ${fmtY(t.approved_at)}` : esc(STATUS[t.status].label)}</span></div>`).join('')}</div>` : '';
    const log = open ? `<details class="rp-log"><summary>Activity</summary><ol>${evFor(open.id).slice().reverse().map((e) =>
      `<li><b>${esc(e.actor_name || e.actor)}</b> ${WORDS[e.action] || esc(e.action)}${e.note && e.action !== 'reopened' ? `: ${esc(e.note)}` : ''}${e.action === 'reopened' ? `: ${esc(e.note)}` : ''}<span>${fmtY(e.at)}</span></li>`).join('')}</ol></details>` : '';

    el.removeAttribute('aria-busy');
    el.innerHTML = `<div class="rp-panel-head"><h4>Repurposing</h4></div>${body}${log}${history}`;
  }

  function inlineBox(btn, html, onSave) {
    const box = btn.closest('.rp-open, .sg-card, .rp-card').querySelector('.rp-box');
    if (!box) return;
    if (!box.hidden && box.dataset.kind === html.kind) { box.hidden = true; return; }
    box.dataset.kind = html.kind;
    box.innerHTML = html.body + `<div class="rp-box-acts"><button class="btn-primary" data-press>${html.ok}</button><button class="btn-outline" data-press>Cancel</button></div>`;
    box.hidden = false;
    const [ok, cancel] = box.querySelectorAll('.rp-box-acts button');
    cancel.onclick = (e) => { e.stopPropagation(); box.hidden = true; };
    ok.onclick = async (e) => { e.stopPropagation(); ok.disabled = true; try { await onSave(box); } finally { ok.disabled = false; } };
    box.onclick = (e) => e.stopPropagation();
    const f = box.querySelector('textarea, input');
    if (f) f.focus();
  }

  async function after(msg) {
    say(msg);
    loadOpen(true);
    refreshBadge();
    if (PANEL.id && document.getElementById('rp-panel')) loadPanel(PANEL.id);
    if (document.getElementById('page-repurpose') && !document.getElementById('page-repurpose').classList.contains('hidden')) render(true);
  }

  async function assign(creativeId) {
    const agency = (document.getElementById('rp-agency') || {}).value;
    const due = (document.getElementById('rp-due') || {}).value;
    if (!agency) return say('Pick an agency.', 'error');
    if (!due) return say('Pick a due date.', 'error');
    try { await api('POST', '/api/repurpose', { creative_id: creativeId, agency_key: agency, due_date: due }); after('Assigned for repurposing.'); }
    catch (e) { say(e.message, 'error'); }
  }

  function doneBox(btn, id) {
    inlineBox(btn, { kind: 'done', ok: 'Mark done', body: '<label class="rp-label">Note for Unilever <i>optional</i><textarea maxlength="1000" placeholder="Anything they should know"></textarea></label>' },
      async (box) => {
        try { await api('POST', `/api/repurpose/${id}/done`, { note: box.querySelector('textarea').value }); after('Marked done. Unilever will review it.'); }
        catch (e) { say(e.message, 'error'); }
      });
  }
  function reopenBox(btn, id) {
    inlineBox(btn, { kind: 'reopen', ok: 'Reopen', body: '<label class="rp-label">What is still to be done<textarea maxlength="1000" placeholder="Tell the agency what is missing"></textarea></label>' },
      async (box) => {
        const note = box.querySelector('textarea').value.trim();
        if (!note) return say('Say what is still to be done.', 'error');
        try { await api('POST', `/api/repurpose/${id}/reopen`, { note }); after('Reopened. It is back with the agency.'); }
        catch (e) { say(e.message, 'error'); }
      });
  }
  function dueBox(btn, id, current) {
    inlineBox(btn, { kind: 'due', ok: 'Save', body: `<label class="rp-label">New due date<input type="date" min="${TODAY}" value="${esc(current)}"></label>` },
      async (box) => {
        try { await api('POST', `/api/repurpose/${id}/due`, { due_date: box.querySelector('input').value }); after('Due date changed.'); }
        catch (e) { say(e.message, 'error'); }
      });
  }
  async function approve(id) {
    try { await api('POST', `/api/repurpose/${id}/approve`, {}); after('Approved. The request is complete.'); }
    catch (e) { say(e.message, 'error'); }
  }
  async function cancel(id) {
    if (!window.confirm('Withdraw this request from the agency?')) return;
    try { await api('POST', `/api/repurpose/${id}/cancel`, {}); after('Request withdrawn.'); }
    catch (e) { say(e.message, 'error'); }
  }

  // =======================================================================
  //  Creative Hub card tags
  // =======================================================================
  let OPEN = new Map();
  let openLoaded = null;
  async function loadOpen(force) {
    if (openLoaded && !force) return openLoaded;
    openLoaded = api('GET', '/api/repurpose/open').then((d) => {
      if (d.today) TODAY = d.today;
      OPEN = new Map((d.open || []).map((t) => [t.creative_id, t]));
      decorate();
    }).catch(() => {});
    return openLoaded;
  }
  function tagFor(t) {
    if (t.status === 'done') return `<span class="rp-tag is-done">${esc(t.agency_name)} done, awaiting approval</span>`;
    const late = isoDay(t.due_date) < TODAY;
    return `<span class="rp-tag${late ? ' is-late' : ''}">With ${esc(t.agency_name)} · ${late ? 'overdue' : `due ${fmt(t.due_date)}`}</span>`;
  }
  function decorate() {
    document.querySelectorAll('#card-grid .card').forEach((card) => {
      const m = (card.getAttribute('onclick') || '').match(/selectCard\('([^']+)'/);
      const old = card.querySelector('.rp-tag');
      const t = m && OPEN.get(m[1]);
      if (!t) { if (old) old.remove(); return; }
      const html = tagFor(t);
      if (old) { if (old.outerHTML !== html) old.outerHTML = html; return; }
      const tags = card.querySelector('.card-tags');
      if (tags) tags.insertAdjacentHTML('beforeend', html);
    });
  }
  function watchGrid() {
    const grid = document.getElementById('card-grid');
    if (!grid || grid._rpWatch) return;
    grid._rpWatch = true;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; decorate(); });
    }).observe(grid, { childList: true });
  }

  // =======================================================================
  //  The Repurposing section
  // =======================================================================
  let LIST = null;
  const F = { agency: '', brand: '', overdue: false, q: '' };
  const host = () => document.getElementById('page-repurpose');

  function skeleton() {
    const card = (i) => `<div class="sg-card sg-card-sk"><div class="sk" style="width:${[36, 44, 30][i % 3]}%;height:10px;margin-bottom:9px"></div>
      <div class="sk" style="width:${[74, 62, 68][i % 3]}%;height:14px;margin-bottom:10px"></div><div class="sk" style="width:${[52, 46, 58][i % 3]}%;height:10px"></div></div>`;
    return `<div class="sg-wrap" aria-busy="true">
      <div class="rp-perf">${[0, 1, 2, 3].map(() => `<div class="sk-card"><div class="sk" style="width:50%;height:12px;margin-bottom:12px"></div><div class="sk" style="width:70%;height:22px"></div></div>`).join('')}</div>
      <div class="sg-toolbar"><div class="sg-tools"><div class="sk" style="width:150px;height:38px;border-radius:8px"></div><div class="sk" style="width:150px;height:38px;border-radius:8px"></div><div class="sk" style="width:240px;height:38px;border-radius:8px"></div></div></div>
      <div class="sg-board rp-board">${[3, 2, 2].map((n, c) => `<section class="sg-col"><header><div class="sk" style="width:${[86, 150, 70][c]}px;height:12px"></div></header>
        <div class="sg-col-body">${Array.from({ length: n }, (_, i) => card(i + c)).join('')}</div></section>`).join('')}</div></div>`;
  }

  async function render(quiet) {
    const el = host();
    if (!el) return;
    if (!quiet || !LIST) el.innerHTML = skeleton();
    try {
      LIST = await api('GET', '/api/repurpose');
      if (LIST.today) TODAY = LIST.today;
    } catch (e) {
      el.innerHTML = `<div class="sg-wrap"><div class="load-msg load-msg-error">Couldn't load repurposing requests. ${esc(e.message)}
        <button class="load-retry" onclick="Repurpose.render()">Try again</button></div></div>`;
      return;
    }
    draw(!quiet);
    refreshBadge();
  }

  function draw(arrive) {
    const el = host();
    const { tasks, perf, me } = LIST;
    const agencies = [...new Set(tasks.map((t) => t.agency_name))].sort();
    const brands = [...new Map(tasks.map((t) => [t.brand_id, t.brand_name || t.brand_id])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const q = F.q.trim().toLowerCase();
    const rows = tasks
      .filter((t) => !F.agency || t.agency_name === F.agency)
      .filter((t) => !F.brand || t.brand_id === F.brand)
      .filter((t) => !F.overdue || (t.status === 'assigned' && isoDay(t.due_date) < TODAY))
      .filter((t) => !q || `${t.creative_id} ${t.campaign || ''} ${t.agency_name} ${t.brand_name || ''}`.toLowerCase().includes(q));

    const card = (t) => {
      const acts = [];
      if (me.isAgency && t.status === 'assigned') acts.push(`<button class="btn-primary" data-press onclick="event.stopPropagation();Repurpose.doneBox(this, ${t.id})">Mark done</button>`);
      if (me.canApprove && t.status === 'done') {
        acts.push(`<button class="btn-primary" data-press onclick="event.stopPropagation();Repurpose.approve(${t.id})">Approve</button>`);
        acts.push(`<button class="btn-outline" data-press onclick="event.stopPropagation();Repurpose.reopenBox(this, ${t.id})">Reopen</button>`);
      }
      const wd = t.status === 'done' ? Math.max(0, daysBetween(isoDay(t.done_at), TODAY)) : null;
      const wait = wd === null ? '' : wd === 0 ? 'Waiting since today' : `Waiting ${plural(wd, 'day')}`;
      return `<div class="sg-card rp-card" data-press role="button" tabindex="0" onclick="Repurpose.openCreative('${esc(t.creative_id)}', '${esc(t.brand_id)}')">
        <div class="rp-card-row">
          ${t.thumbnail_url ? `<img class="rp-thumb" src="${esc(t.thumbnail_url)}" alt="" loading="lazy" onerror="this.remove()">` : '<div class="rp-thumb rp-thumb-none"></div>'}
          <div class="rp-card-main">
            <div class="sg-card-top"><span class="sg-card-brand">${esc(t.brand_name || t.brand_id)}${me.isAgency ? '' : ` · ${esc(t.agency_name)}`}</span>
              ${t.reopened ? `<span class="sg-ver" title="Reopened by Unilever">Reopened ${t.reopened}×</span>` : ''}</div>
            <div class="sg-card-name rp-card-name" title="${esc(t.creative_id)}">${esc(t.creative_id)}</div>
            ${t.campaign ? `<div class="rp-card-sub">${esc(t.campaign)}</div>` : ''}
          </div>
        </div>
        ${t.status === 'assigned' && t.reopened && t.last_reopen_note ? `<div class="rp-note">${esc(t.last_reopen_note)}</div>` : ''}
        <div class="sg-card-foot">${t.status === 'approved' ? `<span class="rp-due rp-ok">Approved ${fmt(t.approved_at)}</span>` : dueTag(t)}${wait ? `<span class="sg-wait">${wait}</span>` : ''}</div>
        <div class="sg-card-by">Assigned by ${esc(t.assigned_by_name)} on ${fmt(t.assigned_at)}</div>
        ${acts.length ? `<div class="rp-acts">${acts.join('')}</div>` : ''}
        <div class="rp-box" hidden></div>
      </div>`;
    };

    const cols = [
      { key: 'assigned', title: me.isAgency ? 'To do' : 'With agency', empty: 'Nothing open.' },
      { key: 'done', title: me.isAgency ? 'Done, waiting for Unilever' : 'Done, waiting for approval', empty: 'Nothing waiting.' },
      { key: 'approved', title: 'Approved', empty: 'Nothing approved yet.' },
    ];
    const waitingMine = me.isAgency ? rows.filter((t) => t.status === 'assigned').length
      : me.canApprove ? rows.filter((t) => t.status === 'done').length : 0;
    const overdue = tasks.filter((t) => t.status === 'assigned' && isoDay(t.due_date) < TODAY).length;

    const perfHTML = !me.isAgency && perf && perf.length ? `<div class="rp-perf">${perf.map((p) => `<div class="kpi rp-perf-tile">
        <div class="kpi-label">${esc(p.agency_name)}</div>
        <div class="rp-perf-figs">
          <div><b>${p.open}</b><span>open</span></div>
          <div class="${p.overdue ? 'rp-bad' : ''}"><b>${p.overdue}</b><span>overdue</span></div>
          <div><b>${p.avg_days == null ? '–' : Number(p.avg_days) < 1 ? 'Same day' : `${Number(p.avg_days)}d`}</b><span>to approve</span></div>
          <div><b>${p.on_time_pct == null ? '–' : `${p.on_time_pct}%`}</b><span>on time</span></div>
        </div></div>`).join('')}</div>` : '';

    el.innerHTML = `<div class="sg-wrap rp-wrap${arrive ? ' page-in' : ''}">
      ${perfHTML}
      <div class="sg-toolbar"><div class="sg-tools">
        ${me.isAgency ? '' : `<select aria-label="Agency" onchange="Repurpose.filter('agency', this.value)"><option value="">All agencies</option>${agencies.map((a) => `<option${F.agency === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>`}
        <select aria-label="Brand" onchange="Repurpose.filter('brand', this.value)"><option value="">All brands</option>${brands.map(([id, n]) => `<option value="${esc(id)}"${F.brand === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <input class="search-input sg-search" type="search" placeholder="Search requests" value="${esc(F.q)}" oninput="Repurpose.filter('q', this.value)" aria-label="Search requests">
        <button class="rp-toggle${F.overdue ? ' on' : ''}" data-press onclick="Repurpose.filter('overdue', ${!F.overdue})" aria-pressed="${F.overdue}">Overdue${overdue ? ` <b>${overdue}</b>` : ''}</button>
      </div></div>
      ${waitingMine ? `<div class="sg-callout">${me.isAgency
        ? `<b>${plural(waitingMine, 'request')} to do.</b> Mark each one done when it is finished; Unilever then approves it.`
        : `<b>${plural(waitingMine, 'request')} waiting for your approval.</b> Approve it, or reopen it with a note if it is not finished.`}</div>` : ''}
      ${me.viewer ? '<div class="sg-callout">You can see every request. Approving is done by the Unilever brand team.</div>' : ''}
      <div class="sg-board rp-board">${cols.map((c) => {
        const list = rows.filter((t) => t.status === c.key);
        return `<section class="sg-col sg-col-${c.key === 'assigned' ? 'submitted' : c.key === 'done' ? 'changes_requested' : 'approved'}">
          <header><span>${c.title}</span><b>${list.length}</b></header>
          <div class="sg-col-body">${list.map(card).join('') || `<div class="sg-col-empty">${c.empty}</div>`}</div></section>`;
      }).join('')}</div>
      ${me.canAssign ? '<p class="rp-hint">To assign a creative, open it in the Creative Hub and use Assign agency for repurposing.</p>' : ''}
    </div>`;
    if (F._typing) { const s = el.querySelector('.sg-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  }

  function filter(k, v) { F[k] = v; F._typing = k === 'q'; draw(false); }

  /** Open the creative's panel; it has to be the brand in view. */
  function openCreative(id, brandId) {
    if (typeof BRAND_ID !== 'undefined' && BRAND_ID && brandId !== BRAND_ID) {
      const name = (LIST && LIST.tasks.find((t) => t.brand_id === brandId) || {}).brand_name || brandId;
      return say(`Switch to ${name} in the brand menu to open this creative.`);
    }
    if (typeof selectCard === 'function') selectCard(id);
  }

  async function refreshBadge() {
    const nav = document.querySelector(`.nav-item[onclick*="setNav('repurpose'"]`);
    if (!nav) return;
    try {
      const d = await api('GET', '/api/repurpose/summary');
      let b = nav.querySelector('.sg-nav-badge');
      if (!b) { b = document.createElement('span'); b.className = 'sg-nav-badge'; nav.appendChild(b); }
      b.textContent = d.waiting; b.hidden = !d.waiting;
      b.title = d.me && d.me.isAgency ? 'Requests to do' : 'Waiting for your approval';
    } catch (e) { /* convenience only */ }
  }

  function init() { watchGrid(); loadOpen(); refreshBadge(); }

  window.Repurpose = { panelBlock, assign, doneBox, reopenBox, dueBox, approve, cancel, render, filter, openCreative, refreshBadge, init, loadOpen };
})();

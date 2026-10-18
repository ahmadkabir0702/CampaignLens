/**
 * signoff.js — Campaign Sign-Off (Unilever social-first sign-off)
 *
 * Backed by real endpoints now: POST /api/signoffs (client leads only),
 * GET /api/signoffs (whatever brands the session can see), POST
 * /api/signoffs/:id/approve (media head only). The server is the one
 * enforcing role, not this file, role/username here are only used to
 * decide what to show, a rejected request still comes back as a real
 * 403 if someone gets past the UI.
 */
(function () {
  'use strict';

  let CURRENT_ROLE = null;
  let CURRENT_USERNAME = null;

  const STATUS_LABEL = {
    draft: 'Draft',
    pending: `Pending`,
    approved: 'Approved',
  };

  let signoffsCache = [];
  let mediaHeadName = 'the media head'; // display fallback until a real approval exists

  async function fetchSession() {
    if (CURRENT_ROLE !== null) return;
    try {
      const res = await fetch('/api/brands');
      const data = await res.json();
      CURRENT_ROLE = (data.user && data.user.role) || '';
      CURRENT_USERNAME = (data.user && data.user.username) || '';
    } catch (e) {
      CURRENT_ROLE = '';
    }
  }

  let BRANDS_CACHE = null;
  async function fetchBrands() {
    if (BRANDS_CACHE) return BRANDS_CACHE;
    try {
      const res = await fetch('/api/brands');
      const data = await res.json();
      BRANDS_CACHE = (data.brands || []).map(b => b.name);
    } catch (e) {
      BRANDS_CACHE = [];
    }
    return BRANDS_CACHE;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function statusPillClass(status) {
    if (status === 'approved') return 'so-pill so-pill-pos';
    if (status === 'pending') return 'so-pill so-pill-warn';
    return 'so-pill so-pill-neutral';
  }

  // ---------------------------------------------------------------------
  // LIST VIEW
  // ---------------------------------------------------------------------
  async function renderList() {
    const host = document.getElementById('page-signoff');
    if (!host) return;
    host.innerHTML = `<div class="so-wrap"><div class="so-empty">Loading...</div></div>`;

    await fetchSession();
    let rows = [];
    try {
      const res = await fetch('/api/signoffs');
      const data = await res.json();
      rows = data.signoffs || [];
      signoffsCache = rows;
    } catch (e) {
      host.innerHTML = `<div class="so-wrap"><div class="so-empty">Could not load sign-offs. Try again.</div></div>`;
      return;
    }

    // TEMPORARY: open to everyone while roles are still being assigned.
    // Restore to `CURRENT_ROLE === 'client_lead'` once real usernames are set.
    const canCreate = true;
    const listHtml = rows.map(s => `
      <div class="so-row" onclick="Signoff.openDetail(${s.id})">
        <div class="so-row-main">
          <div class="so-row-title">${esc(s.campaign_name || 'Untitled campaign')}</div>
          <div class="so-row-sub">${esc(s.brand_id || '—')} &middot; ${esc(s.market || '—')} &middot; prepared ${fmtDate(s.date_prepared) || '—'}</div>
        </div>
        <div class="so-row-side">
          <span class="${statusPillClass(s.status)}">${s.status === 'pending' ? STATUS_LABEL.pending + ' — ' + esc(s.approved_by || 'review') : STATUS_LABEL[s.status] || s.status}</span>
        </div>
      </div>`).join('') || `
      <div class="so-empty">No sign-offs yet. ${canCreate ? 'Start one with the button above.' : 'A client lead needs to create one before it can be reviewed.'}</div>`;

    host.innerHTML = `
      <div class="so-wrap">
        <div class="so-head">
          <div>
            <div class="so-title">Campaign Sign-Off</div>
            <div class="so-subtitle">Unilever social-first sign-off, one record per campaign, cleared before a campaign goes live.</div>
          </div>
          ${canCreate ? `<button class="btn-outline primary" onclick="Signoff.openCreate()">+ New Sign-Off</button>` : ''}
        </div>
        <div class="so-list">${listHtml}</div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // DETAIL VIEW
  // ---------------------------------------------------------------------
  async function openDetail(id) {
    await fetchSession();
    const s = signoffsCache.find(x => String(x.id) === String(id));
    if (!s) return;
    const host = document.getElementById('page-signoff');

    // TEMPORARY: open to everyone while roles are still being assigned.
    // Restore to `s.status === 'pending' && CURRENT_ROLE === 'media_head'` once real usernames are set.
    const canApprove = s.status === 'pending';

    host.innerHTML = `
      <div class="so-wrap">
        <button class="so-back" onclick="Signoff.backToList()">&larr; All sign-offs</button>

        <div class="so-detail-head">
          <div>
            <div class="so-title">${esc(s.campaign_name || 'Untitled campaign')}</div>
            <div class="so-subtitle">${esc(s.brand_id || '—')} &middot; ${esc(s.market || '—')} &middot; created by ${esc(s.created_by || '—')} on ${fmtDate(s.created_at)}</div>
          </div>
          <span class="${statusPillClass(s.status)}">${STATUS_LABEL[s.status] || s.status}</span>
        </div>

        ${s.status === 'approved' ? `
          <div class="so-approved-note">Approved by ${esc(s.approved_by || '—')} on ${fmtDate(s.approved_at)}.</div>
        ` : ''}

        <div class="so-meta-grid">
          <div><span class="so-meta-label">Client lead</span>${esc(s.client_lead_name || '—')}</div>
          <div><span class="so-meta-label">Go-live target</span>${fmtDate(s.go_live_date) || '—'}</div>
          <div><span class="so-meta-label">Variant</span>${esc(s.variant || '—')}</div>
          <div><span class="so-meta-label">Format</span>${esc(s.format || '—')}</div>
        </div>

        ${canApprove ? `
          <div class="so-approve-bar">
            <div>
              <div class="so-approve-title">Awaiting your approval</div>
              <div class="so-approve-sub">Approving marks this campaign cleared to go live.</div>
            </div>
            <button class="btn-outline primary" onclick="Signoff.approve(${s.id})">Approve</button>
          </div>
        ` : ''}
        ${s.status === 'pending' && CURRENT_ROLE !== 'media_head' ? `
          <div class="so-note">Waiting on the media head to approve.</div>
        ` : ''}
      </div>`;
  }

  async function approve(id) {
    try {
      const res = await fetch(`/api/signoffs/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Could not approve this sign-off.'); return; }
      await renderList();
      openDetail(id);
    } catch (e) {
      alert('Could not reach the server. Try again.');
    }
  }

  function backToList() {
    renderList();
  }

  // ---------------------------------------------------------------------
  // CREATE FORM
  // ---------------------------------------------------------------------
  const FUNNEL_BID = { TOFU: ['CPM'], MOFU: ['CPV', 'CPE'], BOFU: ['CPR', 'RoAS'] };
  const CREATIVE_TYPES = ['Video', 'Static', 'Carousel', 'Story', 'Collection', 'UGC'];
  const GOOGLE_ALLOC = ['pMax', 'Search', 'Demand Gen'];
  const DELIVERY_FIELDS = [
    ['impressions', 'Impressions'], ['reach', 'Reach'], ['vtr', 'VTR %'],
    ['er', 'ER %'], ['cvr', 'CVR %'], ['frequency', 'Frequency'],
    ['thruplays', 'ThruPlays'], ['postEng', 'Post Engagements'],
    ['clicks', 'Clicks'], ['purchases', 'Purchases'], ['purchaseValue', 'Purchases Value'],
  ];

  let draft = null;

  function blankDraft() {
    return {
      funnel: { tofu: '', mofu: '', bofu: '', budget: { tofu: 40, mofu: 35, bofu: 25 }, bid: { TOFU: null, MOFU: null, BOFU: null } },
      delivery: {},
      setup: { audienceDone: null, startDate: '', endDate: '', tgSize: '', creativeTypes: [], landingLinks: '' },
      costs: { platform: '', data: '', adServing: '', verification: null, pd1: null, retainer: null, ustore: null, google: [], other: '' },
    };
  }

  async function openCreate() {
    draft = blankDraft();
    const brands = await fetchBrands();
    const host = document.getElementById('page-signoff');
    const today = new Date().toISOString().slice(0, 10);

    host.innerHTML = `
      <div class="so-wrap">
        <button class="so-back" onclick="Signoff.backToList()">&larr; Cancel</button>
        <div class="so-title">New Campaign Sign-Off</div>
        <div class="so-subtitle">Fill in what's ready. This gets sent for approval once submitted.</div>

        <div class="so-card">
          <div class="so-meta-form">
            <label>Campaign name<input id="so-f-campaignName" placeholder="e.g. Surf Excel x FIFA WC 2026"></label>
            <label>Brand
              <select id="so-f-brand">
                <option value=""></option>
                ${brands.map(b => `<option>${esc(b)}</option>`).join('')}
              </select>
            </label>
            <label>Market<input id="so-f-market" value="Sri Lanka"></label>
            <label>Go-live target<input id="so-f-goLive" type="date"></label>
            <label>Client lead<input id="so-f-clientLead" placeholder="Name"></label>
            <label>Variant (Product)<input id="so-f-variant" placeholder="e.g. Surf Excel Liquid"></label>
            <label>Format (Product)<input id="so-f-format" placeholder="e.g. 500ml pouch"></label>
            <label>Date prepared<input id="so-f-datePrepared" type="date" value="${today}"></label>
          </div>
        </div>

        <div class="so-card">
          <div class="so-sec-title">01 &middot; Funnel Plan</div>
          <div class="so-item">
            <div class="so-item-label">Campaign types across the funnel</div>
            <div class="so-funnel-row"><span class="so-ftag so-ftag-t">TOFU</span><input id="so-f-tofu" placeholder="e.g. Reach & Frequency, Video Views"></div>
            <div class="so-funnel-row"><span class="so-ftag so-ftag-m">MOFU</span><input id="so-f-mofu" placeholder="e.g. Engagement, Traffic, ThruPlay"></div>
            <div class="so-funnel-row"><span class="so-ftag so-ftag-b">BOFU</span><input id="so-f-bofu" placeholder="e.g. Conversions, Catalogue Sales"></div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Budget split across funnel areas</div>
            <div class="so-tri-inputs">
              <label>TOFU %<input id="so-f-budget-tofu" type="number" min="0" value="40"></label>
              <label>MOFU %<input id="so-f-budget-mofu" type="number" min="0" value="35"></label>
              <label>BOFU %<input id="so-f-budget-bofu" type="number" min="0" value="25"></label>
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Bidding metrics by funnel</div>
            ${Object.entries(FUNNEL_BID).map(([stage, opts]) => `
              <div class="so-bid-row">
                <span class="so-bid-name">${stage}</span>
                <div class="so-seg" data-bid-group="${stage}">
                  ${opts.map(o => `<button type="button" class="so-seg-btn" onclick="Signoff.pickBid('${stage}','${o}',this)">${o}</button>`).join('')}
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="so-card">
          <div class="so-sec-title">02 &middot; Estimated Delivery (shared)</div>
          <div class="so-egrid">
            ${DELIVERY_FIELDS.map(([key, label]) => `
              <label>${label}<input id="so-f-delivery-${key}" placeholder="—"></label>`).join('')}
          </div>
        </div>

        <div class="so-card">
          <div class="so-sec-title">03 &middot; Setup & Targeting</div>
          <div class="so-item">
            <div class="so-item-label">Audience specification done?</div>
            <div class="so-seg" data-status-group="audienceDone">
              ${['Yes', 'No', 'N/A'].map(v => `<button type="button" class="so-seg-btn" onclick="Signoff.pickStatus('setup','audienceDone','${v}',this)">${v}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Start & end dates</div>
            <div class="so-dates"><input id="so-f-startDate" type="date"><input id="so-f-endDate" type="date"></div>
          </div>
          <div class="so-item">
            <div class="so-item-label">TG size</div>
            <input id="so-f-tgSize" placeholder="e.g. 2.4M">
          </div>
          <div class="so-item">
            <div class="so-item-label">Creative types</div>
            <div class="so-chips" data-chip-group="creativeTypes">
              ${CREATIVE_TYPES.map(c => `<button type="button" class="so-chip" onclick="Signoff.toggleChip('creativeTypes','${c}',this)">${c}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Landing page links</div>
            <textarea id="so-f-landingLinks" placeholder="Paste landing page / destination links"></textarea>
          </div>
        </div>

        <div class="so-card">
          <div class="so-sec-title">04 &middot; Costs & Allocations</div>
          <div class="so-item"><div class="so-item-label">Platform costs</div><input id="so-f-platformCost" placeholder="e.g. LKR 450,000"></div>
          <div class="so-item"><div class="so-item-label">Data costs</div><input id="so-f-dataCost" placeholder="—"></div>
          <div class="so-item"><div class="so-item-label">Ad serving costs</div><input id="so-f-adServing" placeholder="—"></div>
          <div class="so-item">
            <div class="so-item-label">Verification costs included?</div>
            <div class="so-seg" data-status-group="verification">
              ${['Yes', 'No', 'N/A'].map(v => `<button type="button" class="so-seg-btn" onclick="Signoff.pickStatus('costs','verification','${v}',this)">${v}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">1PD data allocation done?</div>
            <div class="so-seg" data-status-group="pd1">
              ${['Yes', 'No', 'N/A'].map(v => `<button type="button" class="so-seg-btn" onclick="Signoff.pickStatus('costs','pd1','${v}',this)">${v}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Retainer payment allocated?</div>
            <div class="so-seg" data-status-group="retainer">
              ${['Yes', 'No', 'N/A'].map(v => `<button type="button" class="so-seg-btn" onclick="Signoff.pickStatus('costs','retainer','${v}',this)">${v}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">uStore allocation done?</div>
            <div class="so-seg" data-status-group="ustore">
              ${['Yes', 'No', 'N/A'].map(v => `<button type="button" class="so-seg-btn" onclick="Signoff.pickStatus('costs','ustore','${v}',this)">${v}</button>`).join('')}
            </div>
          </div>
          <div class="so-item">
            <div class="so-item-label">Google allocation done</div>
            <div class="so-chips" data-chip-group="google">
              ${GOOGLE_ALLOC.map(c => `<button type="button" class="so-chip" onclick="Signoff.toggleChip('google','${c}',this)">${c}</button>`).join('')}
            </div>
          </div>
          <div class="so-item"><div class="so-item-label">Other costs</div><textarea id="so-f-otherCosts" placeholder="Mention any other costs"></textarea></div>
        </div>

        <div class="so-submit-bar">
          <button class="btn-outline" onclick="Signoff.backToList()">Cancel</button>
          <button class="btn-outline primary" onclick="Signoff.submit()">Submit for approval</button>
        </div>
      </div>`;
  }

  function pickBid(stage, val, btn) {
    draft.funnel.bid[stage] = val;
    btn.parentElement.querySelectorAll('.so-seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  function pickStatus(section, key, val, btn) {
    draft[section][key] = val;
    btn.parentElement.querySelectorAll('.so-seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  function toggleChip(group, val, btn) {
    const target = group === 'creativeTypes' ? draft.setup.creativeTypes : draft.costs.google;
    const i = target.indexOf(val);
    if (i === -1) { target.push(val); btn.classList.add('active'); }
    else { target.splice(i, 1); btn.classList.remove('active'); }
  }

  function collectMeta() {
    const g = id => (document.getElementById(id) || {}).value || '';
    return {
      campaignName: g('so-f-campaignName'), brand: g('so-f-brand'), market: g('so-f-market'),
      goLive: g('so-f-goLive'), clientLead: g('so-f-clientLead'), variant: g('so-f-variant'),
      format: g('so-f-format'), datePrepared: g('so-f-datePrepared'),
    };
  }

  function collectFields() {
    const g = id => (document.getElementById(id) || {}).value || '';
    draft.funnel.tofu = g('so-f-tofu'); draft.funnel.mofu = g('so-f-mofu'); draft.funnel.bofu = g('so-f-bofu');
    draft.funnel.budget.tofu = +g('so-f-budget-tofu') || 0;
    draft.funnel.budget.mofu = +g('so-f-budget-mofu') || 0;
    draft.funnel.budget.bofu = +g('so-f-budget-bofu') || 0;
    DELIVERY_FIELDS.forEach(([key]) => { draft.delivery[key] = g(`so-f-delivery-${key}`); });
    draft.setup.startDate = g('so-f-startDate'); draft.setup.endDate = g('so-f-endDate');
    draft.setup.tgSize = g('so-f-tgSize'); draft.setup.landingLinks = g('so-f-landingLinks');
    draft.costs.platform = g('so-f-platformCost'); draft.costs.data = g('so-f-dataCost');
    draft.costs.adServing = g('so-f-adServing'); draft.costs.other = g('so-f-otherCosts');
    return draft;
  }

  async function submit() {
    const meta = collectMeta();
    if (!meta.campaignName.trim()) {
      alert('Campaign name is required before this can be submitted.');
      return;
    }
    if (!meta.brand) {
      alert('Pick a brand before submitting.');
      return;
    }
    const fields = collectFields();
    try {
      const res = await fetch('/api/signoffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_id: meta.brand, meta, fields }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Could not submit this sign-off.'); return; }
      draft = null;
      backToList();
    } catch (e) {
      alert('Could not reach the server. Try again.');
    }
  }

  window.Signoff = {
    render: renderList, openCreate, openDetail, backToList, approve,
    pickBid, pickStatus, toggleChip, submit,
  };
})();

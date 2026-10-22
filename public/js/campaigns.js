/**
 * Campaigns, added and kept by Unilever and Mindshare themselves.
 *
 *   Campaigns.open()       the Campaigns window from the Creative Hub:
 *                          every campaign for the brand with how many
 *                          creatives use it; add, rename, and delete one
 *                          added by mistake while nothing uses it
 *   Campaigns.inlineOpen() "Add a new campaign" inside the Add creative
 *                          form, so nobody has to leave the form
 *
 * Shown only to accounts the server says may manage campaigns
 * (FEATURES.manageCampaigns); the server checks again on every call.
 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (v) => { if (!v) return ''; const d = new Date(v); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const S = { list: null, editing: null };
  const can = () => typeof FEATURES !== 'undefined' && FEATURES.manageCampaigns === true;
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : null);

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }

  /** Show the controls to the accounts that may use them. Called after the access is known. */
  function init() {
    const on = can();
    const b = document.getElementById('campaigns-btn'); if (b) b.hidden = !on;
    const l = document.getElementById('ac-new-campaign'); if (l) l.hidden = !on;
  }

  /** The pickers (Add creative, the hub filter) after a change. */
  async function refreshPickers(selectName) {
    try {
      const rows = await api('GET', '/api/campaigns');
      if (typeof CAMPAIGNS !== 'undefined') CAMPAIGNS = rows.map((r) => r.name);
      if (typeof HUB_OPTIONS !== 'undefined') {
        const set = new Set([...(HUB_OPTIONS.campaigns || []), ...CAMPAIGNS]);
        HUB_OPTIONS.campaigns = [...set].sort((a, b) => a.localeCompare(b));
      }
      const f = document.getElementById('campaign-filter');
      if (f) {
        const keep = f.value;
        f.innerHTML = '<option value="all">All campaigns</option>' +
          HUB_OPTIONS.campaigns.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        f.value = HUB_OPTIONS.campaigns.includes(keep) ? keep : 'all';
      }
      const sel = document.getElementById('ac-campaign');
      if (sel) {
        const keep = selectName || sel.value;
        sel.innerHTML = '<option value="" disabled>Select Campaign</option>' +
          CAMPAIGNS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        sel.value = CAMPAIGNS.includes(keep) ? keep : '';
        if (!sel.value) sel.selectedIndex = 0;
        sel.dispatchEvent(new Event('change'));
      }
      if (typeof repaintFilterDropdowns === 'function') repaintFilterDropdowns();
      if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn('addCreativeModal');
    } catch (e) { /* the pickers keep what they had */ }
  }

  // ---------------------------------------------------------------------
  //  The Campaigns window
  // ---------------------------------------------------------------------
  function overlay() {
    let el = document.getElementById('campaignsModal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'campaignsModal';
      el.className = 'modal-overlay';
      el.addEventListener('click', (e) => { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    return el;
  }

  async function open() {
    if (!can()) return;
    S.editing = null;
    const el = overlay();
    el.style.display = 'flex';
    el.innerHTML = `<div class="modal-box cp-box" role="dialog" aria-modal="true" aria-label="Campaigns">${head()}
      <div class="cp-list">${[0, 1, 2, 3].map(() => '<div class="cp-row"><div class="sk" style="width:55%;height:12px"></div></div>').join('')}</div></div>`;
    await load();
  }

  function head() {
    const brand = typeof BRAND_NAME !== 'undefined' ? BRAND_NAME : '';
    return `<div class="cp-head"><div><h3 class="modal-title">Campaigns${brand ? ` for ${esc(brand)}` : ''}</h3>
        <p class="modal-desc">Add the campaigns creatives are filed under. Everyone on this brand sees the same list.</p></div>
        <button class="close-btn" aria-label="Close" onclick="Campaigns.close()">×</button></div>
      <div class="cp-add">
        <input id="cp-new" class="modal-input" maxlength="120" placeholder="New campaign name"
          onkeydown="if(event.key==='Enter')Campaigns.add()">
        <button class="btn-primary" data-press onclick="Campaigns.add()">Add campaign</button>
      </div>
      <div class="cp-err" id="cp-err" hidden></div>`;
  }

  async function load() {
    try {
      S.list = (await api('GET', '/api/campaigns/manage')).campaigns;
      draw();
    } catch (e) {
      const box = overlay().querySelector('.cp-list');
      if (box) box.innerHTML = `<div class="load-msg load-msg-error">Couldn't load campaigns. ${esc(e.message)}</div>`;
    }
  }

  function draw(focusId) {
    const el = overlay();
    const shown = S.list;
    const row = (c) => {
      const key = c.id == null ? `n:${c.name}` : String(c.id);
      if (S.editing === key) {
        return `<div class="cp-row is-edit"><input id="cp-edit" class="modal-input" maxlength="120" value="${esc(c.name)}"
            onkeydown="if(event.key==='Enter')Campaigns.saveRename();if(event.key==='Escape')Campaigns.cancelEdit()">
          <button class="btn-primary" data-press onclick="Campaigns.saveRename()">Save</button>
          <button class="btn-outline" data-press onclick="Campaigns.cancelEdit()">Cancel</button>
          ${c.creatives ? `<div class="cp-note">The new name is carried over to its ${c.creatives} creative${c.creatives === 1 ? '' : 's'}.</div>` : ''}</div>`;
      }
      const meta = [
        c.creatives ? `${c.creatives} creative${c.creatives === 1 ? '' : 's'}` : 'No creatives yet',
        c.signed_off ? 'Signed off' : '',
        c.created_by ? `Added by ${esc(c.created_by)}${c.created_at ? ` on ${day(c.created_at)}` : ''}` : '',
      ].filter(Boolean).join(' · ');
      // Delete only while nothing uses it: a typo or a duplicate.
      const unused = !c.creatives && !c.signed_off;
      const acts = c.id == null
        ? `<button class="cp-act" onclick="Campaigns.adopt(${esc(JSON.stringify(c.name))})">Add to list</button>`
        : `<button class="cp-act" onclick="Campaigns.edit(${c.id})">Rename</button>
           ${c.is_active ? '' : `<button class="cp-act" onclick="Campaigns.restore(${c.id})">Put back in the list</button>`}
           ${unused ? `<button class="cp-act cp-act-del" onclick="Campaigns.remove(${c.id}, ${esc(JSON.stringify(c.name))})">Delete</button>` : ''}`;
      const note = c.id == null ? ' · <span class="cp-legacy">Only on creatives, not in the list</span>'
        : !c.is_active ? ' · <span class="cp-legacy">Not offered when adding a creative</span>' : '';
      return `<div class="cp-row"><div class="cp-main"><div class="cp-name">${esc(c.name)}</div>
          <div class="cp-meta">${meta}${note}</div></div>
        <div class="cp-acts">${acts}</div></div>`;
    };
    el.querySelector('.cp-box').innerHTML = `${head()}
      <div class="cp-list">${shown.length ? shown.map(row).join('') : '<div class="cp-empty">No campaigns yet. Add the first one above.</div>'}</div>
      <div class="cp-foot">Rename fixes a typo everywhere the campaign is used. Delete is only offered while no creative or sign-off uses it.</div>`;
    const f = document.getElementById(focusId || (S.editing ? 'cp-edit' : 'cp-new'));
    if (f) { f.focus(); if (f.id === 'cp-edit') f.select(); }
  }

  function err(msg) {
    const e = document.getElementById('cp-err');
    if (!e) return say(msg, 'error');
    e.hidden = !msg; e.textContent = msg || '';
  }

  async function add() {
    const input = document.getElementById('cp-new');
    const name = (input && input.value || '').trim();
    if (!name) return err('Type the campaign name first.');
    try {
      const r = await api('POST', '/api/campaigns', { name });
      say(r.existed ? `"${r.name}" was already in the list.` : `Added "${r.name}".`);
      await load();
      refreshPickers();
    } catch (e) { err(e.message); }
  }

  async function adopt(name) {
    try { await api('POST', '/api/campaigns', { name }); await load(); refreshPickers(); }
    catch (e) { err(e.message); }
  }

  function edit(id) { S.editing = String(id); draw(); }
  function cancelEdit() { S.editing = null; draw(); }

  async function saveRename() {
    const id = Number(S.editing);
    const input = document.getElementById('cp-edit');
    const name = (input && input.value || '').trim();
    if (!name) return err('The name cannot be empty.');
    try {
      await api('PUT', `/api/campaigns/${id}`, { name });
      S.editing = null;
      await load();
      say('Renamed.');
      // Creatives carry the name, so the hub reloads to show it.
      if (typeof loadData === 'function') loadData();
      refreshPickers();
    } catch (e) { err(e.message); }
  }

  async function restore(id) {
    try {
      await api('PUT', `/api/campaigns/${id}`, { is_active: true });
      await load();
      refreshPickers();
    } catch (e) { err(e.message); }
  }

  async function remove(id, name) {
    if (!confirm(`Delete "${name}"? Nothing uses it yet, so nothing else changes.`)) return;
    try {
      await api('DELETE', `/api/campaigns/${id}`);
      await load();
      refreshPickers();
      say(`Deleted "${name}".`);
    } catch (e) { err(e.message); }
  }
  function close() { const el = document.getElementById('campaignsModal'); if (el) el.style.display = 'none'; }
  document.addEventListener('keydown', (e) => {
    const el = document.getElementById('campaignsModal');
    if (e.key === 'Escape' && el && el.style.display === 'flex' && !S.editing) close();
  });

  // ---------------------------------------------------------------------
  //  Inside the Add creative form
  // ---------------------------------------------------------------------
  function inlineOpen() {
    document.getElementById('ac-new-campaign').hidden = true;
    document.getElementById('ac-new-campaign-box').hidden = false;
    const i = document.getElementById('ac-new-campaign-name'); i.value = ''; i.focus();
    document.getElementById('ac-new-campaign-err').hidden = true;
  }
  function inlineClose() {
    document.getElementById('ac-new-campaign-box').hidden = true;
    document.getElementById('ac-new-campaign').hidden = !can();
  }
  async function inlineAdd() {
    const name = document.getElementById('ac-new-campaign-name').value.trim();
    const e = document.getElementById('ac-new-campaign-err');
    if (!name) { e.hidden = false; e.textContent = 'Type the campaign name first.'; return; }
    try {
      const r = await api('POST', '/api/campaigns', { name });
      await refreshPickers(r.name);
      inlineClose();
      say(r.existed ? `"${r.name}" was already in the list, so it is selected.` : `Added "${r.name}" and selected it.`);
    } catch (x) { e.hidden = false; e.textContent = x.message; }
  }

  window.Campaigns = { init, open, close, add, adopt, edit, cancelEdit, saveRename, restore, remove, inlineOpen, inlineClose, inlineAdd };
})();

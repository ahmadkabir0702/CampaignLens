/**
 * Admin page: logins and access, usage, the health of the data, and a
 * log of every admin change. The admin role only; the server checks.
 *
 * Logins: a table on the left, the selected login's editor on the right
 * (the same frame as the sign-off detail). Brands and sections are
 * toggles. A new or reset password is shown once, to copy and send.
 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jsq = (s) => esc(JSON.stringify(String(s == null ? '' : s)));
  const host = () => document.getElementById('page-admin');

  const SECTION_LABEL = {
    askLens: 'Ask Lens', addCreative: 'Add creative', pretest: 'Pre-tests', media: 'Media Summary',
    creators: 'Creators', sov: 'Share of voice', signoff: 'Campaign sign-off', repurpose: 'Repurposing',
  };
  const ORG_LABEL = { unilever: 'Unilever', mindshare: 'Mindshare', agency: 'Agency', other: 'Other' };
  const ROLE_LABEL = { standard: 'Standard', admin: 'Admin', media_head: 'Media head (approves sign-offs, read-only)', influencer_coordinator: 'Influencer coordinator' };
  const USAGE_LABEL = { creatives: 'Creative Hub', kpi: 'Media Summary', creators: 'Creators', pretests: 'Pre-tests',
    sov: 'Share of voice', signoff: 'Campaign sign-off', repurpose: 'Repurposing', coordinator: 'Coordinator page',
    admin: 'Admin', 'ask-lens-question': 'Ask Lens questions' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const S = { tab: 'logins', data: null, sel: null, draft: null, q: '', org: '', secret: null, usage: null, health: null, log: null };

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }

  const day = (v) => { if (!v) return ''; const d = new Date(v); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const ago = (v) => {
    if (!v) return 'Never';
    const ms = Date.now() - new Date(v).getTime();
    const d = Math.floor(ms / 86400000);
    if (d < 1) { const h = Math.floor(ms / 3600000); return h < 1 ? 'Just now' : `${h}h ago`; }
    return d < 30 ? `${d}d ago` : day(v);
  };
  const roleKey = (r) => (r === 'admin' || r === 'media_head' || r === 'influencer_coordinator' ? r : 'standard');
  const brandName = (id) => { const b = (S.data.brands || []).find((x) => x.brand_id === id); return b ? b.name : id; };

  function say(msg, kind) {
    if (typeof toast === 'function') return toast(msg, kind);
    console.log(msg);
  }

  // ---------------------------------------------------------------------
  //  Frame
  // ---------------------------------------------------------------------
  function skeleton() {
    const row = (i) => `<tr>${[40, 18, 22, 14].map((w, j) => `<td><div class="sk" style="width:${w + ((i + j) % 3) * 8}%;height:11px"></div></td>`).join('')}</tr>`;
    return `<div class="ad-wrap" aria-busy="true"><div class="sk" style="width:330px;height:36px;border-radius:9px;margin-bottom:16px"></div>
      <div class="ad-card"><table class="ad-table"><tbody>${Array.from({ length: 8 }, (_, i) => row(i)).join('')}</tbody></table></div></div>`;
  }

  async function render() {
    const el = host();
    if (!el) return;
    el.innerHTML = skeleton();
    try { S.data = await api('GET', '/api/admin/overview'); }
    catch (e) {
      el.innerHTML = `<div class="ad-wrap"><div class="load-msg load-msg-error">Couldn't load the admin page. ${esc(e.message)}
        <button class="load-retry" onclick="Admin.render()">Try again</button></div></div>`;
      return;
    }
    draw(true);
  }

  function tabs() {
    const t = [['logins', 'Logins and access'], ['usage', 'Usage'], ['health', 'Data and errors'], ['log', 'Change log']];
    return `<div class="ad-tabs" role="tablist">${t.map(([k, n]) =>
      `<button role="tab" aria-selected="${S.tab === k}" class="${S.tab === k ? 'on' : ''}" data-press onclick="Admin.tab('${k}')">${n}</button>`).join('')}</div>`;
  }

  function draw(arrive) {
    const el = host();
    const body = S.tab === 'logins' ? loginsHTML() : S.tab === 'usage' ? usageHTML() : S.tab === 'health' ? healthHTML() : logHTML();
    el.innerHTML = `<div class="ad-wrap${arrive ? ' page-in' : ''}">${tabs()}${body}</div>`;
    if (typeof enhanceSelectsIn === 'function') enhanceSelectsIn(el);
  }

  async function tab(k) {
    S.tab = k;
    draw(false);
    try {
      if (k === 'usage' && !S.usage) { S.usage = await api('GET', '/api/admin/usage?days=30'); draw(false); }
      if (k === 'health' && !S.health) { S.health = await api('GET', '/api/admin/health'); draw(false); }
      if (k === 'log') { S.log = await api('GET', '/api/admin/log'); draw(false); }
    } catch (e) { say(e.message, 'error'); }
  }

  // ---------------------------------------------------------------------
  //  Logins
  // ---------------------------------------------------------------------
  function statusOf(u) {
    if (!u.is_active) return '<span class="ad-st ad-st-off">Switched off</span>';
    if (u.must_change_password) return '<span class="ad-st ad-st-wait">New password pending</span>';
    return '<span class="ad-st ad-st-on">Active</span>';
  }

  function loginsHTML() {
    const q = S.q.trim().toLowerCase();
    const rows = S.data.logins
      .filter((u) => !S.org || (u.org || '') === S.org)
      .filter((u) => !q || `${u.username} ${u.display_name || ''}`.toLowerCase().includes(q));
    const active = S.data.logins.filter((u) => u.is_active).length;
    const table = `<div class="ad-card"><table class="ad-table ad-logins">
      <thead><tr><th>Login</th><th>Side</th><th>Brands</th><th>Last sign-in</th><th>Status</th></tr></thead>
      <tbody>${rows.map((u) => {
        const nb = u.brands.length;
        const brands = u.role === 'media_head' ? 'All brands' : nb ? `${nb} · ${u.brands.slice(0, 3).map(brandName).map(esc).join(', ')}${nb > 3 ? '…' : ''}` : '<span class="ad-muted">None</span>';
        return `<tr class="${S.sel === u.username ? 'is-sel' : ''}${u.is_active ? '' : ' is-off'}" data-press tabindex="0"
            onclick="Admin.select(${jsq(u.username)})" onkeydown="if(event.key==='Enter')Admin.select(${jsq(u.username)})">
          <td><div class="ad-user">${esc(u.username)}</div><div class="ad-muted">${esc(u.display_name || '')}${u.role && u.role !== 'member' ? ` · ${esc((ROLE_LABEL[roleKey(u.role)] || u.role).split(' (')[0])}` : ''}</div></td>
          <td>${u.org ? `<span class="ad-org ad-org-${esc(u.org)}">${esc(ORG_LABEL[u.org] || u.org)}</span>` : '<span class="ad-muted">Not set</span>'}</td>
          <td class="ad-brands">${brands}</td>
          <td class="ad-nowrap">${esc(ago(u.last_login_at))}</td>
          <td>${statusOf(u)}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="ad-empty">No logins match.</td></tr>'}</tbody></table></div>`;

    return `<div class="sg-toolbar"><div class="sg-tools">
        <input class="search-input" placeholder="Search logins" value="${esc(S.q)}" oninput="Admin.search(this.value)">
        <select onchange="Admin.filterOrg(this.value)"><option value="">Every side</option>${S.data.orgs.map((o) =>
          `<option value="${o}"${S.org === o ? ' selected' : ''}>${ORG_LABEL[o]}</option>`).join('')}</select>
        <span class="ad-count">${active} active of ${S.data.logins.length}</span>
      </div><button class="btn-primary" data-press onclick="Admin.add()">Add login</button></div>
      <div class="ad-grid">${table}<aside class="ad-side">${editorHTML()}</aside></div>`;
  }

  function editorHTML() {
    if (S.secret) {
      return `<div class="ad-panel ad-secret"><h3>${S.secret.isNew ? 'Login added' : 'Password reset'}</h3>
        <p>Send these to <b>${esc(S.secret.username)}</b> privately. The password is shown once; they choose their own the first time they sign in.</p>
        <div class="ad-cred"><span>Username</span><code>${esc(S.secret.username)}</code></div>
        <div class="ad-cred"><span>Temporary password</span><code id="ad-pw">${esc(S.secret.password)}</code></div>
        <div class="ad-acts"><button class="btn-primary" data-press onclick="Admin.copy()">Copy both</button>
          <button class="btn-outline" data-press onclick="Admin.closeSecret()">Done</button></div></div>`;
    }
    const d = S.draft;
    if (!d) {
      return `<div class="ad-panel ad-hint"><h3>Choose a login</h3><p>Pick a login to change its brands, sections or password, or switch it off. Changes apply within a minute, including for people already signed in.</p></div>`;
    }
    const isNew = !!d.isNew;
    const self = d.username === S.data.me;
    const agency = d.org === 'agency';
    const media = d.role === 'media_head';
    const brandChips = S.data.brands.filter((b) => b.is_active).map((b) =>
      `<button type="button" class="ad-chip${d.brands.includes(b.brand_id) ? ' on' : ''}" ${media ? 'disabled' : ''}
         onclick="Admin.toggleBrand(${jsq(b.brand_id)})">${esc(b.name)}</button>`).join('');
    const AGENCY_OFF = ['askLens', 'media', 'creators', 'sov', 'signoff'];
    const sectionChips = S.data.sections.map((k) => {
      const locked = agency && AGENCY_OFF.includes(k);
      return `<button type="button" class="ad-chip${d.sections[k] && !locked ? ' on' : ''}" ${locked ? 'disabled title="Not available to agencies"' : ''}
        onclick="Admin.toggleSection('${k}')">${esc(SECTION_LABEL[k] || k)}</button>`;
    }).join('');

    return `<div class="ad-panel">
      <div class="ad-panel-head"><h3>${isNew ? 'New login' : esc(d.username)}</h3>${isNew ? '' : statusOf(d)}</div>
      ${isNew ? `<label class="ad-field">Username<input id="ad-username" value="${esc(d.username)}" placeholder="e.g. ms.homecare or agency.popkorn" oninput="Admin.set('username', this.value)"></label>` : ''}
      <label class="ad-field">Name shown in the app<input value="${esc(d.display_name || '')}" placeholder="e.g. Mindshare Homecare" oninput="Admin.set('display_name', this.value)"></label>
      <div class="ad-two">
        <label class="ad-field">Side<select onchange="Admin.set('org', this.value, true)">${!d.org ? '<option value="">Choose</option>' : ''}${S.data.orgs.map((o) =>
          `<option value="${o}"${d.org === o ? ' selected' : ''}>${ORG_LABEL[o]}</option>`).join('')}</select></label>
        <label class="ad-field">Role<select onchange="Admin.set('role', this.value, true)" ${self ? 'disabled' : ''}>${S.data.roles.map((r) =>
          `<option value="${r}"${roleKey(d.role) === r ? ' selected' : ''}>${esc(ROLE_LABEL[r].split(' (')[0])}</option>`).join('')}</select></label>
      </div>
      ${agency ? `<label class="ad-field">Agency<select onchange="Admin.set('agency_id', this.value)"><option value="">Choose the agency</option>${S.data.agencies.map((a) =>
        `<option value="${esc(a.id)}"${String(d.agency_id || '') === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
      <div class="ad-label">Brands ${media ? '<span class="ad-muted">the media head sees every brand</span>' : `<span class="ad-muted">${d.brands.length} chosen</span>
        <button type="button" class="ad-link" onclick="Admin.allBrands(true)">All</button><button type="button" class="ad-link" onclick="Admin.allBrands(false)">None</button>`}</div>
      <div class="ad-chips">${brandChips}</div>
      <div class="ad-label">Sections ${agency ? '<span class="ad-muted">agencies get the Creative Hub, Pre-tests and Repurposing only</span>' : ''}</div>
      <div class="ad-chips">${sectionChips}</div>
      <div class="ad-problem" id="ad-problem" hidden></div>
      <div class="ad-acts">
        <button class="btn-primary" data-press onclick="Admin.save()">${isNew ? 'Add login' : 'Save changes'}</button>
        <button class="btn-outline" data-press onclick="Admin.cancel()">Cancel</button>
      </div>
      ${isNew ? '' : `<div class="ad-danger">
        ${self ? '' : `<button class="btn-outline" data-press onclick="Admin.reset()">Reset password</button>
        <button class="btn-outline ${d.is_active ? 'sg-danger' : ''}" data-press onclick="Admin.active(${!d.is_active})">${d.is_active ? 'Switch off' : 'Switch back on'}</button>`}
        <div class="ad-muted">Last sign-in: ${esc(ago(d.last_login_at))}</div></div>`}
    </div>`;
  }

  function select(username) {
    const u = S.data.logins.find((x) => x.username === username);
    if (!u) return;
    S.secret = null;
    S.sel = username;
    S.draft = JSON.parse(JSON.stringify({ ...u, agency_id: u.agency_key }));
    draw(false);
  }

  function add() {
    S.secret = null;
    S.sel = null;
    const sections = Object.fromEntries(S.data.sections.map((k) => [k, true]));
    S.draft = { isNew: true, username: '', display_name: '', org: '', role: 'standard', agency_id: '', brands: [], sections, is_active: true };
    draw(false);
    const u = document.getElementById('ad-username'); if (u) u.focus();
  }

  function set(k, v, redraw) {
    if (!S.draft) return;
    S.draft[k] = v;
    if (k === 'role' && v === 'media_head') S.draft.brands = S.data.brands.filter((b) => b.is_active).map((b) => b.brand_id);
    if (redraw) draw(false);
  }
  function toggleBrand(id) {
    const b = S.draft.brands;
    S.draft.brands = b.includes(id) ? b.filter((x) => x !== id) : b.concat(id);
    draw(false);
  }
  function allBrands(on) { S.draft.brands = on ? S.data.brands.filter((b) => b.is_active).map((b) => b.brand_id) : []; draw(false); }
  function toggleSection(k) { S.draft.sections[k] = !S.draft.sections[k]; draw(false); }

  function problem(msg) {
    const el = document.getElementById('ad-problem');
    if (!el) return say(msg, 'error');
    el.hidden = false; el.textContent = msg;
  }

  async function save() {
    const d = S.draft;
    if (!d) return;
    if (!d.org) return problem('Choose which side this login is on.');
    if (d.org === 'agency' && !d.agency_id) return problem('Choose the agency.');
    if (d.role !== 'media_head' && !d.brands.length) return problem('Give the login at least one brand.');
    const body = { display_name: d.display_name, org: d.org, role: roleKey(d.role), agency_id: d.org === 'agency' ? d.agency_id : null,
      brands: d.brands, sections: d.sections };
    try {
      if (d.isNew) {
        const r = await api('POST', '/api/admin/logins', { ...body, username: d.username });
        S.secret = { username: r.username, password: r.temp_password, isNew: true };
      } else {
        await api('PUT', `/api/admin/logins/${encodeURIComponent(d.username)}`, body);
        say('Saved. It applies within a minute.');
      }
      S.data = await api('GET', '/api/admin/overview');
      if (!S.secret) select(d.username); else { S.sel = S.secret.username; S.draft = null; draw(false); }
    } catch (e) { problem(e.message); }
  }

  async function reset() {
    const d = S.draft;
    if (!d || !confirm(`Reset the password for ${d.username}? Everyone using this login is signed out within a minute and needs the new password.`)) return;
    try {
      const r = await api('POST', `/api/admin/logins/${encodeURIComponent(d.username)}/reset-password`);
      S.secret = { username: r.username, password: r.temp_password };
      S.data = await api('GET', '/api/admin/overview');
      draw(false);
    } catch (e) { problem(e.message); }
  }

  async function active(on) {
    const d = S.draft;
    if (!d) return;
    if (!on && !confirm(`Switch off ${d.username}? Anyone signed in with it is signed out within a minute.`)) return;
    try {
      await api('PUT', `/api/admin/logins/${encodeURIComponent(d.username)}`, { is_active: on });
      S.data = await api('GET', '/api/admin/overview');
      select(d.username);
      say(on ? 'Switched back on.' : 'Switched off.');
    } catch (e) { problem(e.message); }
  }

  function cancel() { S.draft = null; S.sel = null; draw(false); }
  function closeSecret() { S.secret = null; draw(false); }
  async function copy() {
    if (!S.secret) return;
    const text = `Campaign Lens\nUsername: ${S.secret.username}\nTemporary password: ${S.secret.password}\nYou will be asked to choose your own password when you sign in.`;
    try { await navigator.clipboard.writeText(text); say('Copied.'); }
    catch (e) { say('Could not copy. Select the password and copy it.', 'error'); }
  }
  let searchT = null;
  function search(v) { S.q = v; clearTimeout(searchT); searchT = setTimeout(() => { draw(false); const i = host().querySelector('.search-input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); }
  function filterOrg(v) { S.org = v; draw(false); }

  // ---------------------------------------------------------------------
  //  Usage
  // ---------------------------------------------------------------------
  function loading() { return `<div class="ad-card ad-pad"><div class="sk" style="width:40%;height:12px;margin-bottom:12px"></div><div class="sk" style="width:70%;height:12px"></div></div>`; }

  function usageHTML() {
    const u = S.usage;
    if (!u) return loading();
    const views = u.sections.filter((s) => s.section !== 'ask-lens-question');
    const max = Math.max(1, ...views.map((s) => s.count));
    const q = u.sections.find((s) => s.section === 'ask-lens-question');
    const used = u.logins.filter((l) => l.views || l.questions).length;
    const never = u.logins.filter((l) => !l.last_login_at).length;
    return `<div class="ad-tiles">
        <div class="kpi"><div class="kpi-label">Logins used in the last ${u.days} days</div><div class="kpi-val">${used}<span class="ad-of"> of ${u.logins.length}</span></div></div>
        <div class="kpi"><div class="kpi-label">Ask Lens questions</div><div class="kpi-val">${q ? q.count : 0}</div><div class="kpi-sub">${q ? `from ${q.logins} login${q.logins === 1 ? '' : 's'}` : 'none yet'}</div></div>
        <div class="kpi"><div class="kpi-label">Logins never signed in</div><div class="kpi-val">${never}</div><div class="kpi-sub">candidates to switch off</div></div>
      </div>
      <div class="ad-two-col">
        <div class="ad-card ad-pad"><h3 class="ad-h">Sections opened</h3>
          ${views.length ? views.map((s) => `<div class="ad-bar"><span class="ad-bar-k">${esc(USAGE_LABEL[s.section] || s.section)}</span>
            <span class="ad-bar-track"><i class="grow-x" style="width:${Math.round(s.count / max * 100)}%"></i></span>
            <span class="ad-bar-n">${s.count}</span><span class="ad-bar-m">${s.logins} login${s.logins === 1 ? '' : 's'}</span></div>`).join('')
            : '<p class="ad-muted">Nothing counted yet. Counting starts with this release.</p>'}
        </div>
        <div class="ad-card"><table class="ad-table">
          <thead><tr><th>Login</th><th class="n">Pages</th><th class="n">Questions</th><th>Last used</th></tr></thead>
          <tbody>${u.logins.map((l) => `<tr class="${l.views || l.questions ? '' : 'is-off'}">
            <td><div class="ad-user">${esc(l.username)}</div><div class="ad-muted">${esc(ORG_LABEL[l.org] || '')}</div></td>
            <td class="n">${l.views}</td><td class="n">${l.questions}</td>
            <td class="ad-nowrap">${l.last_used ? esc(day(l.last_used)) : `<span class="ad-muted">${l.last_login_at ? 'Signed in ' + esc(ago(l.last_login_at).toLowerCase()) : 'Never signed in'}</span>`}</td></tr>`).join('')}</tbody></table></div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  //  Data and errors
  // ---------------------------------------------------------------------
  function healthHTML() {
    const h = S.health;
    if (!h) return loading();
    const now = Date.now();
    const stale = (d) => d && (now - new Date(d + 'T00:00:00').getTime()) / 86400000 > 2;
    const job = (h.jobs || []).find((j) => j.name === 'nightly');
    const jobLine = !job ? '<span class="ad-muted">No run recorded yet.</span>'
      : job.last_error ? `<span class="ad-bad">Last attempt failed ${esc(ago(job.last_try_at).toLowerCase())}: ${esc(job.last_error)}</span>${job.last_ok_at ? `<div class="ad-muted">Last good run ${esc(ago(job.last_ok_at).toLowerCase())}</div>` : ''}`
        : `Last run ${esc(ago(job.last_ok_at).toLowerCase())}, took ${Math.round((job.last_ms || 0) / 1000)}s`;
    return `<div class="ad-two-col">
      <div class="ad-card"><table class="ad-table">
        <thead><tr><th>Brand</th><th>Paid data to</th><th>Organic updated</th></tr></thead>
        <tbody>${h.data.map((b) => `<tr><td class="ad-user">${esc(b.name)}</td>
          <td class="${stale(b.paid_through) ? 'ad-warn' : ''}">${b.paid_through ? esc(day(b.paid_through)) : '<span class="ad-muted">No paid data</span>'}</td>
          <td>${b.organic_at ? esc(ago(b.organic_at)) : '<span class="ad-muted">None</span>'}</td></tr>`).join('')}</tbody></table></div>
      <div class="ad-stack">
        <div class="ad-card ad-pad"><h3 class="ad-h">Nightly refresh</h3><div class="ad-text">${jobLine}</div></div>
        <div class="ad-card ad-pad"><h3 class="ad-h">CQR benchmarks</h3><div class="ad-text">${h.bars
          ? `${esc(h.bars.year)} benchmarks, fixed for the year. Next reset: January ${Number(h.bars.year) + 1}.`
          : '<span class="ad-warn">Not recorded yet. Run 039_cqr_bars_by_year.sql.</span>'}</div></div>
        <div class="ad-card ad-pad"><h3 class="ad-h">Database changes</h3><div class="ad-text">${h.migrations_recorded} recorded.
          ${!h.migrations_recorded ? '<div class="ad-warn">None recorded yet. Run 037_ops_tables.sql in Supabase once; it records the files already run.</div>'
            : h.migrations_missing.length ? `<div class="ad-warn">Not recorded: ${h.migrations_missing.map(esc).join(', ')}</div><div class="ad-muted">Run the file in Supabase. If it has been run already, record it: insert into schema_migrations (name) values ('the file name');</div>`
            : '<span class="ad-ok">Every file is recorded.</span>'}</div></div>
      </div></div>
      <div class="ad-card"><div class="ad-pad ad-pad-b"><h3 class="ad-h">Errors</h3></div>
        ${h.errors.length ? `<table class="ad-table"><thead><tr><th>Last seen</th><th>Where</th><th>What</th><th class="n">Times</th><th>Login</th></tr></thead>
        <tbody>${h.errors.map((e) => `<tr><td class="ad-nowrap">${esc(ago(e.last_at))}</td><td><div class="ad-user">${esc(e.tag)}</div><div class="ad-muted">${esc(e.path || '')}</div></td>
          <td class="ad-msg">${esc(e.message)}</td><td class="n">${e.count}</td><td>${esc(e.username || '')}</td></tr>`).join('')}</tbody></table>`
        : '<p class="ad-pad ad-muted">No errors recorded.</p>'}</div>`;
  }

  // ---------------------------------------------------------------------
  //  Change log
  // ---------------------------------------------------------------------
  function logHTML() {
    const l = S.log;
    if (!l) return loading();
    const what = (r) => {
      const d = r.details || {};
      if (r.action === 'add login') return `Added, ${esc(ORG_LABEL[d.org] || d.org || '')}, ${(d.brands || []).length} brand${(d.brands || []).length === 1 ? '' : 's'}`;
      if (r.action === 'reset password') return 'Password reset';
      if (d.is_active === false) return 'Switched off';
      if (d.is_active === true) return 'Switched back on';
      const bits = [];
      if (d.brands) bits.push(`brands: ${d.brands.map(brandName).map(esc).join(', ') || 'none'}`);
      if (d.sections) bits.push(`sections: ${Object.entries(d.sections).filter(([, v]) => v).map(([k]) => esc(SECTION_LABEL[k] || k)).join(', ') || 'none'}`);
      if (d.role) bits.push(`role: ${esc(d.role)}`);
      if (d.org) bits.push(`side: ${esc(ORG_LABEL[d.org] || d.org)}`);
      return bits.join('; ') || 'Changed';
    };
    return `<div class="ad-card">${l.log.length ? `<table class="ad-table"><thead><tr><th>When</th><th>Who</th><th>Login</th><th>Change</th></tr></thead>
      <tbody>${l.log.map((r) => `<tr><td class="ad-nowrap">${esc(day(r.at))}, ${esc(new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</td>
        <td>${esc(r.actor)}</td><td class="ad-user">${esc(r.target || '')}</td><td class="ad-msg">${what(r)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="ad-pad ad-muted">No changes made from this page yet.</p>'}</div>`;
  }

  window.Admin = { render, tab, select, add, set, toggleBrand, allBrands, toggleSection, save, reset, active, cancel, closeSecret, copy, search, filterOrg };
})();

/**
 * dropdowns.js — Brand switcher + custom filter listboxes
 *
 * Design note: the native <select> elements stay in the DOM, hidden. They
 * remain the source of truth, so getData(), populateFilters(), clearFilters()
 * and syncFilterPills() all keep working untouched — this file only draws a
 * nicer control on top and writes back through the select's own change event.
 */
(function () {
  'use strict';

  const CHEV = '<svg class="dd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
  const TICK = '<svg class="dd-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Brand logos live at /img/brands/<slug>.svg — "Cool Fresh" -> cool-fresh.svg
  // Missing files fall back to a navy monogram, so nothing has to exist for
  // this to work.
  function brandSlug(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function monogram(name) {
    const w = String(name || '?').trim().split(/\s+/);
    return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
  }

  // Logo lookup tries several conventions before giving up, so files can sit
  // in /img or /img/brands and be named "Lifebuoy.svg" or "lifebuoy.svg".
  // First one that loads wins; if none do, the monogram shows.
  // Known logos load on the first request; add a line here for each new
  // logo file. Keys are lower case with spaces and punctuation removed, so "CIF",
  // "Cif" and "Close Up" all find their file whatever case the database uses.
  const BRAND_LOGOS = {
    cif: '/img/Cif.svg', closeup: '/img/Closeup.svg', dove: '/img/Dove.svg', knorr: '/img/Knorr.svg',
    lifebuoy: '/img/Lifebuoy.svg', lux: '/img/Lux.svg', pears: '/img/Pears.svg', ponds: '/img/Ponds.svg',
    rexona: '/img/Rexona.svg', signal: '/img/Signal.svg', sunlight: '/img/Sunlight.svg', sunsilk: '/img/Sunsilk.svg',
    surf: '/img/Surf.svg', surfexcel: '/img/Surf.svg', vaseline: '/img/Vaseline.svg', viva: '/img/Viva.svg',
  };
  const logoKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function logoCandidates(name) {
    const raw = String(name || '').trim();
    const firstWord = raw.split(/[\s\-–—/&]+/)[0] || '';
    const known = BRAND_LOGOS[logoKey(raw)] || BRAND_LOGOS[logoKey(firstWord)];
    if (known) return [known];

    // Otherwise guess, loosest last: exact, hyphenated, punctuation stripped,
    // first word. Extension is the OUTER loop so every name form is tried as
    // .svg before anything is tried as .png — logos are almost always SVG,
    // and this cuts the worst case from 16 requests to 4.
    const compact = raw.replace(/[^A-Za-z0-9]/g, '');
    const first   = raw.split(/[\s\-–—/&]+/)[0] || '';
    const bases = [];
    [raw, brandSlug(raw), compact, compact.toLowerCase(), first, first.toLowerCase()]
      .forEach(b => { if (b && bases.indexOf(b) === -1) bases.push(b); });

    const out = [];
    ['svg', 'png', 'webp', 'jpg'].forEach(ext => {
      ['/img/', '/img/brands/'].forEach(dir => {
        bases.forEach(base => {
          const url = dir + encodeURIComponent(base) + '.' + ext;
          if (out.indexOf(url) === -1) out.push(url);
        });
      });
    });
    return out;
  }

  function brandMark(name, cls) {
    const list = logoCandidates(name);
    return `<span class="dd-mark ${cls || ''}" data-mono="${esc(monogram(name))}">
      <img src="${list[0]}" alt="" data-try="0"
           data-list="${esc(list.join('|'))}"
           onerror="window.__ddLogoFallback&&window.__ddLogoFallback(this)">
    </span>`;
  }

  // Step through the candidates on each 404, then fall back to the monogram.
  window.__ddLogoFallback = function (img) {
    const list = (img.getAttribute('data-list') || '').split('|').filter(Boolean);
    const i = parseInt(img.getAttribute('data-try') || '0', 10) + 1;
    if (i < list.length) {
      img.setAttribute('data-try', String(i));
      img.src = list[i];
      return;
    }
    const p = img.parentNode;
    if (p) p.classList.add('dd-mark-mono');
    img.remove();
  };

  // ── Shared open/close ──────────────────────────────────────────────────────
  function closeAll(except) {
    document.querySelectorAll('.dd.open').forEach(d => { if (d !== except) d.classList.remove('open'); });
  }
  document.addEventListener('click', e => { if (!e.target.closest('.dd')) closeAll(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

  function wireKeys(dd, itemSel) {
    dd.addEventListener('keydown', e => {
      const items = [...dd.querySelectorAll(itemSel + ':not([hidden])')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!dd.classList.contains('open')) { dd.classList.add('open'); items[0].focus(); return; }
        const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[n < 0 ? 0 : n].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (document.activeElement && document.activeElement.matches(itemSel)) {
          e.preventDefault(); document.activeElement.click();
        }
      } else if (e.key === 'Tab') {
        closeAll();
      }
    });
  }

  // ══ Brand switcher ═════════════════════════════════════════════════════════
  window.renderBrandSwitcher = function (brands, active) {
    const host = document.getElementById('brand-switcher-ui');
    if (!host) return;

    if (!brands || brands.length < 2) {
      const only = (brands && brands[0]) || { name: window.BRAND_NAME || '' };
      host.innerHTML = `<div class="dd dd-brand dd-static">
          <div class="dd-brand-btn" aria-disabled="true">
            ${brandMark(only.name)}
            <span class="dd-brand-txt"><span class="dd-brand-name">${esc(only.name)}</span>
              <span class="dd-brand-sub">${esc(window.BRAND_CONTEXT || 'Digital')}</span></span>
          </div>
        </div>`;
      return;
    }

    const cur = brands.find(b => b.brand_id === active) || brands[0];
    host.innerHTML = `<div class="dd dd-brand">
        <button type="button" class="dd-brand-btn" aria-haspopup="listbox" aria-expanded="false">
          ${brandMark(cur.name)}
          <span class="dd-brand-txt">
            <span class="dd-brand-name">${esc(cur.name)}</span>
            <span class="dd-brand-sub">${esc(window.BRAND_CONTEXT || 'Digital')}</span>
          </span>${CHEV}
        </button>
        <div class="dd-menu dd-menu-brand" role="listbox">
          <div class="dd-cap">Switch brand</div>
          ${brands.map(b => `
            <button type="button" class="dd-item dd-item-brand${b.brand_id === cur.brand_id ? ' on' : ''}"
                    role="option" aria-selected="${b.brand_id === cur.brand_id}" data-id="${esc(b.brand_id)}">
              ${brandMark(b.name, 'dd-mark-sm')}
              <span class="dd-brand-name">${esc(b.name)}</span>${TICK}
            </button>`).join('')}
        </div>
      </div>`;

    const dd  = host.querySelector('.dd');
    const btn = host.querySelector('.dd-brand-btn');

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = dd.classList.contains('open');
      closeAll(dd); dd.classList.toggle('open', !open);
      btn.setAttribute('aria-expanded', String(!open));
    });

    host.querySelectorAll('.dd-item-brand').forEach(it => {
      it.addEventListener('click', ev => {
        ev.stopPropagation();
        const id = it.dataset.id;
        dd.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        // switchBrand() reloads the data but does not re-run loadBrands(),
        // so update the button here rather than waiting for a re-render.
        host.querySelectorAll('.dd-item-brand').forEach(x => {
          const on = x === it;
          x.classList.toggle('on', on);
          x.setAttribute('aria-selected', String(on));
        });
        btn.querySelector('.dd-brand-name').textContent = it.querySelector('.dd-brand-name').textContent;
        const mk = btn.querySelector('.dd-mark');
        const src = it.querySelector('.dd-mark');
        if (mk && src) { mk.className = src.className.replace('dd-mark-sm', '').trim() + ' dd-mark';
                         mk.dataset.mono = src.dataset.mono; mk.innerHTML = src.innerHTML; }
        const sel = document.getElementById('brand-switcher');
        if (sel) sel.value = id;
        if (typeof switchBrand === 'function') switchBrand(id);
      });
    });

    wireKeys(dd, '.dd-item-brand');
  };

  // ══ Filter listboxes ═══════════════════════════════════════════════════════
  // Enhances a native <select>. The select stays as the source of truth.
  function enhance(select, opts) {
    opts = opts || {};
    if (!select || select.dataset.ddDone) return;
    select.dataset.ddDone = '1';
    select.setAttribute('data-dd-done', '1');

    const wrap = document.createElement('div');
    wrap.className = 'dd dd-filter';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('dd-native');

    const caption = opts.caption || '';
    const searchable = opts.searchable !== false && select.options.length > 8;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');

    function paintButton() {
      const o = select.options[select.selectedIndex];
      const isAll = !o || o.value === 'all' || o.value === '';
      wrap.classList.toggle('dd-set', !isAll);
      btn.innerHTML =
        (caption ? `<span class="dd-cap-inline">${esc(caption)}</span>` : '') +
        `<span class="dd-val">${esc(o ? o.text : '')}</span>` + CHEV;
    }

    function paintMenu() {
      const items = [...select.options].map((o, i) =>
        `<button type="button" class="dd-item${i === select.selectedIndex ? ' on' : ''}"
                 role="option" aria-selected="${i === select.selectedIndex}" data-i="${i}">
           <span class="dd-item-txt">${esc(o.text)}</span>${TICK}
         </button>`).join('');
      menu.innerHTML =
        (searchable ? `<input class="dd-search" type="text" placeholder="Search" aria-label="Search options">` : '') +
        `<div class="dd-list">${items}</div>`;

      menu.querySelectorAll('.dd-item').forEach(it => {
        it.addEventListener('click', ev => {
          // Stop here. paintMenu() below detaches this element, so if the
          // click keeps bubbling, any outside-click handler further up sees
          // a target that is no longer in the DOM and treats it as a click
          // away — which is what was closing the filters panel.
          ev.stopPropagation();
          select.selectedIndex = parseInt(it.dataset.i, 10);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          wrap.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
          paintButton(); paintMenu();
          btn.focus();
        });
      });

      const search = menu.querySelector('.dd-search');
      if (search) {
        search.addEventListener('click', e => e.stopPropagation());
        search.addEventListener('input', () => {
          const q = search.value.toLowerCase();
          menu.querySelectorAll('.dd-item').forEach(it => {
            it.hidden = !it.textContent.toLowerCase().includes(q);
          });
        });
      }
    }

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = wrap.classList.contains('open');
      closeAll(wrap);
      wrap.classList.toggle('open', !open);
      btn.setAttribute('aria-expanded', String(!open));
      if (!open) {
        const s = menu.querySelector('.dd-search');
        if (s) { s.value = ''; menu.querySelectorAll('.dd-item').forEach(i => i.hidden = false); s.focus(); }
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    paintButton(); paintMenu();
    wireKeys(wrap, '.dd-item');

    // Repaint when the options are rebuilt (brand switch) or the value is
    // reset from elsewhere (clearFilters, removeFilter).
    select.addEventListener('change', () => { paintButton(); paintMenu(); });
    select.dataset.ddRepaint = '1';
    wrap._ddRepaint = () => { paintButton(); paintMenu(); };
  }

  // Public: enhance any single <select>. Used by the KPI tab and the modals,
  // which build their selects at render time rather than in index.html.
  window.enhanceSelect = function (el, opts) {
    if (typeof el === 'string') el = document.getElementById(el);
    enhance(el, opts || {});
  };

  // Enhance every select in a container that has not been done yet.
  window.enhanceSelectsIn = function (root, opts) {
    if (typeof root === 'string') root = document.getElementById(root);
    if (!root) return;
    root.querySelectorAll('select:not([data-dd-done]):not(.dd-native)')
        .forEach(s => enhance(s, opts || {}));
  };

  window.enhanceFilterDropdowns = function () {
    // No inline caption here: every one of these sits under its own <label>
    // in the filters panel, so repeating the field name inside the control
    // just costs width and truncates the value.
    ['campaign-filter', 'month-filter', 'content-type-filter', 'origin-filter',
     'validation-filter', 'action-filter', 'status-filter']
      .forEach(id => enhance(document.getElementById(id)));
  };

  // populateFilters() rewrites the option lists — repaint after it runs.
  window.repaintFilterDropdowns = function () {
    document.querySelectorAll('.dd-filter').forEach(w => { if (w._ddRepaint) w._ddRepaint(); });
  };
})();

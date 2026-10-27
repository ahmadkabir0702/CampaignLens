// =====================================================================
//  polish.js: one motion layer for every section of Campaign Lens
//
//  Each section (Creative Hub, KPI, Creators, Pre-tests, Sign-off,
//  Repurposing, Share of Voice, Campaigns, Admin, Ask Lens) renders its
//  own markup. Wiring entrances into each of them would mean ten copies
//  that drift apart. This watches the DOM instead and applies the same
//  rules wherever the same kinds of thing appear:
//
//    Arrivals   Cards, tiles and panels rise in with a short stagger when
//               a section opens, the brand changes, a view tab is picked,
//               or new items are appended (show more, a new chat answer).
//               A re-render caused by typing or saving does not re-animate:
//               the screen should not twitch while someone is working.
//    Numbers    Figures in those arrivals count up to their value.
//    Bars       Meter and comparison fills grow from zero.
//    Success    Every success toast already draws a tick. If the button
//               that caused it is still on screen, it shows the tick too.
//
//  Skeletons, press feedback, modal and dropdown motion live elsewhere
//  (styles.css, motion.js) and already apply app-wide.
//
//  Reduced motion: nothing here runs; the CSS does the same.
//  Exposed as window.Polish.
// =====================================================================
(function () {
  'use strict';

  const reduced = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // What counts as a surface that arrives. One list for the whole app;
  // a new section joins by using one of these classes or adding its own.
  const SURFACE = [
    '.card', '.kpi', '.kpi-drawer-card',
    '.ms-card', '.cr-card', '.cr-row', '.creator-row',
    '.sg-card', '.sg-panel', '.sg-item',
    '.rp-card', '.rp-panel', '.rp-perf-tile',
    '.ad-card', '.ad-panel',
    '.cp-box', '.cp-row',
    '.sov-card', '.sov-kpi',
    '.bs-card',
    '.al-card', '.al-chart-card', '.al-review-card',
    '.organic-stat-row', '.mini-bar-row',
  ].join(',');

  const VALUE = [
    '.kpi-val', '.sov-kpi-val', '.sov-bar-val', '.bs-total-num', '.bs-num', '.bs-bar-val',
    '.ms-cut-n', '.ms-compare-v', '.ms-trend-v', '.cr-count', '.ad-count',
    '.dm-val', '.organic-stat-val', '.mini-bar-val',
  ].join(',');

  const FILL_X = '.mini-bar-fill,.sov-bar-fill,.bs-bar-fill,.ms-compare-fill,.al-usage-fill';
  const FILL_Y = '.ms-trend-fill';

  // Controls that change what a section is showing. A click on one arms
  // the next paint for an entrance.
  const VIEW_SWITCH = [
    '.nav-item', '[role="tab"]', '.cr-view', '.so-seg-btn', '.pt',
    '.glide > button', '.sov-cat', '.dd-brand-btn', '.dd-item',
  ].join(',');

  const ROOTS = ['#page-creatives', '#page-kpi', '#page-creators', '#page-pretests',
                 '#page-signoff', '#page-repurpose', '#page-admin', '#page-sov',
                 '#kpi-row', '.al-panel'];

  const MAX_STAGGER = 12;
  const STEP_MS = 26;

  // ---------------------------------------------------------------
  //  Arming
  //
  //  A paint is animated when something told us the view changed, not on
  //  every innerHTML. Armed until the next paint with surfaces in it, or
  //  until the data clearly is not coming.
  // ---------------------------------------------------------------
  let armedUntil = 0;
  const arm = (ms = 8000) => { armedUntil = performance.now() + ms; };
  const armed = () => performance.now() < armedUntil;

  // ---------------------------------------------------------------
  //  Arrivals
  // ---------------------------------------------------------------
  const seen = new WeakSet();

  function visible(el) {
    return el.isConnected && el.offsetParent !== null;
  }

  /** Surfaces inside `root`, outermost only, so a card and its rows do
   *  not both rise. */
  function topSurfaces(root) {
    const out = [];
    if (root.nodeType !== 1) return out;
    if (root.matches(SURFACE)) { out.push(root); return out; }
    const all = root.querySelectorAll(SURFACE);
    for (const el of all) {
      let p = el.parentElement, nested = false;
      while (p && p !== root) {
        if (p.matches(SURFACE)) { nested = true; break; }
        p = p.parentElement;
      }
      if (!nested) out.push(el);
    }
    return out;
  }

  function animate(nodes) {
    if (reduced()) return;
    let i = 0;
    const surfaces = [];
    for (const n of nodes) for (const s of topSurfaces(n)) {
      if (seen.has(s) || !visible(s)) continue;
      seen.add(s);
      surfaces.push(s);
    }
    for (const s of surfaces) {
      s.style.setProperty('--pl-i', Math.min(i++, MAX_STAGGER));
      s.classList.remove('pl-in');
      // Restart cleanly if the same element is reused.
      void s.offsetWidth;
      s.classList.add('pl-in');
      s.addEventListener('animationend', function done(e) {
        if (e.target !== s) return;
        s.classList.remove('pl-in');
        s.removeEventListener('animationend', done);
      });
    }
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      grow(n);
      countUp(n);
    }
    return surfaces.length;
  }

  // ---------------------------------------------------------------
  //  Bars
  // ---------------------------------------------------------------
  function grow(scope) {
    const pick = (sel) => (scope.matches && scope.matches(sel) ? [scope] : [])
      .concat(Array.from(scope.querySelectorAll(sel)));
    for (const el of pick(FILL_X)) {
      if (el.classList.contains('grow-x') || el.classList.contains('no-grow')) continue;
      el.classList.remove('pl-grow-x'); void el.offsetWidth; el.classList.add('pl-grow-x');
    }
    for (const el of pick(FILL_Y)) {
      el.classList.remove('pl-grow-y'); void el.offsetWidth; el.classList.add('pl-grow-y');
    }
  }

  // ---------------------------------------------------------------
  //  Numbers
  //
  //  Only the digits move. "Rs. 1,250", "72% / 28%" and "1.2M" keep
  //  their shape; anything with more than six numbers in it, or already
  //  animated by rolling digits, is left alone.
  // ---------------------------------------------------------------
  const NUM = /\d[\d,]*(?:\.\d+)?/g;

  function countUp(scope) {
    if (reduced()) return;
    const els = (scope.matches && scope.matches(VALUE) ? [scope] : [])
      .concat(Array.from(scope.querySelectorAll(VALUE)));
    for (const el of els) {
      if (el.querySelector('.roll-d, svg, img') || el.children.length > 2) continue;
      const text = el.textContent;
      const nums = Array.from(text.matchAll(NUM));
      if (!nums.length || nums.length > 6) continue;
      const parts = text.split(NUM);
      const vals = nums.map(m => parseFloat(m[0].replace(/,/g, '')));
      if (vals.every(v => v === 0)) continue;
      const decs = nums.map(m => (m[0].split('.')[1] || '').length);
      const grouped = nums.map(m => m[0].includes(','));
      // Text nodes only, so child markup (a unit in a span) survives.
      if (el.children.length) continue;
      const t0 = performance.now(), D = 620;
      const frame = (now) => {
        if (!el.isConnected) return;
        const p = Math.min(1, (now - t0) / D);
        const e = 1 - Math.pow(1 - p, 3);
        let out = parts[0];
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i] * e;
          out += (grouped[i] || vals[i] >= 1000
            ? v.toLocaleString('en-US', { minimumFractionDigits: decs[i], maximumFractionDigits: decs[i] })
            : v.toFixed(decs[i])) + parts[i + 1];
        }
        el.textContent = p < 1 ? out : text;
        if (p < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
  }

  // ---------------------------------------------------------------
  //  Watching
  // ---------------------------------------------------------------
  function onMutations(list) {
    const appended = [], replaced = [];
    for (const m of list) {
      if (m.type !== 'childList' || !m.addedNodes.length) continue;
      const target = m.target;
      const isAppend = !m.removedNodes.length && target.childNodes.length > m.addedNodes.length;
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        (isAppend ? appended : replaced).push(n);
      }
    }
    if (appended.length) animate(appended);
    if (replaced.length && armed()) {
      const n = animate(replaced);
      if (n) armedUntil = performance.now() + 250;   // let the rest of this paint in, then disarm
    }
  }

  function observe() {
    const mo = new MutationObserver(onMutations);
    for (const sel of ROOTS) {
      document.querySelectorAll(sel).forEach(el => mo.observe(el, { childList: true, subtree: true }));
    }
    // Ask Lens builds its panel on first open; catch it when it appears.
    const late = new MutationObserver(() => {
      const p = document.querySelector('.al-panel');
      if (p && !p.__plWatched) { p.__plWatched = true; mo.observe(p, { childList: true, subtree: true }); }
    });
    late.observe(document.body, { childList: true });
  }

  function wrap(name) {
    const fn = window[name];
    if (typeof fn !== 'function' || fn.__pl) return;
    const w = function () { arm(); return fn.apply(this, arguments); };
    w.__pl = true;
    window[name] = w;
  }

  // ---------------------------------------------------------------
  //  Success on the button that caused it
  // ---------------------------------------------------------------
  let lastButton = null, lastAt = 0;

  function hookToast() {
    const fn = window.toast;
    if (typeof fn !== 'function' || fn.__pl) return;
    const w = function (message, tone) {
      const r = fn.apply(this, arguments);
      if (tone !== 'error' && lastButton && performance.now() - lastAt < 5000 && visible(lastButton)) {
        tickButton(lastButton);
      }
      lastButton = null;
      return r;
    };
    w.__pl = true;
    window.toast = w;
  }

  function tickButton(btn) {
    if (reduced()) return;
    const cs = getComputedStyle(btn);
    btn.style.setProperty('--pl-tick', cs.color);
    btn.classList.remove('pl-done'); void btn.offsetWidth;
    btn.classList.add('pl-done');
    setTimeout(() => btn.classList.remove('pl-done'), 1100);
  }

  function install() {
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest && e.target.closest('button, .btn-primary, .modal-btn, [role="button"]');
      if (b) { lastButton = b; lastAt = performance.now(); }
      if (e.target.closest && e.target.closest(VIEW_SWITCH)) arm();
    }, { passive: true, capture: true });

    ['setNav', 'switchBrand'].forEach(wrap);
    hookToast();
    observe();
    arm();            // the first paint after load
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  window.Polish = { arm, animate, countUp, grow, tickButton };
})();

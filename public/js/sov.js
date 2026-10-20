/**
 * sov.js — Share of voice page.
 *
 * Shows the social share of voice for the category the active brand belongs to:
 * Lux, Lifebuoy and Pears all open skin cleansing, each with its own bar
 * highlighted. A brand in more than one category gets a switch between them.
 *
 * Percentages only, by design. The server sends shares (0 to 1) and nothing
 * else, so there are no post, comment or mention counts to show.
 *
 * Every chart has a "What's behind this" link, and every tracked brand's bar
 * can be clicked: both open a side panel written during the monthly run (the
 * read, what drove it, what it means for the brand in view and a next step,
 * and what consumers said). Nothing is written on click.
 */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MEASURES = [
    ['shareOfVoice', 'Total voice'],
    ['shareNoContest', 'Excl. promotions'],
    ['shareEngagement', 'Engagement'],
    ['shareEarned', 'Earned voice'],
  ];
  const MEASURE_NOTE = {
    shareOfVoice: 'Share of all brand conversation in the category, owned and earned.',
    shareNoContest: 'Share of brand conversation, excluding contest and giveaway activity.',
    shareEngagement: 'Share of total engagement on brand-related content.',
    shareEarned: 'Share of earned conversation: consumers, unpaid creators, sellers and media. Brand pages and brand-backed creator content are left out.',
  };
  const GROUP_COLOR = {
    'Unilever': 'var(--navy)',
    'Competitor': 'var(--s4)',
    'Local herbal and home brand': 'var(--pos)',
    'Imported': 'var(--warn)',
    'Laundry soap used on skin': 'var(--neg)',
    'Other brand': 'var(--s5)',
  };

  const ORIGIN_COLOR = { 'Brand pages': 'var(--navy)', 'Brand-backed creators': 'var(--s3)', 'Earned': 'var(--pos)' };
  const SECTION_TITLE = {
    share: 'Share of voice by brand', trend: 'Share of voice over time', sentiment: 'Sentiment',
    public: 'Who leads earned conversation', origin: "Where each brand's voice comes from",
    topics: 'Conversation themes', intent: 'Conversation intent', source: 'Voice by source',
  };

  const state = { data: null, page: null, cat: 0, measure: 'shareOfVoice', chart: null, trend: 'month', drawerFrom: null };

  function pageEl() { return document.getElementById('page-sov'); }

  async function api(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function pct(v, digits = 1) {
    if (v == null || isNaN(v)) return '–';
    if (v > 0 && v < 0.001) return '<0.1%';
    return (v * 100).toFixed(digits) + '%';
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function week(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function refresh() {
    const page = pageEl();
    if (!page) return;
    if (!state.data) page.innerHTML = '<div class="load-msg">Loading share of voice…</div>';
    try {
      // Internal accounts also see a period saved for review, under a banner.
      const preview = typeof CURRENT_IS_INTERNAL !== 'undefined' && CURRENT_IS_INTERNAL;
      state.data = await api('/api/sov' + (preview ? '?preview=1' : ''));
      if (state.cat >= state.data.categories.length) state.cat = 0;
      render();
    } catch (e) {
      page.innerHTML = `<div class="load-msg load-msg-error">Couldn't load share of voice. ${esc(e.message)}
        <button class="load-retry" onclick="SOV.refresh()">Try again</button></div>`;
    }
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────
  // A row opens its brand's panel when there is one.
  const opener = key => key && hasPanel(key)
    ? ` role="button" tabindex="0" data-panel="${esc(key)}" title="See what's behind this"` : '';

  function bars(rows, opts = {}) {
    const max = Math.max(...rows.map(r => r.value || 0), 0.0001);
    return `<div class="sov-bars">${rows.map((r, i) => `
      <div class="sov-bar ${r.active ? 'is-active' : ''} ${r.panel && hasPanel(r.panel) ? 'is-open' : ''}"${opener(r.panel)}>
        <div class="sov-bar-name" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="sov-bar-track"><div class="sov-bar-fill grow-x ${r.cls || ''}" data-k="${esc(r.label)}" style="--i:${i};width:${((r.value || 0) / (opts.max || max) * 100).toFixed(2)}%;${r.color ? `background:${r.color}` : ''}"></div></div>
        <div class="sov-bar-val">${pct(r.value)}</div>
      </div>`).join('')}</div>`;
  }

  function brandBars(cat) {
    const m = state.measure;
    const rows = cat.brands
      .filter(b => b[m] != null)
      .sort((a, b) => (b[m] || 0) - (a[m] || 0))
      .map(b => ({ label: b.name, value: b[m], active: b.isActive, cls: b.isActive ? 'is-active' : b.isUnilever ? 'is-unilever' : '', panel: 'brand:' + b.name }));
    return bars(rows);
  }

  function kpis(cat, brand) {
    const sorted = [...cat.brands].sort((a, b) => (b.shareOfVoice || 0) - (a.shareOfVoice || 0));
    const rank = sorted.findIndex(b => b.isActive) + 1;
    const uni = cat.brands.filter(b => b.isUnilever).reduce((s, b) => s + (b.shareOfVoice || 0), 0);
    const uniPublic = cat.brands.filter(b => b.isUnilever).reduce((s, b) => s + (b.sharePublic || 0), 0);
    const tile = (label, val, sub) => `<div class="sov-kpi"><div class="sov-kpi-label">${esc(label)}</div>
      <div class="sov-kpi-val">${val}</div><div class="sov-kpi-sub">${esc(sub)}</div></div>`;
    if (!brand) {
      return `<div class="sov-kpis">${tile('Unilever share of voice', pct(uni), 'All Unilever brands in the category')}
        ${tile('Unilever share of earned voice', pct(uniPublic), 'Across every brand in earned conversation')}</div>`;
    }
    const pos = brand.sentiment ? pct(brand.sentiment.positive, 0) : '–';
    return `<div class="sov-kpis">
      ${tile(`${brand.name} social share of voice`, pct(brand.shareOfVoice), rank ? `${ordinal(rank)} in ${cat.name.toLowerCase()}` : '')}
      ${tile(`${brand.name} share of engagement`, pct(brand.shareEngagement), 'Of total engagement on brand-related content')}
      ${tile(`${brand.name} share of earned voice`, pct(brand.sharePublic), 'Across every brand in earned conversation')}
      ${tile('Unilever social share of voice', pct(uni), 'All Unilever brands in the category')}
      ${tile(`${brand.name} positive sentiment`, pos, 'Of consumer conversation about the brand')}
    </div>`;
  }

  function sentiment(cat) {
    const rows = [...cat.brands].sort((a, b) => (b.shareOfVoice || 0) - (a.shareOfVoice || 0));
    return `<div class="sov-legend"><span><i style="background:var(--pos)"></i>Positive</span><span><i style="background:var(--s5)"></i>Neutral</span><span><i style="background:var(--neg)"></i>Negative</span></div>
      <div class="sov-bars">${rows.map((b, i) => {
        const s = b.sentiment;
        const track = s
          ? `<div class="sov-sent-track grow-x" style="--i:${i}" title="Positive ${pct(s.positive)}, neutral ${pct(s.neutral)}, negative ${pct(s.negative)}">
              <i style="width:${s.positive * 100}%;background:var(--pos)"></i><i style="width:${s.neutral * 100}%;background:var(--s5)"></i><i style="width:${s.negative * 100}%;background:var(--neg)"></i></div>`
          : '<div class="sov-sent-none">Too little conversation to measure</div>';
        return `<div class="sov-sent sov-bar ${b.isActive ? 'is-active' : ''} ${hasPanel('brand:' + b.name) ? 'is-open' : ''}"${opener('brand:' + b.name)}><div class="sov-bar-name">${esc(b.name)}</div>${track}
          <div class="sov-bar-val">${s ? pct(s.positive, 0) : ''}</div></div>`;
      }).join('')}</div>`;
  }

  function publicBrands(cat) {
    const active = cat.brands.find(b => b.isActive);
    const groups = [...new Set(cat.publicBrands.map(r => r.group).filter(Boolean))];
    const tracked = new Set(cat.brands.map(b => b.name));
    const rows = cat.publicBrands.slice(0, 15).map(r => ({
      label: r.label, value: r.value, panel: tracked.has(r.label) ? 'brand:' + r.label : null,
      active: active && r.label === active.name,
      color: r.label === (active && active.name) ? 'var(--navy)' : (GROUP_COLOR[r.group] || 'var(--s5)'),
    }));
    return `<div class="sov-legend">${groups.map(g => `<span><i style="background:${GROUP_COLOR[g] || 'var(--s5)'}"></i>${esc(g)}</span>`).join('')}</div>${bars(rows)}`;
  }

  function simpleBars(list) {
    return bars(list.map((r, i) => ({ label: r.label, value: r.value, color: i === 0 ? 'var(--s2)' : 'var(--s4)' })));
  }

  // ── Where each brand's voice comes from ──────────────────────────────────
  function origin(cat) {
    const by = {};
    for (const r of cat.origin || []) (by[r.brand] ||= {})[r.source] = r.value;
    const rows = [...cat.brands].filter(b => by[b.name]).sort((a, b) => (b.shareOfVoice || 0) - (a.shareOfVoice || 0));
    const parts = Object.keys(ORIGIN_COLOR);
    return `<div class="sov-legend">${parts.map(k => `<span><i style="background:${ORIGIN_COLOR[k]}"></i>${esc(k)}</span>`).join('')}</div>
      <div class="sov-bars">${rows.map((b, i) => {
        const o = by[b.name];
        return `<div class="sov-sent sov-bar ${b.isActive ? 'is-active' : ''} ${hasPanel('brand:' + b.name) ? 'is-open' : ''}"${opener('brand:' + b.name)}>
          <div class="sov-bar-name">${esc(b.name)}</div>
          <div class="sov-sent-track grow-x" style="--i:${i}" title="${parts.map(k => `${k} ${pct(o[k] || 0)}`).join(', ')}">
            ${parts.map(k => `<i style="width:${((o[k] || 0) * 100).toFixed(2)}%;background:${ORIGIN_COLOR[k]}"></i>`).join('')}</div>
          <div class="sov-bar-val">${pct(o['Earned'] || 0, 0)}</div></div>`;
      }).join('')}</div>
      <p class="sov-note sov-note-foot">The figure on the right is the earned part.</p>`;
  }

  // ── Trend chart: month by month, or week by week ─────────────────────────
  function monthName(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function drawWeekly(cat, reduced) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    const canvas = document.getElementById('sov-weekly');
    const byMonth = state.trend === 'month' && (cat.monthly || []).length;
    const rowsIn = byMonth ? cat.monthly.map(r => ({ week: r.month, brand: r.brand, value: r.value })) : cat.weekly;
    if (!canvas || typeof Chart === 'undefined' || !rowsIn.length) return;
    const weeks = [...new Set(rowsIn.map(r => r.week))].sort();
    const val = (brands) => weeks.map(w => rowsIn.filter(r => r.week === w && brands.includes(r.brand)).reduce((s, r) => s + r.value, 0));
    const active = cat.brands.find(b => b.isActive);
    const uniNames = cat.brands.filter(b => b.isUnilever).map(b => b.name);
    const css = getComputedStyle(document.documentElement);
    const c = name => css.getPropertyValue(name).trim();
    const datasets = [];
    if (active) datasets.push({ label: active.name, data: val([active.name]), borderColor: c('--navy'), backgroundColor: c('--navy'),
      fill: { target: 'origin', above: 'rgba(15,110,140,.08)' } });
    datasets.push({ label: 'All Unilever brands', data: val(uniNames), borderColor: c('--s4'), backgroundColor: c('--s4'), borderDash: [5, 4] });
    const lead = [...cat.brands].filter(b => !b.isUnilever).sort((a, b) => (b.shareOfVoice || 0) - (a.shareOfVoice || 0))[0];
    if (lead) datasets.push({ label: lead.name, data: val([lead.name]), borderColor: c('--ink-300'), backgroundColor: c('--ink-300') });
    state.chart = new Chart(canvas, {
      type: 'line',
      data: { labels: weeks.map(byMonth ? monthName : week), datasets: datasets.map(d => ({ ...d, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25 })) },
      options: {
        responsive: true, maintainAspectRatio: false,
        // The lines draw in once, quickly; not under reduced motion.
        animation: reduced ? false : { duration: 420, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { family: 'Onest', size: 12 }, color: c('--ink-500') } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${pct(ctx.parsed.y)}` } },
        },
        scales: {
          y: { min: 0, ticks: { callback: v => Math.round(v * 100) + '%', font: { family: 'Onest', size: 11 }, color: c('--ink-400') }, grid: { color: c('--line-soft') } },
          x: { ticks: { maxTicksLimit: 7, font: { family: 'Onest', size: 11 }, color: c('--ink-400') }, grid: { display: false } },
        },
      },
    });
  }

  // ── Page ───────────────────────────────────────────────────────────────────
  function render() {
    const page = pageEl();
    const d = state.data;
    if (!page || !d) return;
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    if (!d.categories.length) {
      page.innerHTML = `<div class="sov-empty">Share of voice has not been set up for ${esc(d.brand.name)}'s category yet.</div>`;
      return;
    }
    const cat = d.categories[state.cat];
    const switcher = d.categories.length > 1
      ? `<div class="sov-cats" role="group" aria-label="Category">${d.categories.map((c, i) =>
          `<button class="sov-cat" aria-pressed="${i === state.cat}" onclick="SOV.setCategory(${i})">${esc(c.name)}</button>`).join('')}</div>` : '';

    if (!cat.period) {
      page.innerHTML = `<div class="sov-page"><div class="sov-head">${switcher}</div>
        <div class="sov-empty">There are no published results for ${esc(cat.name.toLowerCase())} yet.</div></div>`;
      return;
    }
    const brand = cat.brands.find(b => b.isActive);
    state.panels = cat.panels || {};
    const hasMonthly = (cat.monthly || []).length > 0;
    const trendBy = hasMonthly ? state.trend : 'week';

    const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    page.innerHTML = `<div class="sov-page">
      <div class="sov-head">
        <div class="sov-context">
          <span class="sov-chip"><b>${esc(cat.name)}</b></span>
          <span class="sov-chip">Sri Lanka</span>
          <span class="sov-chip">${esc(cat.period.label)}</span>
          ${brand ? `<span class="sov-chip sov-chip-brand"><i></i>${esc(brand.name)} highlighted</span>` : ''}
        </div>
        ${switcher}
      </div>

      ${cat.period.preview ? `<div class="sov-preview" role="status"><b>Preview.</b> This period is saved for review and is not on the page for brand teams yet.</div>` : ''}

      ${kpis(cat, brand)}

      ${cat.insights.length ? `<div class="sov-card" id="sov-findings"><h3>What we found</h3>
        <ul class="sov-insights">${cat.insights.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}

      <div class="sov-grid">
        <div class="sov-card" id="sov-brands">
          <div class="sov-card-head"><h3>Share of voice by brand</h3>${behind('share')}
            <div class="sov-seg" role="group" aria-label="Measure">${MEASURES.map(([k, n]) =>
              `<button aria-pressed="${state.measure === k}" onclick="SOV.setMeasure('${k}')">${n}</button>`).join('')}</div></div>
          <p class="sov-note">${esc(MEASURE_NOTE[state.measure])}${anyBrandPanel(cat) ? ' Click a brand for its detail.' : ''}</p>
          <div class="sov-legend"><span><i style="background:var(--navy)"></i>${esc(brand ? brand.name : 'Selected brand')}</span>
            <span><i style="background:var(--s3)"></i>Other Unilever brands</span><span><i style="background:var(--s5)"></i>Competitors</span></div>
          <div id="sov-brand-bars">${brandBars(cat)}</div>
        </div>
        <div class="sov-card" id="sov-trend">
          <div class="sov-card-head"><h3>Share of voice ${trendBy === 'month' ? 'by month' : 'by week'}</h3>${behind('trend')}</div>
          ${hasMonthly ? `<div class="sov-seg sov-seg-trend" role="group" aria-label="Trend by">
            <button aria-pressed="${trendBy === 'month'}" onclick="SOV.setTrend('month')">By month</button>
            <button aria-pressed="${trendBy === 'week'}" onclick="SOV.setTrend('week')">By week</button></div>` : ''}
          <p class="sov-note">${trendBy === 'month' ? 'Monthly share of category conversation.' : 'Weekly share of category conversation. Peaks follow campaign moments.'}</p>
          <div class="sov-chart"><canvas id="sov-weekly" aria-label="Share of voice by week"></canvas></div>
        </div>
      </div>

      <div class="sov-grid">
        <div class="sov-card" id="sov-sentiment">
          <div class="sov-card-head"><h3>Sentiment</h3>${behind('sentiment')}</div>
          <p class="sov-note">Tone of consumer conversation about each brand. Brand-published content is excluded.</p>
          ${sentiment(cat)}
        </div>
        ${cat.publicBrands.length ? `<div class="sov-card" id="sov-public">
          <div class="sov-card-head"><h3>Who leads earned conversation</h3>${behind('public')}</div>
          <p class="sov-note">Share of earned voice by brand, including brands outside this tracker.</p>
          ${publicBrands(cat)}
        </div>` : ''}
      </div>

      ${(cat.origin || []).length ? `<div class="sov-card" id="sov-origin">
        <div class="sov-card-head"><h3>Where each brand's voice comes from</h3>${behind('origin')}</div>
        <p class="sov-note">Each brand's voice split three ways: its own pages, creator content made with the brand, and earned conversation. Conversation on creator content made with a brand is earned.</p>
        ${origin(cat)}
      </div>` : ''}

      <div class="sov-grid-3">
        ${cat.topics.length ? `<div class="sov-card" id="sov-topics"><div class="sov-card-head"><h3>Conversation themes</h3>${behind('topics')}</div>
          <p class="sov-note">Share of category conversation by theme.</p>${simpleBars(cat.topics)}</div>` : ''}
        ${cat.commentTypes.length ? `<div class="sov-card" id="sov-comment-types"><div class="sov-card-head"><h3>Conversation intent</h3>${behind('intent')}</div>
          <p class="sov-note">What consumers are doing in the conversation.</p>${simpleBars(cat.commentTypes)}</div>` : ''}
        ${cat.authorTypes.length ? `<div class="sov-card" id="sov-authors"><div class="sov-card-head"><h3>Voice by source</h3>${behind('source')}</div>
          <p class="sov-note">Who makes the category content outside brand pages, including creator content made with a brand.</p>${simpleBars(cat.authorTypes)}</div>` : ''}
      </div>
    </div>`;
    drawWeekly(cat, reduced);
    if (typeof glide === 'function') {
      glide('sov-measure', page.querySelector('#sov-brands .sov-seg'));
      glide('sov-cat', page.querySelector('.sov-cats'));
      glide('sov-trend', page.querySelector('.sov-seg-trend'));
    }
    wirePanels(page);
  }

  // ── "What's behind this" ───────────────────────────────────────────────────
  function hasPanel(key) { return !!(state.panels && state.panels[key] && state.panels[key].read); }
  function anyBrandPanel(cat) { return cat.brands.some(b => hasPanel('brand:' + b.name)); }
  function behind(name) {
    return hasPanel('section:' + name)
      ? `<button class="sov-behind" data-panel="section:${name}">What's behind this</button>` : '';
  }

  function wirePanels(page) {
    if (page.dataset.panelsWired) return;
    page.dataset.panelsWired = '1';
    page.addEventListener('click', e => {
      const el = e.target.closest('[data-panel]');
      if (el && page.contains(el)) openPanel(el.dataset.panel, el);
    });
    page.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target.closest('[data-panel][role="button"]');
      if (el) { e.preventDefault(); openPanel(el.dataset.panel, el); }
    });
  }

  // What people are saying: positive and negative, each with a short read
  // of what that side is about and the lines that show it.
  function quoteHTML(q) {
    return `<blockquote class="sov-quote">“${esc(q.text)}”${q.translated ? '<span>Translated</span>' : ''}</blockquote>`;
  }
  function voicesHTML(p) {
    const v = p.voices;
    if (!v) {
      return p.quotes.length ? `<section><h4>What people are saying</h4>${p.quotes.map(quoteHTML).join('')}</section>` : '';
    }
    const side = (key, label, cls) => {
      const s = v[key] || {};
      const qs = s.quotes || [];
      if (!s.insight && !qs.length) return '';
      return `<div class="sov-voice ${cls}"><h5>${label}</h5>
        ${s.insight ? `<p class="sov-voice-read">${esc(s.insight)}</p>` : ''}
        ${qs.length ? qs.map(quoteHTML).join('') : ''}</div>`;
    };
    const body = side('positive', 'Positive', 'is-pos') + side('negative', 'Negative', 'is-neg');
    return body ? `<section><h4>What people are saying</h4>${body}</section>` : '';
  }

  function openPanel(key, from) {
    const p = state.panels && state.panels[key];
    if (!p) return;
    const cat = state.data.categories[state.cat];
    const brand = cat.brands.find(b => b.isActive);
    const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const title = kind === 'brand' ? name : (SECTION_TITLE[name] || 'What is behind this');
    closePanel(true);
    state.drawerFrom = from || null;
    const wrap = document.createElement('div');
    wrap.className = 'sov-drawer-wrap';
    wrap.innerHTML = `<div class="sov-scrim" data-close></div>
      <aside class="sov-drawer" role="dialog" aria-modal="true" aria-labelledby="sov-drawer-title">
        <div class="sov-drawer-head">
          <div><div class="sov-drawer-kicker">${esc(cat.name)} · ${esc(cat.period.label)}</div>
            <h2 id="sov-drawer-title">${esc(title)}</h2></div>
          <button class="sov-drawer-x" data-close aria-label="Close">×</button>
        </div>
        <div class="sov-drawer-body">
          <section><h4>What this shows</h4><p>${esc(p.read)}</p></section>
          ${p.drivers.length ? `<section><h4>What drove it</h4><ul>${p.drivers.map(d => `<li>${esc(d)}</li>`).join('')}</ul></section>` : ''}
          ${p.implication ? `<section class="sov-for"><h4>For ${esc(brand ? brand.name : 'your brand')}</h4><p>${esc(p.implication)}</p>
            ${p.nextStep ? `<p class="sov-next"><b>Next step</b> ${esc(p.nextStep)}</p>` : ''}</section>` : ''}
          ${voicesHTML(p)}
        </div>
      </aside>`;
    document.body.appendChild(wrap);
    document.body.classList.add('sov-drawer-open');
    requestAnimationFrame(() => wrap.classList.add('is-in'));
    wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) closePanel(); });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
      if (e.key === 'Tab') {
        // Keep focus inside the panel while it is open.
        const f = [...wrap.querySelectorAll('button')];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    wrap.querySelector('.sov-drawer-x').focus();
  }

  function closePanel(instant) {
    const wrap = document.querySelector('.sov-drawer-wrap');
    if (!wrap) return;
    const from = state.drawerFrom;
    state.drawerFrom = null;
    document.body.classList.remove('sov-drawer-open');
    if (instant) wrap.remove();
    else { wrap.classList.remove('is-in'); setTimeout(() => wrap.remove(), 200); }
    if (from && document.contains(from)) from.focus();
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────
  function onPage(page) {
    state.page = page;
    if (page === 'sov') {
      if (state.data) render();
      refresh();
    } else {
      closePanel(true);
      if (state.chart) { state.chart.destroy(); state.chart = null; }
    }
  }

  function onBrandChange() {
    state.data = null;
    state.cat = 0;
    if (state.page === 'sov') refresh();
  }

  function setMeasure(k) {
    state.measure = k;
    if (!state.data) return;
    const cat = state.data.categories[state.cat];
    const el = document.getElementById('sov-brand-bars');
    if (el && cat) {
      const key = f => f.dataset.k;
      const before = typeof barWidths === 'function' ? barWidths([...el.querySelectorAll('.sov-bar-fill')], key) : null;
      el.innerHTML = brandBars(cat);
      if (before) slideBars([...el.querySelectorAll('.sov-bar-fill')], before, key);
      document.querySelectorAll('#sov-brands .sov-seg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.getAttribute('onclick').includes(`'${k}'`))));
      if (typeof glide === 'function') glide('sov-measure', document.querySelector('#sov-brands .sov-seg'));
      const note = document.querySelector('#sov-brands .sov-note');
      if (note) note.textContent = MEASURE_NOTE[k];
    }
  }

  function setCategory(i) { state.cat = i; render(); }
  function setTrend(k) { state.trend = k; render(); }

  // switchBrand() lives in dashboard.js and knows nothing about this page.
  // Wrap it so a brand change reloads share of voice too. Every caller,
  // including the brand dropdown, goes through the global name.
  const origSwitch = window.switchBrand;
  if (typeof origSwitch === 'function') {
    window.switchBrand = async function (brandId) {
      const r = await origSwitch.apply(this, arguments);
      onBrandChange();
      return r;
    };
  }

  window.SOV = { onPage, onBrandChange, refresh, setMeasure, setCategory, setTrend, openPanel, closePanel };
})();

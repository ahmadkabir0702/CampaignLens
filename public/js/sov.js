/**
 * sov.js — Share of voice page.
 *
 * Shows the social share of voice for the category the active brand belongs to:
 * Lux, Lifebuoy and Pears all open skin cleansing, each with its own bar
 * highlighted. A brand in more than one category gets a switch between them.
 *
 * Percentages only, by design. The server sends shares (0 to 1) and nothing
 * else, so there are no post, comment or mention counts to show.
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
    shareEarned: 'Share of earned conversation, driven by consumers, creators and communities rather than the brands.',
  };
  const GROUP_COLOR = {
    'Unilever': 'var(--navy)',
    'Competitor': 'var(--s4)',
    'Local herbal and home brand': 'var(--pos)',
    'Imported': 'var(--warn)',
    'Laundry soap used on skin': 'var(--neg)',
  };

  const state = { data: null, page: null, cat: 0, measure: 'shareOfVoice', chart: null };

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
      state.data = await api('/api/sov');
      if (state.cat >= state.data.categories.length) state.cat = 0;
      render();
    } catch (e) {
      page.innerHTML = `<div class="load-msg load-msg-error">Couldn't load share of voice. ${esc(e.message)}
        <button class="load-retry" onclick="SOV.refresh()">Try again</button></div>`;
    }
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────
  function bars(rows, opts = {}) {
    const max = Math.max(...rows.map(r => r.value || 0), 0.0001);
    return `<div class="sov-bars">${rows.map(r => `
      <div class="sov-bar ${r.active ? 'is-active' : ''}">
        <div class="sov-bar-name" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="sov-bar-track"><div class="sov-bar-fill ${r.cls || ''}" style="width:${((r.value || 0) / (opts.max || max) * 100).toFixed(2)}%;${r.color ? `background:${r.color}` : ''}"></div></div>
        <div class="sov-bar-val">${pct(r.value)}</div>
      </div>`).join('')}</div>`;
  }

  function brandBars(cat) {
    const m = state.measure;
    const rows = cat.brands
      .filter(b => b[m] != null)
      .sort((a, b) => (b[m] || 0) - (a[m] || 0))
      .map(b => ({ label: b.name, value: b[m], active: b.isActive, cls: b.isActive ? 'is-active' : b.isUnilever ? 'is-unilever' : '' }));
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
      <div class="sov-bars">${rows.map(b => {
        const s = b.sentiment;
        const track = s
          ? `<div class="sov-sent-track" title="Positive ${pct(s.positive)}, neutral ${pct(s.neutral)}, negative ${pct(s.negative)}">
              <i style="width:${s.positive * 100}%;background:var(--pos)"></i><i style="width:${s.neutral * 100}%;background:var(--s5)"></i><i style="width:${s.negative * 100}%;background:var(--neg)"></i></div>`
          : '<div class="sov-sent-none">Too little conversation to measure</div>';
        return `<div class="sov-sent sov-bar ${b.isActive ? 'is-active' : ''}"><div class="sov-bar-name">${esc(b.name)}</div>${track}
          <div class="sov-bar-val">${s ? pct(s.positive, 0) : ''}</div></div>`;
      }).join('')}</div>`;
  }

  function publicBrands(cat) {
    const active = cat.brands.find(b => b.isActive);
    const groups = [...new Set(cat.publicBrands.map(r => r.group).filter(Boolean))];
    const rows = cat.publicBrands.slice(0, 15).map(r => ({
      label: r.label, value: r.value,
      active: active && r.label === active.name,
      color: r.label === (active && active.name) ? 'var(--navy)' : (GROUP_COLOR[r.group] || 'var(--s5)'),
    }));
    return `<div class="sov-legend">${groups.map(g => `<span><i style="background:${GROUP_COLOR[g] || 'var(--s5)'}"></i>${esc(g)}</span>`).join('')}</div>${bars(rows)}`;
  }

  function simpleBars(list) {
    return bars(list.map((r, i) => ({ label: r.label, value: r.value, color: i === 0 ? 'var(--s2)' : 'var(--s4)' })));
  }

  // ── Weekly chart ───────────────────────────────────────────────────────────
  function drawWeekly(cat) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    const canvas = document.getElementById('sov-weekly');
    if (!canvas || typeof Chart === 'undefined' || !cat.weekly.length) return;
    const weeks = [...new Set(cat.weekly.map(r => r.week))].sort();
    const val = (brands) => weeks.map(w => cat.weekly.filter(r => r.week === w && brands.includes(r.brand)).reduce((s, r) => s + r.value, 0));
    const active = cat.brands.find(b => b.isActive);
    const uniNames = cat.brands.filter(b => b.isUnilever).map(b => b.name);
    const css = getComputedStyle(document.documentElement);
    const c = name => css.getPropertyValue(name).trim();
    const datasets = [];
    if (active) datasets.push({ label: active.name, data: val([active.name]), borderColor: c('--navy'), backgroundColor: c('--navy') });
    datasets.push({ label: 'All Unilever brands', data: val(uniNames), borderColor: c('--s4'), backgroundColor: c('--s4'), borderDash: [5, 4] });
    const lead = [...cat.brands].filter(b => !b.isUnilever).sort((a, b) => (b.shareOfVoice || 0) - (a.shareOfVoice || 0))[0];
    if (lead) datasets.push({ label: lead.name, data: val([lead.name]), borderColor: c('--ink-300'), backgroundColor: c('--ink-300') });
    state.chart = new Chart(canvas, {
      type: 'line',
      data: { labels: weeks.map(week), datasets: datasets.map(d => ({ ...d, borderWidth: 2, pointRadius: 2.5, tension: 0 })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { family: 'Rubik', size: 12 }, color: c('--ink-500') } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${pct(ctx.parsed.y)}` } },
        },
        scales: {
          y: { min: 0, ticks: { callback: v => Math.round(v * 100) + '%', font: { family: 'Rubik', size: 11 }, color: c('--ink-400') }, grid: { color: c('--line-soft') } },
          x: { ticks: { maxTicksLimit: 7, font: { family: 'Rubik', size: 11 }, color: c('--ink-400') }, grid: { display: false } },
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

    page.innerHTML = `<div class="sov-page">
      <div class="sov-head">
        <p class="sov-lede"><b>${esc(cat.name)}</b> social share of voice, Sri Lanka, ${esc(cat.period.label)}.
          ${brand ? `${esc(brand.name)} is highlighted.` : ''}</p>
        ${switcher}
      </div>

      ${kpis(cat, brand)}

      ${cat.insights.length ? `<div class="sov-card" id="sov-findings"><h3>What we found</h3>
        <ul class="sov-insights">${cat.insights.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}

      <div class="sov-grid">
        <div class="sov-card" id="sov-brands">
          <div class="sov-card-head"><h3>Share of voice by brand</h3>
            <div class="sov-seg" role="group" aria-label="Measure">${MEASURES.map(([k, n]) =>
              `<button aria-pressed="${state.measure === k}" onclick="SOV.setMeasure('${k}')">${n}</button>`).join('')}</div></div>
          <p class="sov-note">${esc(MEASURE_NOTE[state.measure])}</p>
          <div class="sov-legend"><span><i style="background:var(--navy)"></i>${esc(brand ? brand.name : 'Selected brand')}</span>
            <span><i style="background:var(--s3)"></i>Other Unilever brands</span><span><i style="background:var(--s5)"></i>Competitors</span></div>
          <div id="sov-brand-bars">${brandBars(cat)}</div>
        </div>
        <div class="sov-card" id="sov-trend">
          <h3>Share of voice by week</h3>
          <p class="sov-note">Weekly share of category conversation. Peaks follow campaign moments.</p>
          <div class="sov-chart"><canvas id="sov-weekly" aria-label="Share of voice by week"></canvas></div>
        </div>
      </div>

      <div class="sov-grid">
        <div class="sov-card" id="sov-sentiment">
          <h3>Sentiment</h3>
          <p class="sov-note">Tone of consumer conversation about each brand. Brand-published content is excluded.</p>
          ${sentiment(cat)}
        </div>
        ${cat.publicBrands.length ? `<div class="sov-card" id="sov-public">
          <h3>Who leads earned conversation</h3>
          <p class="sov-note">Share of earned voice by brand, including brands outside this tracker.</p>
          ${publicBrands(cat)}
        </div>` : ''}
      </div>

      <div class="sov-grid-3">
        ${cat.topics.length ? `<div class="sov-card" id="sov-topics"><h3>Conversation themes</h3>
          <p class="sov-note">Share of category conversation by theme.</p>${simpleBars(cat.topics)}</div>` : ''}
        ${cat.commentTypes.length ? `<div class="sov-card" id="sov-comment-types"><h3>Conversation intent</h3>
          <p class="sov-note">What consumers are doing in the conversation.</p>${simpleBars(cat.commentTypes)}</div>` : ''}
        ${cat.authorTypes.length ? `<div class="sov-card" id="sov-authors"><h3>Voice by source</h3>
          <p class="sov-note">Share of earned content by type of source.</p>${simpleBars(cat.authorTypes)}</div>` : ''}
      </div>
    </div>`;
    drawWeekly(cat);
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────
  function onPage(page) {
    state.page = page;
    if (page === 'sov') {
      if (state.data) render();
      refresh();
    } else if (state.chart) {
      state.chart.destroy(); state.chart = null;
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
      el.innerHTML = brandBars(cat);
      document.querySelectorAll('#sov-brands .sov-seg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.getAttribute('onclick').includes(`'${k}'`))));
      const note = document.querySelector('#sov-brands .sov-note');
      if (note) note.textContent = MEASURE_NOTE[k];
    }
  }

  function setCategory(i) { state.cat = i; render(); }

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

  window.SOV = { onPage, onBrandChange, refresh, setMeasure, setCategory };
})();

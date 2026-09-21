/**
 * Ask Lens - marker renderers (v2)
 *
 * Every renderer reads from the records store, never from model text.
 * Values in records are already percentages (hook 34.2, not 0.342).
 */
(function (global) {
  'use strict';

  var METRICS = {
    cqr:             { label: 'CQR',             type: 'cqr' },
    hook_rate:       { label: 'Hook rate',       type: 'pct', decimals: 1 },
    hold_rate:       { label: 'Hold rate',       type: 'pct', decimals: 1 },
    engagement_rate: { label: 'Engagement rate', type: 'pct', decimals: 2 },
    retention_rate:  { label: 'Retention',       type: 'pct', decimals: 1 },
    vtr:             { label: 'VTR',             type: 'pct', decimals: 1 },
    ctr:             { label: 'CTR',             type: 'pct', decimals: 2 },
    reach:           { label: 'Reach',           type: 'count' },
    video_views:     { label: 'Video views',     type: 'count' },
    impressions:     { label: 'Impressions',     type: 'count' },
    spend:           { label: 'Spend',           type: 'currency' },
    avg_watch_time:  { label: 'Avg watch',       type: 'seconds', decimals: 1 },
  };

  var PLATFORMS = {
    meta:      { label: 'Meta',      color: '#1877f2' },
    tiktok:    { label: 'TikTok',    color: '#ff0050' },
    instagram: { label: 'Instagram', color: '#e1306c' },
    facebook:  { label: 'Facebook',  color: '#1877f2' },
  };

  var CQR_CLASS = { Good: 'good', Average: 'avg', Poor: 'poor', Invalid: 'inv' };
  var CURRENCY = 'LKR';

  function formatCount(n) {
    n = Number(n);
    if (!isFinite(n)) return 'n/a';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function formatMetric(metric, value) {
    var def = METRICS[metric];
    if (value === null || value === undefined || value === '') return 'n/a';
    if (def && def.type === 'cqr') return String(value);
    var n = Number(value);
    if (!isFinite(n)) return 'n/a';
    if (!def) return String(value);
    if (def.type === 'pct') return n.toFixed(def.decimals) + '%';
    if (def.type === 'currency') return formatCount(n) + ' ' + CURRENCY;
    if (def.type === 'seconds') return n.toFixed(def.decimals) + 's';
    return formatCount(n);
  }

  function metricLabel(m) { return (METRICS[m] && METRICS[m].label) || m; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function cqrDot(cqr) {
    var d = el('span', 'al-cqr-dot ' + (CQR_CLASS[cqr] || 'inv'));
    d.title = 'CQR ' + (cqr || 'unrated');
    return d;
  }

  function cqrBadge(cqr) {
    return el('span', 'al-cqr ' + (CQR_CLASS[cqr] || 'inv'), cqr || 'Unrated');
  }

  function platformDots(platforms) {
    var list = Array.isArray(platforms) ? platforms : (platforms ? [platforms] : []);
    var wrap = el('span', 'al-dots');
    list.forEach(function (name) {
      var p = PLATFORMS[name];
      var dot = el('span', 'al-dot');
      dot.style.background = p ? p.color : '#A0A0BB';
      dot.title = p ? p.label : name;
      wrap.appendChild(dot);
    });
    return wrap;
  }

  function platformText(platforms) {
    var list = Array.isArray(platforms) ? platforms : (platforms ? [platforms] : []);
    if (!list.length) return 'Not boosted';
    return list.map(function (n) { return (PLATFORMS[n] && PLATFORMS[n].label) || n; }).join(' + ');
  }

  function prettyFormat(f) {
    if (!f) return 'Unclassified';
    return String(f).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // ---- Store ---------------------------------------------------

  function Store() { this.records = {}; this.series = null; this.pending = {}; }
  Store.prototype.merge = function (records) {
    if (!records) return;
    for (var id in records) if (Object.prototype.hasOwnProperty.call(records, id)) this.records[id] = records[id];
  };
  Store.prototype.get = function (id) { return this.records[id] || null; };
  Store.prototype.fetchMissing = function (ids, ctx) {
    var self = this;
    var need = ids.filter(function (id) { return id !== 'brand' && !self.records[id] && !self.pending[id]; });
    if (!need.length) return Promise.resolve();
    need.forEach(function (id) { self.pending[id] = true; });
    return fetch('/api/chat/records?brand=' + encodeURIComponent(ctx.brand) + '&ids=' + encodeURIComponent(need.join(',')), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { records: {} }; })
      .then(function (d) { self.merge(d.records); need.forEach(function (id) { delete self.pending[id]; }); })
      .catch(function () { need.forEach(function (id) { delete self.pending[id]; }); });
  };

  // ---- Creative chip -------------------------------------------

  function renderCreative(marker, store, ctx) {
    var wrap = el('span', 'al-chip-wrap');
    var chip = el('button', 'al-chip');
    chip.type = 'button';
    chip.setAttribute('aria-expanded', 'false');
    var rec = store.get(marker.id);

    chip.appendChild(cqrDot(rec && rec.cqr));
    chip.appendChild(el('span', 'al-chip-label', rec ? (rec.name || marker.id) : marker.id));
    chip.appendChild(el('span', 'al-chip-caret'));

    var panel = el('div', 'al-expand');
    panel.hidden = true;

    chip.addEventListener('click', function () {
      var open = !panel.hidden;
      var log = wrap.closest('.al-messages');
      if (log) log.querySelectorAll('.al-expand:not([hidden])').forEach(function (p) {
        if (p !== panel) { p.hidden = true; var c = p.previousElementSibling; if (c) c.setAttribute('aria-expanded', 'false'); }
      });
      panel.hidden = open;
      chip.setAttribute('aria-expanded', String(!open));
      if (!open && !panel.dataset.filled) { fillExpand(panel, marker.id, store, ctx); panel.dataset.filled = '1'; }
    });

    wrap.appendChild(chip);
    wrap.appendChild(panel);

    if (!rec) store.fetchMissing([marker.id], ctx).then(function () {
      var r = store.get(marker.id); if (!r) return;
      chip.querySelector('.al-chip-label').textContent = r.name || marker.id;
      chip.replaceChild(cqrDot(r.cqr), chip.querySelector('.al-cqr-dot'));
    });
    return wrap;
  }

  function fillExpand(panel, id, store, ctx) {
    var rec = store.get(id);
    if (!rec) { panel.appendChild(el('div', 'al-expand-empty', 'Details not available.')); return; }

    var head = el('div', 'al-expand-head');
    var meta = el('div', 'al-expand-meta');
    meta.appendChild(el('div', 'al-expand-name', rec.name || id));
    if (rec.short && rec.short !== rec.name) meta.appendChild(el('div', 'al-expand-id', rec.short));
    var sub = el('div', 'al-expand-sub');
    sub.appendChild(cqrBadge(rec.cqr));
    sub.appendChild(platformDots(rec.platforms));
    sub.appendChild(el('span', null, platformText(rec.platforms) + ' · ' + prettyFormat(rec.format) + (rec.type ? ' · ' + rec.type : '') + (rec.origin === 'repurposed' ? ' · repurposed' : '')));
    meta.appendChild(sub);
    head.appendChild(meta);
    panel.appendChild(head);

    if (rec.hook && rec.name !== rec.hook) panel.appendChild(el('div', 'al-expand-hook', rec.hook));

    // What the classifier saw, in plain words: opening hook, purpose, structure.
    var lab = rec.labels || {};
    var tags = [
      lab.hook_device && ['Opening', lab.hook_device],
      lab.content_intent && ['Purpose', lab.content_intent],
      lab.narrative_structure && ['Structure', lab.narrative_structure],
    ].filter(Boolean);
    if (tags.length) {
      var tagRow = el('div', 'al-expand-tags');
      tags.forEach(function (t) {
        var tag = el('span', 'al-tag');
        tag.appendChild(el('span', 'al-tag-key', t[0]));
        tag.appendChild(el('span', 'al-tag-val', t[1]));
        tagRow.appendChild(tag);
      });
      panel.appendChild(tagRow);
    }

    var grid = el('div', 'al-expand-grid');
    ['hook_rate', 'hold_rate', 'reach', 'impressions', 'spend', 'avg_watch_time'].forEach(function (m) {
      var cell = el('div', 'al-expand-cell');
      var q = m === 'hook_rate' ? rec.hook_q : m === 'hold_rate' ? rec.hold_q : '';
      cell.appendChild(el('span', 'al-expand-cell-label', metricLabel(m) + (q ? ' · ' + q : '')));
      var val = el('span', 'al-expand-cell-value', formatMetric(m, rec[m]));
      if (q === 'Strong') val.classList.add('is-strong'); else if (q === 'Weak') val.classList.add('is-weak');
      cell.appendChild(val);
      grid.appendChild(cell);
    });
    panel.appendChild(grid);

    // Retention strip: 0s / hook / 25 / 50 / 75 / 100
    if (Array.isArray(rec.retention) && rec.retention.some(function (v) { return v !== null; })) {
      var ret = el('div', 'al-ret');
      ret.appendChild(el('span', 'al-ret-label', 'Retention'));
      var strip = el('div', 'al-ret-strip');
      var labels = ['0s', 'hook', '25%', '50%', '75%', '100%'];
      rec.retention.forEach(function (v, i) {
        var col = el('div', 'al-ret-col');
        var bar = el('div', 'al-ret-bar');
        bar.style.height = (v === null ? 0 : Math.max(2, v)) + '%';
        col.appendChild(bar);
        col.appendChild(el('span', 'al-ret-val', v === null ? '-' : v + '%'));
        col.appendChild(el('span', 'al-ret-key', labels[i]));
        strip.appendChild(col);
      });
      ret.appendChild(strip);
      panel.appendChild(ret);
    }

    if (rec.per_platform && Object.keys(rec.per_platform).length > 1) {
      var plats = el('div', 'al-expand-platforms');
      Object.keys(rec.per_platform).forEach(function (p) {
        var x = rec.per_platform[p];
        var row = el('div', 'al-expand-plat');
        row.appendChild(platformDots([p]));
        row.appendChild(el('b', null, (PLATFORMS[p] && PLATFORMS[p].label) || p));
        row.appendChild(cqrBadge(x.cqr));
        row.appendChild(el('span', null, 'hook ' + formatMetric('hook_rate', x.hook_rate) + ' · hold ' + formatMetric('hold_rate', x.hold_rate)));
        plats.appendChild(row);
      });
      panel.appendChild(plats);
    }

    if (rec.verdict || rec.working || rec.not_working || rec.action) {
      var v = el('div', 'al-expand-verdict clamped');
      var body = el('div', 'al-expand-verdict-body');
      var row = function (label, text) {
        if (!text) return;
        var pdiv = el('p');
        pdiv.appendChild(el('b', null, label + ' '));
        pdiv.appendChild(document.createTextNode(text));
        body.appendChild(pdiv);
      };
      row('Verdict:', rec.verdict);
      row('Working:', rec.working);
      row('Not working:', rec.not_working);
      row('Action:', rec.action ? rec.action + (rec.priority ? ' (' + rec.priority + ')' : '') : '');
      v.appendChild(body);
      var more = el('button', 'al-more', 'More');
      more.type = 'button';
      more.addEventListener('click', function () {
        var open = v.classList.toggle('clamped');
        more.textContent = open ? 'More' : 'Less';
      });
      v.appendChild(more);
      panel.appendChild(v);
      // Only show the toggle if content actually overflows.
      setTimeout(function () { if (body.scrollHeight <= body.clientHeight + 2) more.hidden = true; }, 0);
    }

    if (rec.permalink) {
      var actions = el('div', 'al-expand-actions');
      var a = el('a', 'al-link', 'View creative');
      a.href = rec.permalink; a.target = '_blank'; a.rel = 'noopener noreferrer';
      actions.appendChild(a);
      panel.appendChild(actions);
    }
  }

  // ---- Metric badge --------------------------------------------

  function renderMetric(marker, store, ctx) {
    var rec = store.get(marker.id);
    var value = rec ? rec[marker.metric] : null;

    if (marker.metric === 'cqr') {
      var badge = cqrBadge(value);
      if (!rec && marker.id !== 'brand') store.fetchMissing([marker.id], ctx).then(function () {
        var r = store.get(marker.id); if (r) badge.replaceWith(cqrBadge(r.cqr));
      });
      return badge;
    }

    var b = el('span', 'al-badge');
    b.appendChild(el('span', 'al-badge-value', formatMetric(marker.metric, value)));
    b.appendChild(el('span', 'al-badge-label', metricLabel(marker.metric)));
    b.title = metricLabel(marker.metric) + (marker.id === 'brand' ? ', brand average' : ' for ' + (rec ? rec.name : marker.id));
    if (!rec && marker.id !== 'brand') store.fetchMissing([marker.id], ctx).then(function () {
      var r = store.get(marker.id); if (r) b.querySelector('.al-badge-value').textContent = formatMetric(marker.metric, r[marker.metric]);
    });
    return b;
  }

  // ---- Chart ---------------------------------------------------

  function renderChart(marker, store, ctx) {
    var card = el('div', 'al-card al-chart-card');
    var canvas = document.createElement('canvas');
    card.appendChild(canvas);

    function draw() {
      if (typeof Chart === 'undefined') { card.appendChild(el('div', 'al-expand-empty', 'Chart unavailable.')); return; }
      var labels = [], values = [], colors = [];
      if (marker.series) {
        var s = store.series;
        if (!s || s.metric !== marker.metric) { card.appendChild(el('div', 'al-expand-empty', 'No series for this metric.')); return; }
        labels = s.labels; values = s.values;
      } else {
        marker.ids.forEach(function (id) {
          var rec = store.get(id); if (!rec) return;
          labels.push(rec.name || id); values.push(Number(rec[marker.metric]));
          var cq = rec.cqr;
          colors.push(cq === 'Good' ? '#04785C' : cq === 'Average' ? '#8A5A12' : cq === 'Poor' ? '#A32040' : '#6B6B90');
        });
        if (!values.length) { card.appendChild(el('div', 'al-expand-empty', 'No data for those creatives.')); return; }
      }
      var def = METRICS[marker.metric] || {};
      new Chart(canvas.getContext('2d'), {
        type: marker.type,
        data: { labels: labels, datasets: [{ label: metricLabel(marker.metric), data: values,
          backgroundColor: marker.series ? 'rgba(0,0,80,0.08)' : colors, borderColor: marker.series ? '#000050' : colors,
          borderWidth: marker.series ? 2 : 0, pointRadius: marker.series ? 0 : undefined, tension: 0.25, fill: !!marker.series, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return formatMetric(marker.metric, c.parsed.y); } } } },
          scales: { x: { grid: { display: false }, ticks: { font: { family: 'Rubik', size: 11 }, maxRotation: 0, autoSkip: true } },
                    y: { grid: { color: 'rgba(0,0,80,0.06)' }, ticks: { font: { family: 'Rubik', size: 11 },
                      callback: function (v) { return def.type === 'pct' ? v.toFixed(0) + '%' : formatCount(v); } } } } },
      });
    }

    if (!marker.series) {
      var missing = marker.ids.filter(function (id) { return !store.get(id); });
      if (missing.length) { store.fetchMissing(missing, ctx).then(draw); return card; }
    }
    setTimeout(draw, 0);
    return card;
  }

  // ---- Compare -------------------------------------------------

  function renderCompare(marker, store, ctx) {
    var card = el('div', 'al-card');
    function draw() {
      card.innerHTML = '';
      var recs = marker.ids.map(function (id) { return store.get(id); }).filter(Boolean);
      if (recs.length < 2) { card.appendChild(el('div', 'al-expand-empty', 'Not enough data to compare.')); return; }
      var table = el('table', 'al-compare');
      var thead = el('thead'), hrow = el('tr');
      hrow.appendChild(el('th', 'al-compare-metric', ''));
      recs.forEach(function (r) { var th = el('th'); th.appendChild(cqrDot(r.cqr)); th.appendChild(el('span', null, r.name || r.id)); hrow.appendChild(th); });
      thead.appendChild(hrow); table.appendChild(thead);
      var tbody = el('tbody');
      ['cqr', 'hook_rate', 'hold_rate', 'reach'].forEach(function (m) {
        var tr = el('tr'); tr.appendChild(el('td', 'al-compare-metric', metricLabel(m)));
        if (m === 'cqr') { recs.forEach(function (r) { var td = el('td'); td.appendChild(cqrBadge(r.cqr)); tr.appendChild(td); }); }
        else { var nums = recs.map(function (r) { return Number(r[m]); }); var best = Math.max.apply(null, nums.filter(isFinite));
          recs.forEach(function (r, i) { tr.appendChild(el('td', nums[i] === best ? 'al-compare-best' : null, formatMetric(m, r[m]))); }); }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody); card.appendChild(table);
    }
    var missing = marker.ids.filter(function (id) { return !store.get(id); });
    if (missing.length) store.fetchMissing(missing, ctx).then(draw); else draw();
    return card;
  }

  // ---- Cohort --------------------------------------------------

  function renderCohort(marker, store) {
    var card = el('div', 'al-card al-cohort');
    var parts = String(marker.key).split(':'), kind = parts[0], value = parts.slice(1).join(':');
    var title = kind === 'platform' ? ((PLATFORMS[value] && PLATFORMS[value].label) || value) : kind === 'format' ? prettyFormat(value) : value;
    if (kind === 'type') title = value === 'BrandSay' ? 'Brand Say' : value === 'OthersSay' ? 'Others Say' : value;
    var named = store.get('cohort:' + marker.key);
    if (named && named.name) title = named.name;
    var head = el('div', 'al-cohort-head');
    if (kind === 'platform') head.appendChild(platformDots([value]));
    head.appendChild(el('span', 'al-cohort-title', title));
    card.appendChild(head);
    var cohort = store.get('cohort:' + marker.key);
    if (!cohort) { card.appendChild(el('div', 'al-expand-empty', 'Summary not available.')); return card; }
    if (cohort.tooFew) { card.appendChild(el('div', 'al-cohort-sub', 'One example only, not enough to compare.')); return card; }
    // How this group compares with the brand overall, in words.
    var vs = cohort.vs || {};
    var row = el('div', 'al-expand-tags');
    [['CQR', vs.cqr], ['Hook', vs.hook], ['Hold', vs.hold]].forEach(function (t) {
      if (!t[1] || t[1] === 'unknown') return;
      var tag = el('span', 'al-tag al-tag-' + t[1]);
      tag.appendChild(el('span', 'al-tag-key', t[0]));
      tag.appendChild(el('span', 'al-tag-val', t[1].charAt(0).toUpperCase() + t[1].slice(1)));
      row.appendChild(tag);
    });
    card.appendChild(row);
    card.appendChild(el('div', 'al-cohort-sub', (cohort.early ? 'Early sign. ' : '') + 'Compared with the brand overall.'));
    return card;
  }

  function render(marker, store, ctx) {
    switch (marker.kind) {
      case 'creative': return renderCreative(marker, store, ctx);
      case 'metric':   return renderMetric(marker, store, ctx);
      case 'chart':    return renderChart(marker, store, ctx);
      case 'compare':  return renderCompare(marker, store, ctx);
      case 'cohort':   return renderCohort(marker, store, ctx);
      default:         return document.createTextNode('');
    }
  }
  function isBlock(m) { return m.kind === 'chart' || m.kind === 'compare' || m.kind === 'cohort'; }

  global.AskLensCards = { Store: Store, render: render, isBlock: isBlock, formatMetric: formatMetric, metricLabel: metricLabel, platformText: platformText, cqrBadge: cqrBadge, METRICS: METRICS, PLATFORMS: PLATFORMS };
})(window);

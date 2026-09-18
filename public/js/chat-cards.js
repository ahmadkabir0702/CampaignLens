/**
 * Ask Lens - marker renderers
 *
 * Every renderer reads from the records store, never from text the
 * model produced. That is the whole point: the model points, the
 * database supplies the number.
 */

(function (global) {
  'use strict';

  var METRICS = {
    ctr:             { label: 'CTR',             type: 'percent',  decimals: 2 },
    engagement_rate: { label: 'Engagement rate', type: 'percent',  decimals: 2 },
    vtr:             { label: 'VTR',             type: 'percent',  decimals: 1 },
    cpm:             { label: 'CPM',             type: 'currency', decimals: 0 },
    cpc:             { label: 'CPC',             type: 'currency', decimals: 2 },
    spend:           { label: 'Spend',           type: 'currency', decimals: 0 },
    impressions:     { label: 'Impressions',     type: 'count' },
    reach:           { label: 'Reach',           type: 'count' },
    clicks:          { label: 'Clicks',          type: 'count' },
    engagements:     { label: 'Engagements',     type: 'count' },
    video_views:     { label: 'Video views',     type: 'count' },
  };

  var PLATFORMS = {
    meta:      { label: 'Meta',      color: '#1877f2' },
    tiktok:    { label: 'TikTok',    color: '#ff0050' },
    instagram: { label: 'Instagram', color: '#e1306c' },
    facebook:  { label: 'Facebook',  color: '#1877f2' },
  };

  var CURRENCY = 'LKR';

  // ---- Formatting ----------------------------------------------

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
    var n = Number(value);
    if (!isFinite(n)) return 'n/a';
    if (!def) return String(value);

    if (def.type === 'percent') return (n * 100).toFixed(def.decimals) + '%';
    if (def.type === 'currency') return formatCount(n) + ' ' + CURRENCY;
    return formatCount(n);
  }

  function metricLabel(metric) {
    return (METRICS[metric] && METRICS[metric].label) || metric;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** A creative can run on several platforms, so this returns a group. */
  function platformDots(platforms) {
    var list = Array.isArray(platforms) ? platforms : (platforms ? [platforms] : []);
    var wrap = el('span', 'al-dots');
    if (!list.length) {
      var none = el('span', 'al-dot');
      none.style.background = 'var(--al-muted)';
      wrap.appendChild(none);
      return wrap;
    }
    list.forEach(function (name) {
      var p = PLATFORMS[name];
      var dot = el('span', 'al-dot');
      dot.style.background = p ? p.color : 'var(--al-muted)';
      dot.title = p ? p.label : name;
      wrap.appendChild(dot);
    });
    return wrap;
  }

  function platformDot(platforms) { return platformDots(platforms); }

  function platformText(platforms) {
    var list = Array.isArray(platforms) ? platforms : (platforms ? [platforms] : []);
    if (!list.length) return 'Unknown';
    return list.map(function (n) { return (PLATFORMS[n] && PLATFORMS[n].label) || n; }).join(' + ');
  }

  function prettyFormat(fmt) {
    if (!fmt) return 'Unclassified';
    return String(fmt).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // ---- Records store -------------------------------------------

  function Store() {
    this.records = {};
    this.brand = null;
    this.brandTotals = null;
    this.series = null;
    this.pending = {};
  }

  Store.prototype.merge = function (records) {
    if (!records) return;
    for (var id in records) {
      if (Object.prototype.hasOwnProperty.call(records, id)) {
        this.records[id] = records[id];
      }
    }
  };

  Store.prototype.get = function (id) {
    if (id === 'brand') return this.brandTotals;
    return this.records[id] || null;
  };

  /** Safety net for a marker whose record never arrived. */
  Store.prototype.fetchMissing = function (ids, ctx) {
    var self = this;
    var need = ids.filter(function (id) { return id !== 'brand' && !self.records[id] && !self.pending[id]; });
    if (!need.length) return Promise.resolve();
    need.forEach(function (id) { self.pending[id] = true; });

    return fetch('/api/chat/records?brand=' + encodeURIComponent(ctx.brand) +
                 '&rangeDays=' + encodeURIComponent(ctx.rangeDays) +
                 '&ids=' + encodeURIComponent(need.join(',')), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { records: {} }; })
      .then(function (data) {
        self.merge(data.records);
        need.forEach(function (id) { delete self.pending[id]; });
      })
      .catch(function () {
        need.forEach(function (id) { delete self.pending[id]; });
      });
  };

  // ---- Creative chip, expands inline ---------------------------

  function renderCreative(marker, store, ctx) {
    var wrap = el('span', 'al-chip-wrap');
    var chip = el('button', 'al-chip');
    chip.type = 'button';
    chip.setAttribute('aria-expanded', 'false');

    var rec = store.get(marker.id);

    if (rec && rec.thumbnail_url) {
      var img = el('img', 'al-chip-thumb');
      img.src = rec.thumbnail_url;
      img.alt = '';
      img.loading = 'lazy';
      chip.appendChild(img);
    }

    chip.appendChild(platformDots(rec && rec.platforms));
    chip.appendChild(el('span', 'al-chip-label', rec ? (rec.name || marker.id) : marker.id));
    chip.appendChild(el('span', 'al-chip-caret', ''));

    var panel = el('div', 'al-expand');
    panel.hidden = true;

    chip.addEventListener('click', function () {
      var open = !panel.hidden;
      // Only one expanded at a time keeps the panel readable.
      var others = wrap.closest('.al-messages');
      if (others) {
        others.querySelectorAll('.al-expand:not([hidden])').forEach(function (p) {
          if (p !== panel) {
            p.hidden = true;
            var c = p.previousElementSibling;
            if (c && c.classList.contains('al-chip')) c.setAttribute('aria-expanded', 'false');
          }
        });
      }
      panel.hidden = open;
      chip.setAttribute('aria-expanded', String(!open));
      if (!open && !panel.dataset.filled) {
        fillExpand(panel, marker.id, store, ctx);
        panel.dataset.filled = '1';
      }
    });

    wrap.appendChild(chip);
    wrap.appendChild(panel);

    // Backfill once the record arrives.
    if (!rec) {
      store.fetchMissing([marker.id], ctx).then(function () {
        var r = store.get(marker.id);
        if (!r) return;
        var label = chip.querySelector('.al-chip-label');
        if (label) label.textContent = r.name || marker.id;
        var dots = chip.querySelector('.al-dots');
        if (dots) chip.replaceChild(platformDots(r.platforms), dots);
      });
    }

    return wrap;
  }

  function fillExpand(panel, id, store, ctx) {
    var rec = store.get(id);
    if (!rec) {
      panel.appendChild(el('div', 'al-expand-empty', 'Details for this creative are not available.'));
      return;
    }

    var head = el('div', 'al-expand-head');
    if (rec.thumbnail_url) {
      var img = el('img', 'al-expand-thumb');
      img.src = rec.thumbnail_url;
      img.alt = '';
      head.appendChild(img);
    }
    var meta = el('div', 'al-expand-meta');
    meta.appendChild(el('div', 'al-expand-name', rec.name || id));
    var sub = el('div', 'al-expand-sub');
    sub.appendChild(platformDots(rec.platforms));
    sub.appendChild(el('span', null,
      platformText(rec.platforms) + ' · ' + prettyFormat(rec.format) +
      (rec.origin ? ' · ' + rec.origin : '')));
    meta.appendChild(sub);
    head.appendChild(meta);
    panel.appendChild(head);

    var grid = el('div', 'al-expand-grid');
    ['ctr', 'engagement_rate', 'impressions', 'reach', 'clicks', 'spend'].forEach(function (m) {
      var cell = el('div', 'al-expand-cell');
      cell.appendChild(el('span', 'al-expand-cell-label', metricLabel(m)));
      cell.appendChild(el('span', 'al-expand-cell-value', formatMetric(m, rec[m])));
      grid.appendChild(cell);
    });
    panel.appendChild(grid);

    var actions = el('div', 'al-expand-actions');
    // The dashboard has no deep-link router yet, so the reliable action is
    // the live post. If a hub deep-link is added later, swap this href.
    if (rec.permalink) {
      var openHub = el('a', 'al-link', 'View creative');
      openHub.href = rec.permalink;
      openHub.target = '_blank';
      openHub.rel = 'noopener noreferrer';
      actions.appendChild(openHub);
    }
    panel.appendChild(actions);
  }

  // ---- Metric badge --------------------------------------------

  function renderMetric(marker, store, ctx) {
    var badge = el('span', 'al-badge');
    var rec = store.get(marker.id);
    var value = rec ? rec[marker.metric] : null;

    badge.appendChild(el('span', 'al-badge-value', formatMetric(marker.metric, value)));
    badge.appendChild(el('span', 'al-badge-label', metricLabel(marker.metric)));
    badge.title = metricLabel(marker.metric) +
      (marker.id === 'brand' ? ' across the brand' : ' for ' + (rec ? (rec.name || marker.id) : marker.id));

    if (!rec && marker.id !== 'brand') {
      store.fetchMissing([marker.id], ctx).then(function () {
        var r = store.get(marker.id);
        if (!r) return;
        var v = badge.querySelector('.al-badge-value');
        if (v) v.textContent = formatMetric(marker.metric, r[marker.metric]);
      });
    }

    return badge;
  }

  // ---- Chart ---------------------------------------------------

  function renderChart(marker, store, ctx) {
    var card = el('div', 'al-card al-chart-card');
    var canvas = document.createElement('canvas');
    canvas.height = 180;
    card.appendChild(canvas);

    function draw() {
      if (typeof Chart === 'undefined') {
        card.appendChild(el('div', 'al-expand-empty', 'Chart could not be drawn.'));
        return;
      }

      var labels = [];
      var values = [];
      var colors = [];

      if (marker.series) {
        var s = store.series;
        if (!s || s.metric !== marker.metric) {
          card.appendChild(el('div', 'al-expand-empty', 'No series available for this metric.'));
          return;
        }
        labels = s.labels;
        values = s.values;
      } else {
        marker.ids.forEach(function (id) {
          var rec = store.get(id);
          if (!rec) return;
          labels.push(rec.name || id);
          values.push(Number(rec[marker.metric]));
          var first = Array.isArray(rec.platforms) ? rec.platforms[0] : rec.platforms;
          colors.push((PLATFORMS[first] && PLATFORMS[first].color) || '#1B2A4A');
        });
        if (!values.length) {
          card.appendChild(el('div', 'al-expand-empty', 'No data for those creatives.'));
          return;
        }
      }

      var def = METRICS[marker.metric] || {};
      var isPct = def.type === 'percent';

      new Chart(canvas.getContext('2d'), {
        type: marker.type,
        data: {
          labels: labels,
          datasets: [{
            label: metricLabel(marker.metric),
            data: values,
            backgroundColor: marker.series ? 'rgba(27,42,74,0.08)' : colors,
            borderColor: marker.series ? '#1B2A4A' : colors,
            borderWidth: marker.series ? 2 : 0,
            pointRadius: marker.series ? 0 : undefined,
            tension: 0.25,
            fill: !!marker.series,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (c) { return formatMetric(marker.metric, c.parsed.y); },
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { font: { family: 'Rubik', size: 11 }, maxRotation: 0, autoSkip: true },
            },
            y: {
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: {
                font: { family: 'Rubik', size: 11 },
                callback: function (v) { return isPct ? (v * 100).toFixed(1) + '%' : formatCount(v); },
              },
            },
          },
        },
      });
    }

    if (!marker.series) {
      var missing = marker.ids.filter(function (id) { return !store.get(id); });
      if (missing.length) {
        store.fetchMissing(missing, ctx).then(draw);
        return card;
      }
    }
    // Chart.js needs the canvas in the DOM before it measures.
    setTimeout(draw, 0);
    return card;
  }

  // ---- Compare table -------------------------------------------

  function renderCompare(marker, store, ctx) {
    var card = el('div', 'al-card');

    function draw() {
      card.innerHTML = '';
      var recs = marker.ids.map(function (id) { return store.get(id); }).filter(Boolean);
      if (recs.length < 2) {
        card.appendChild(el('div', 'al-expand-empty', 'Not enough data to compare those.'));
        return;
      }

      var table = el('table', 'al-compare');
      var thead = el('thead');
      var hrow = el('tr');
      hrow.appendChild(el('th', 'al-compare-metric', ''));
      recs.forEach(function (r) {
        var th = el('th');
        th.appendChild(platformDots(r.platforms));
        th.appendChild(el('span', null, r.name || r.id));
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      var tbody = el('tbody');
      ['ctr', 'engagement_rate', 'impressions', 'spend'].forEach(function (m) {
        var tr = el('tr');
        tr.appendChild(el('td', 'al-compare-metric', metricLabel(m)));
        var nums = recs.map(function (r) { return Number(r[m]); });
        var best = Math.max.apply(null, nums.filter(isFinite));
        recs.forEach(function (r, i) {
          var td = el('td', nums[i] === best ? 'al-compare-best' : null, formatMetric(m, r[m]));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
    }

    var missing = marker.ids.filter(function (id) { return !store.get(id); });
    if (missing.length) store.fetchMissing(missing, ctx).then(draw);
    else draw();

    return card;
  }

  // ---- Cohort tile ---------------------------------------------

  function renderCohort(marker, store) {
    var card = el('div', 'al-card al-cohort');
    var parts = String(marker.key).split(':');
    var kind = parts[0];
    var value = parts.slice(1).join(':');

    var title = kind === 'platform'
      ? (PLATFORMS[value] ? PLATFORMS[value].label : value)
      : kind === 'format' ? prettyFormat(value)
      : value.charAt(0).toUpperCase() + value.slice(1);

    var head = el('div', 'al-cohort-head');
    if (kind === 'platform') head.appendChild(platformDot(value));
    head.appendChild(el('span', 'al-cohort-title', title));
    card.appendChild(head);

    var cohort = (store.cohorts && store.cohorts[marker.key]) || null;
    if (!cohort) {
      card.appendChild(el('div', 'al-expand-empty', 'Summary not available.'));
      return card;
    }

    var grid = el('div', 'al-cohort-grid');
    ['ctr', 'engagement_rate', 'impressions'].forEach(function (m) {
      var cell = el('div', 'al-expand-cell');
      cell.appendChild(el('span', 'al-expand-cell-label', metricLabel(m)));
      cell.appendChild(el('span', 'al-expand-cell-value', formatMetric(m, cohort[m])));
      grid.appendChild(cell);
    });
    card.appendChild(grid);
    return card;
  }

  // ---- Dispatch ------------------------------------------------

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

  /** Block-level markers break out of the paragraph flow. */
  function isBlock(marker) {
    return marker.kind === 'chart' || marker.kind === 'compare' || marker.kind === 'cohort';
  }

  global.AskLensCards = {
    Store: Store,
    render: render,
    isBlock: isBlock,
    formatMetric: formatMetric,
    platformText: platformText,
    metricLabel: metricLabel,
    METRICS: METRICS,
    PLATFORMS: PLATFORMS,
  };
})(window);

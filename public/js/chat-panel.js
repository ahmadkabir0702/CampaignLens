/**
 * Ask Lens - chat panel
 *
 * Wiring, in your dashboard shell:
 *
 *   <script src="/js/markers.js"></script>
 *   <script src="/js/chat-cards.js"></script>
 *   <script src="/js/chat-panel.js"></script>
 *   <link rel="stylesheet" href="/css/chat-panel.css">
 *
 *   AskLens.init({
 *     getBrand:     function () { return currentBrand; },
 *     getRangeDays: function () { return currentRangeDays; },
 *     mountButton:  document.querySelector('.topbar-actions'),
 *   });
 *
 * Call AskLens.onBrandChange() from your existing brand switcher so the
 * panel resets its session to the new brand.
 */

(function (global) {
  'use strict';

  var Markers = global.AskLensMarkers;
  var Cards = global.AskLensCards;

  var STARTERS = [
    'Top performers this month',
    'Meta vs TikTok',
    "What's underperforming",
    'How does this compare to last month',
  ];

  var state = {
    open: false,
    sessionId: null,
    brand: null,
    rangeDays: 30,
    busy: false,
    store: null,
    getBrand: function () { return null; },
    getRangeDays: function () { return 30; },
  };

  var nodes = {};

  // ---- DOM helpers ---------------------------------------------

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function scrollToEnd() {
    if (nodes.messages) nodes.messages.scrollTop = nodes.messages.scrollHeight;
  }

  // ---- Panel shell ---------------------------------------------

  function buildPanel() {
    var panel = el('aside', 'al-panel');
    panel.setAttribute('aria-label', 'Ask Lens');
    panel.hidden = true;

    var head = el('header', 'al-head');
    var title = el('div', 'al-head-title', 'Ask Lens');
    var context = el('div', 'al-head-context', '');
    var titleWrap = el('div');
    titleWrap.appendChild(title);
    titleWrap.appendChild(context);

    var actions = el('div', 'al-head-actions');
    var newBtn = el('button', 'al-btn-outline', 'New chat');
    newBtn.type = 'button';
    newBtn.addEventListener('click', function () { startSession(true); });
    var closeBtn = el('button', 'al-btn-icon', '');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close Ask Lens');
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    closeBtn.addEventListener('click', close);
    actions.appendChild(newBtn);
    actions.appendChild(closeBtn);

    head.appendChild(titleWrap);
    head.appendChild(actions);

    var messages = el('div', 'al-messages');
    messages.setAttribute('role', 'log');
    messages.setAttribute('aria-live', 'polite');

    var chips = el('div', 'al-chips');

    var form = el('form', 'al-form');
    var input = el('textarea', 'al-input');
    input.rows = 1;
    input.placeholder = 'Ask about this brand';
    input.setAttribute('aria-label', 'Ask about this brand');
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    var send = el('button', 'al-btn-send', 'Send');
    send.type = 'submit';

    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || state.busy) return;
      input.value = '';
      input.style.height = 'auto';
      ask(text);
    });

    panel.appendChild(head);
    panel.appendChild(messages);
    panel.appendChild(chips);
    panel.appendChild(form);

    nodes = {
      panel: panel, messages: messages, chips: chips,
      input: input, send: send, context: context,
    };

    document.body.appendChild(panel);
    return panel;
  }

  function buildToggle(mount) {
    var btn = el('button', 'al-btn-outline al-toggle', 'Ask Lens');
    btn.type = 'button';
    btn.addEventListener('click', function () { state.open ? close() : open(); });
    (mount || document.body).appendChild(btn);
    return btn;
  }

  function open() {
    state.open = true;
    nodes.panel.hidden = false;
    document.body.classList.add('al-open');
    syncContext();
    if (!state.sessionId) startSession(false);
    setTimeout(function () { nodes.input.focus(); }, 60);
  }

  function close() {
    state.open = false;
    nodes.panel.hidden = true;
    document.body.classList.remove('al-open');
  }

  // ---- Context -------------------------------------------------

  function syncContext() {
    var brand = state.getBrand();
    var range = state.getRangeDays();
    state.brand = brand;
    state.rangeDays = range;

    fetch('/api/chat/context?brand=' + encodeURIComponent(brand) + '&rangeDays=' + range,
      { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        nodes.context.textContent = data.brandLabel + ' · ' + data.period;
        state.store.merge(data.records);
      })
      .catch(function () { /* header text is cosmetic */ });
  }

  // ---- Sessions ------------------------------------------------

  function startSession(clear) {
    if (clear) {
      nodes.messages.innerHTML = '';
      state.store = new Cards.Store();
      syncContext();
    }
    return fetch('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ brand: state.getBrand(), rangeDays: state.getRangeDays() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.session) state.sessionId = data.session.id;
        if (!nodes.messages.children.length) renderEmptyState();
      })
      .catch(function () {
        showSystem('Could not start a chat session. Reload the page and try again.');
      });
  }

  function renderEmptyState() {
    var empty = el('div', 'al-empty');
    empty.appendChild(el('p', 'al-empty-lead',
      'Ask about creative and campaign performance for the brand you have selected.'));
    nodes.messages.appendChild(empty);
    renderChips(STARTERS);
  }

  // ---- Chips ---------------------------------------------------

  function renderChips(list) {
    nodes.chips.innerHTML = '';
    list.forEach(function (label) {
      var chip = el('button', 'al-suggest', label);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        if (state.busy) return;
        ask(label);
      });
      nodes.chips.appendChild(chip);
    });
  }

  /**
   * Refinements are derived from what the answer contained, not asked
   * of the model. Zero token cost, and they mostly hit the answer cache.
   */
  function refineChips(markers, question) {
    var q = question.toLowerCase();
    var kinds = markers.map(function (m) { return m.kind; });
    var out = [];

    if (kinds.indexOf('creative') !== -1) {
      out.push('Rank by engagement');
      out.push('Rank by reach');
    }
    if (kinds.indexOf('cohort') !== -1 || /platform|meta|tiktok|instagram/.test(q)) {
      out.push('Break down by format');
    }
    if (kinds.indexOf('chart') === -1) {
      out.push('Show the trend');
    }
    if (!/last 7|this week|7 days/.test(q)) {
      out.push('Last 7 days');
    }
    if (!/meta/.test(q)) out.push('Meta only');

    return out.slice(0, 4);
  }

  // ---- Message rendering ---------------------------------------

  function addUserMessage(text) {
    var empty = nodes.messages.querySelector('.al-empty');
    if (empty) empty.remove();
    var row = el('div', 'al-msg al-msg-user');
    row.appendChild(el('div', 'al-bubble', text));
    nodes.messages.appendChild(row);
    scrollToEnd();
  }

  function addAssistantShell() {
    var row = el('div', 'al-msg al-msg-bot');
    var body = el('div', 'al-body');
    var para = el('p', 'al-para');
    body.appendChild(para);
    row.appendChild(body);
    nodes.messages.appendChild(row);
    scrollToEnd();
    return { row: row, body: body, para: para };
  }

  function showSystem(text) {
    var row = el('div', 'al-msg al-msg-system');
    row.appendChild(el('div', 'al-system', text));
    nodes.messages.appendChild(row);
    scrollToEnd();
  }

  function showThinking(shell) {
    var dots = el('span', 'al-thinking');
    dots.innerHTML = '<i></i><i></i><i></i>';
    shell.para.appendChild(dots);
    return dots;
  }

  function showToolNote(shell, name) {
    var pretty = {
      rank_creatives: 'Ranking creatives',
      get_creative: 'Pulling creative detail',
      get_series: 'Fetching the trend',
      compare_creatives: 'Comparing creatives',
      get_lineage: 'Tracing lineage',
    }[name] || 'Fetching data';
    var note = el('div', 'al-tool-note', pretty);
    shell.body.appendChild(note);
    scrollToEnd();
    return note;
  }

  /** Append one parsed token into the streaming message body. */
  function appendToken(shell, token, ctx) {
    if (token.type === 'text') {
      var text = token.value;
      // Blank lines start a new paragraph.
      var chunks = text.split(/\n{2,}/);
      chunks.forEach(function (chunk, i) {
        if (i > 0) {
          shell.para = el('p', 'al-para');
          shell.body.appendChild(shell.para);
        }
        if (chunk) shell.para.appendChild(document.createTextNode(chunk.replace(/\n/g, ' ')));
      });
      return;
    }

    var node = Cards.render(token.marker, state.store, ctx);
    if (Cards.isBlock(token.marker)) {
      shell.body.appendChild(node);
      shell.para = el('p', 'al-para');
      shell.body.appendChild(shell.para);
    } else {
      shell.para.appendChild(node);
    }
  }

  // ---- SSE over POST -------------------------------------------

  function ask(text) {
    if (state.busy) return;
    if (!state.sessionId) {
      startSession(false).then(function () { ask(text); });
      return;
    }

    state.busy = true;
    nodes.send.disabled = true;
    nodes.chips.innerHTML = '';

    addUserMessage(text);
    var shell = addAssistantShell();
    var thinking = showThinking(shell);
    var toolNote = null;

    var ctx = { brand: state.getBrand(), rangeDays: state.getRangeDays() };
    var parser = new Markers.MarkerStream();
    var seenText = false;
    var collected = [];

    fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        sessionId: state.sessionId,
        brand: ctx.brand,
        rangeDays: ctx.rangeDays,
        message: text,
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (e) { throw new Error(e.error || 'Request failed.'); });
        }
        return readStream(res.body);
      })
      .catch(function (err) {
        if (thinking && thinking.parentNode) thinking.remove();
        shell.para.textContent = err.message || 'Something went wrong. Try again.';
        shell.para.classList.add('al-error-text');
      })
      .finally(function () {
        state.busy = false;
        nodes.send.disabled = false;
        nodes.input.focus();
      });

    function readStream(body) {
      var reader = body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return finish();
          buf += decoder.decode(r.value, { stream: true });

          var parts = buf.split('\n\n');
          buf = parts.pop();

          parts.forEach(function (block) {
            var evMatch = block.match(/^event:\s*(.+)$/m);
            var dataMatch = block.match(/^data:\s*(.+)$/m);
            if (!evMatch || !dataMatch) return;
            var event = evMatch[1].trim();
            var data;
            try { data = JSON.parse(dataMatch[1]); } catch (e) { return; }
            handleEvent(event, data);
          });

          return pump();
        });
      }

      function handleEvent(event, data) {
        switch (event) {
          case 'records':
            state.store.merge(data);
            break;

          case 'meta':
            nodes.context.textContent =
              (Cards.PLATFORMS[data.brand] ? data.brand : data.brand) + ' · ' + data.period;
            break;

          case 'series':
            state.store.series = data;
            break;

          case 'tool':
            if (!toolNote) toolNote = showToolNote(shell, data.name);
            break;

          case 'text':
            if (!seenText) {
              seenText = true;
              if (thinking && thinking.parentNode) thinking.remove();
              if (toolNote && toolNote.parentNode) toolNote.remove();
            }
            parser.feed(data.delta).forEach(function (token) {
              collected.push(token);
              appendToken(shell, token, ctx);
            });
            scrollToEnd();
            break;

          case 'error':
            if (thinking && thinking.parentNode) thinking.remove();
            shell.para.textContent = data.message;
            shell.para.classList.add('al-error-text');
            break;

          default:
            break;
        }
      }

      function finish() {
        parser.flush().forEach(function (token) {
          collected.push(token);
          appendToken(shell, token, ctx);
        });
        if (thinking && thinking.parentNode) thinking.remove();

        // Tidy up the trailing empty paragraph a block marker leaves.
        var last = shell.body.lastElementChild;
        if (last && last.tagName === 'P' && !last.textContent.trim() && !last.children.length) {
          last.remove();
        }

        var markers = collected
          .filter(function (t) { return t.type === 'marker'; })
          .map(function (t) { return t.marker; });

        if (markers.length) renderChips(refineChips(markers, text));
        scrollToEnd();
      }

      return pump();
    }
  }

  // ---- Public API ----------------------------------------------

  function defaultGetBrand() {
    var sel = document.getElementById('brand-switcher');
    return sel ? sel.value : null;
  }

  function init(opts) {
    opts = opts || {};
    state.getBrand = opts.getBrand || defaultGetBrand;
    state.getRangeDays = opts.getRangeDays || function () { return 30; };
    state.store = new Cards.Store();

    // Follow the dashboard's brand switch. The native <select id="brand-switcher">
    // fires change on switch, so listening to it keeps the panel in sync without
    // touching dashboard.js.
    var sel = document.getElementById('brand-switcher');
    if (sel) sel.addEventListener('change', function () { onBrandChange(); });

    buildPanel();
    buildToggle(opts.mountButton);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) close();
    });
  }

  /** Call from the brand switcher. A session belongs to one brand. */
  function onBrandChange() {
    state.sessionId = null;
    if (state.open) startSession(true);
  }

  global.AskLens = {
    init: init,
    open: open,
    close: close,
    onBrandChange: onBrandChange,
    onRangeChange: onBrandChange,
  };
})(window);

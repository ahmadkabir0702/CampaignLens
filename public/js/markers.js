/**
 * Ask Lens - marker parser
 *
 * Markers arrive split across SSE chunks. "[[creat" can land in one
 * delta and "ive:cr_8821]]" in the next, so the parser buffers any
 * trailing text that might still become a marker and releases it once
 * the marker closes or the stream ends.
 *
 * Grammar:
 *   [[creative:ID]]
 *   [[metric:NAME|ID]]
 *   [[chart:TYPE|METRIC|ID,ID,ID]]   or   [[chart:line|METRIC|series]]
 *   [[compare:ID,ID]]
 *   [[cohort:KEY]]
 */

(function (global) {
  'use strict';

  var KINDS = ['creative', 'metric', 'chart', 'compare', 'cohort', 'element', 'insight'];
  var COMPLETE = /\[\[(creative|metric|chart|compare|cohort|element|insight):([^\[\]]*)\]\]/;

  function parseMarker(kind, body) {
    var parts = String(body).split('|').map(function (s) { return s.trim(); });

    switch (kind) {
      case 'creative':
        return { kind: 'creative', id: parts[0] };

      case 'metric':
        return { kind: 'metric', metric: parts[0], id: parts[1] || 'brand' };

      case 'chart': {
        var ids = (parts[2] || '').trim();
        return {
          kind: 'chart',
          type: parts[0] === 'line' ? 'line' : 'bar',
          metric: parts[1],
          series: ids === 'series',
          ids: ids === 'series' ? [] : ids.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        };
      }

      case 'compare':
        return {
          kind: 'compare',
          ids: parts.join('|').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        };

      case 'element':
        return { kind: 'element', key: parts.join('|') };

      case 'insight':
        return { kind: 'insight', id: parts[0] };

      case 'cohort':
        return { kind: 'cohort', key: parts.join('|') };

      default:
        return null;
    }
  }

  /**
   * Returns the index from which the tail must be held back because it
   * could still turn into a marker, or -1 if the whole tail is safe.
   */
  function holdFrom(text) {
    var open = text.lastIndexOf('[[');
    if (open !== -1 && text.indexOf(']]', open) === -1) {
      // An open marker with no close yet. Only hold it if what follows
      // could still match a known kind, otherwise it is literal text.
      var after = text.slice(open + 2);
      var colon = after.indexOf(':');
      if (colon === -1) {
        var prefixOk = KINDS.some(function (k) { return k.indexOf(after) === 0; });
        return prefixOk ? open : -1;
      }
      return KINDS.indexOf(after.slice(0, colon)) !== -1 ? open : -1;
    }
    // A lone trailing '[' could become '[['.
    if (text.charAt(text.length - 1) === '[') return text.length - 1;
    return -1;
  }

  function MarkerStream() {
    this.buffer = '';
  }

  /**
   * Feed a chunk. Returns an ordered array of tokens:
   *   { type: 'text', value: string }
   *   { type: 'marker', marker: object, raw: string }
   */
  MarkerStream.prototype.feed = function (chunk) {
    this.buffer += chunk;
    var tokens = [];
    var match;

    while ((match = COMPLETE.exec(this.buffer)) !== null) {
      var before = this.buffer.slice(0, match.index);
      if (before) tokens.push({ type: 'text', value: before });

      var marker = parseMarker(match[1], match[2]);
      if (marker) {
        tokens.push({ type: 'marker', marker: marker, raw: match[0] });
      } else {
        tokens.push({ type: 'text', value: match[0] });
      }
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }

    var hold = holdFrom(this.buffer);
    if (hold === -1) {
      if (this.buffer) tokens.push({ type: 'text', value: this.buffer });
      this.buffer = '';
    } else if (hold > 0) {
      tokens.push({ type: 'text', value: this.buffer.slice(0, hold) });
      this.buffer = this.buffer.slice(hold);
    }

    return tokens;
  };

  /** Flush at end of stream. A never-closed marker falls back to text. */
  MarkerStream.prototype.flush = function () {
    var rest = this.buffer;
    this.buffer = '';
    return rest ? [{ type: 'text', value: rest }] : [];
  };

  /** One-shot parse, used when replaying a stored message. */
  function parseAll(text) {
    var s = new MarkerStream();
    return s.feed(text).concat(s.flush());
  }

  global.AskLensMarkers = { MarkerStream: MarkerStream, parseAll: parseAll, parseMarker: parseMarker };
})(window);

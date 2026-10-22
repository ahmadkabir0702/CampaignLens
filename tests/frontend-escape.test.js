// The browser helpers that keep text from becoming markup or script:
// escapeHtml, jsq (an argument inside an inline handler) and safeUrl.
// Read from dashboard.js itself, so the test checks the shipped code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in dashboard.js`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
};
const ctx = {};
vm.createContext(ctx);
vm.runInContext([grab('escapeHtml'), grab('jsq'), grab('safeUrl')].join('\n'), ctx);

// What the browser does to an attribute value before running it.
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('escapeHtml leaves no markup characters', () => {
  const out = ctx.escapeHtml(`<script>"x"&'y'</script>`);
  assert.doesNotMatch(out, /[<>"']/);
});

test('jsq gives back the exact value when the handler runs', () => {
  for (const evil of [`x');alert(1);//`, `a"b`, `</button><img src=x>`, `back\\slash`, `plain_ID_0042`]) {
    const attr = ctx.jsq(evil);
    assert.doesNotMatch(attr, /["<>]/, 'nothing that can end the attribute');
    const value = vm.runInNewContext(decodeAttr(attr));
    assert.equal(value, evil);
  }
});

test('safeUrl keeps only web links', () => {
  assert.equal(ctx.safeUrl('https://www.instagram.com/p/abc/'), 'https://www.instagram.com/p/abc/');
  assert.equal(ctx.safeUrl('http://x.com'), 'http://x.com');
  for (const bad of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,hi', 'vbscript:x', '//evil.com', '']) {
    assert.equal(ctx.safeUrl(bad), '');
  }
});

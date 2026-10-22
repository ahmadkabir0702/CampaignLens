// The sign-off checklist rules, shared by the page and the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../public/js/signoff-items');

test('a new checklist cannot be sent', () => {
  const rec = { brand_id: '', meta: {}, fields: I.blankFields() };
  const p = I.progress(rec);
  // The budget split starts filled in with a default; nothing else does.
  assert.ok(p.done <= 1);
  assert.equal(p.done + p.missing.length, p.total);
  assert.equal(I.submitProblems(rec).length, p.missing.length);
});

test('required items count matches the item list', () => {
  const required = I.ITEMS.filter((i) => i.required).length;
  assert.equal(I.progress({ brand_id: '', meta: {}, fields: I.blankFields() }).total, required);
});

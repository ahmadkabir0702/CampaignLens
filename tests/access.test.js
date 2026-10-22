// Brand access: a session only reaches the brands it was given.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBrandAllowed } = require('../db');

test('a brand on the session is allowed', () => {
  assert.equal(assertBrandAllowed({ brands: ['lux', 'ponds'] }, 'lux'), 'lux');
});

test('a brand not on the session is refused with 403', () => {
  assert.throws(() => assertBrandAllowed({ brands: ['lux'] }, 'dove'), (e) => e.status === 403);
});

test('no session or no brand is refused', () => {
  assert.throws(() => assertBrandAllowed(null, 'lux'), (e) => e.status === 403);
  assert.throws(() => assertBrandAllowed({ brands: ['lux'] }, ''), (e) => e.status === 400);
});

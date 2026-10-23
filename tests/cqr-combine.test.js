// One paid rating for a creative on Meta and TikTok: grades combined by impressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { combineGrades, weightedRate } = require('../server/cqr-combine');

const p = (cqr, impressions) => ({ cqr, impressions });

test('one platform: its own grade', () => {
  assert.equal(combineGrades([p('Average', 50000)]), 'Average');
});

test('the platform with most delivery decides most of the rating', () => {
  assert.equal(combineGrades([p('Good', 20000), p('Poor', 180000)]), 'Poor');
  assert.equal(combineGrades([p('Good', 180000), p('Poor', 20000)]), 'Good');
  assert.equal(combineGrades([p('Good', 100000), p('Poor', 100000)]), 'Average', 'an even split lands in the middle');
});

test('ties round up', () => {
  assert.equal(combineGrades([p('Good', 1), p('Average', 1)]), 'Good');
  assert.equal(combineGrades([p('Average', 1), p('Poor', 1)]), 'Average');
});

test('a platform without a grade does not count', () => {
  assert.equal(combineGrades([p('Poor', 300000), p('Low Delivery', 4000)]), 'Poor');
  assert.equal(combineGrades([p('Low Delivery', 4000), p('Low Delivery', 3000)]), 'Low Delivery');
  assert.equal(combineGrades([]), null);
});

test('rates are weighted by impressions', () => {
  const r = weightedRate([{ hook: 10, impressions: 90 }, { hook: 30, impressions: 10 }], 'hook');
  assert.equal(r, 12);
  assert.equal(weightedRate([{ hook: 10, impressions: 0 }, { hook: 20, impressions: 0 }], 'hook'), 15, 'no impressions: plain mean');
});

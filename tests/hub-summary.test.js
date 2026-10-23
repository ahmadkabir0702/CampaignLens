// The Creative Hub's named tiles: the weak list is Poor only and the top
// list is Average or better, so one creative is never on both.
const test = require('node:test');
const assert = require('node:assert');
const { summarize } = require('../server/hub');

const now = new Date('2026-10-23T12:00:00Z');
const c = (id, cqr, extra = {}) => ({ id, cqr, date: '2026-10-10', boostState: 'running', type: 'Brand Say', ...extra });

test('two running creatives: Average is top only, Poor is weak only', () => {
  const s = summarize([c('A', 'Average'), c('B', 'Poor')], now);
  assert.deepStrictEqual(s.top.map(x => x.id), ['A']);
  assert.deepStrictEqual(s.weak.map(x => x.id), ['B']);
  assert.strictEqual(s.weakIsLive, true);
});

test('nothing Poor: the weak list is empty, not the least good', () => {
  const s = summarize([c('A', 'Good'), c('B', 'Average')], now);
  assert.deepStrictEqual(s.weak, []);
  assert.strictEqual(s.rated, 2);
});

test('everything Poor this month: the top list is empty', () => {
  const s = summarize([c('A', 'Poor'), c('B', 'Poor')], now);
  assert.deepStrictEqual(s.top, []);
  assert.strictEqual(s.monthRated, 2);
  assert.strictEqual(s.weak.length, 2);
});

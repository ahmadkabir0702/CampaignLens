// The one fatigue rule (assessFade), used by the Creative Hub, the fatigue
// panel and Ask Lens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessFade } = require('../server/fatigue');

const win = (cqr, impressions, extra = {}) => ({ cqr, impressions, spend: 100, ...extra });
const life = (days) => ({ from_date: '2026-09-01', to_date: new Date(Date.parse('2026-09-01') + (days - 1) * 864e5).toISOString().slice(0, 10) });

test('Good first week, Poor last week, run 21 days: faded', () => {
  const a = assessFade({ first_7: win('Good', 5000), last_7: win('Poor', 5000, { is_active: true, is_current: true }), lifetime: life(21) });
  assert.equal(a.checked, true);
  assert.equal(a.faded, true);
  assert.equal(a.still_running, true);
  assert.deepEqual([a.from, a.to], ['Good', 'Poor']);
});

test('same grade both weeks: held, not faded', () => {
  const a = assessFade({ first_7: win('Average', 5000), last_7: win('Average', 5000), lifetime: life(30) });
  assert.equal(a.faded, false);
  assert.equal(a.trend.direction, 'held');
});

test('better last week: improved', () => {
  const a = assessFade({ first_7: win('Poor', 5000), last_7: win('Good', 5000), lifetime: life(30) });
  assert.equal(a.trend.direction, 'improved');
});

test('under 14 days: not read', () => {
  const a = assessFade({ first_7: win('Good', 5000), last_7: win('Poor', 5000), lifetime: life(10) });
  assert.equal(a.checked, false);
  assert.equal(a.reason, 'too short');
});

test('thin last week or thin first week: not read', () => {
  assert.equal(assessFade({ first_7: win('Good', 5000), last_7: win('Poor', 400), lifetime: life(30) }).reason, 'thin last week');
  assert.equal(assessFade({ first_7: win('Good', 300), last_7: win('Poor', 5000), lifetime: life(30) }).reason, 'thin first week');
});

test('ungraded week or missing windows: not read', () => {
  assert.equal(assessFade({ first_7: win('Low Delivery', 5000), last_7: win('Poor', 5000), lifetime: life(30) }).checked, false);
  assert.equal(assessFade({ last_7: win('Poor', 5000), lifetime: life(30) }).checked, false);
  assert.equal(assessFade(undefined).checked, false);
});

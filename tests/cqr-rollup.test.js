// CQR Good rate, Hook Good rate and Hold Good rate: weighted by impressions,
// Meta and TikTok worked out apart and combined by adding impressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../server/cqr-rollup');
const RATES = require('../server/chat/rates');

// One row per video and platform, as loadRows returns them.
const ROWS = [
  // Meta: 3 rated videos, 600k rated impressions, 400k of them Good.
  { platform: 'meta', brand_id: 'lux', creative_id: 'A', campaign: 'Diwali 2026', impr: '400000', cqr: 'Good', hook_q: 'Strong', hold_q: 'Good' },
  { platform: 'meta', brand_id: 'lux', creative_id: 'B', campaign: 'Diwali 2026', impr: '150000', cqr: 'Average', hook_q: 'Good', hold_q: 'Weak' },
  { platform: 'meta', brand_id: 'lux', creative_id: 'C', campaign: 'Always on', impr: '50000', cqr: 'Poor', hook_q: 'Weak', hold_q: 'Weak' },
  // Under 10,000: not rated, outside the three rates, inside Impressions rated's total.
  { platform: 'meta', brand_id: 'lux', creative_id: 'D', campaign: 'Always on', impr: '8000', cqr: 'Low Delivery', hook_q: 'Strong', hold_q: 'Strong' },
  // TikTok: the same video A rated Poor there, and one Good video.
  { platform: 'tiktok', brand_id: 'lux', creative_id: 'A', campaign: 'Diwali 2026', impr: '100000', cqr: 'Poor', hook_q: 'Weak', hold_q: 'Weak' },
  { platform: 'tiktok', brand_id: 'lux', creative_id: 'E', campaign: 'Always on', impr: '300000', cqr: 'Good', hook_q: 'Good', hold_q: 'Strong' },
];

// Engagement rows, as loadEngagement returns them: per creative and platform,
// all delivery, and the part on days with engagement data.
const ENG = [
  // Meta video A: 400k impressions, 300k of them on days with engagement data.
  { platform: 'meta', brand_id: 'lux', creative_id: 'A', campaign: 'Diwali 2026', impr: '400000', spend: '120000', eng_impr: '300000', eng_spend: '90000', eng: '9000' },
  // Meta photo P: counts for engagement though it has no CQR.
  { platform: 'meta', brand_id: 'lux', creative_id: 'P', campaign: 'Always on', impr: '100000', spend: '20000', eng_impr: '100000', eng_spend: '20000', eng: '1000' },
  // TikTok E: no engagement data yet.
  { platform: 'tiktok', brand_id: 'lux', creative_id: 'E', campaign: 'Always on', impr: '300000', spend: '60000', eng_impr: '0', eng_spend: '0', eng: '0' },
  { platform: 'tiktok', brand_id: 'lux', creative_id: 'A', campaign: 'Diwali 2026', impr: '100000', spend: '15000', eng_impr: '100000', eng_spend: '15000', eng: '6000' },
];

// True reach, as the Reach sync stores it.
const REACH = [
  { brand_id: 'lux', platform: 'meta', campaign: '', reach: '200000', basis: 'ads', error: null, period_start: '2025-01-01', period_end: '2026-11-24' },
  { brand_id: 'lux', platform: 'tiktok', campaign: '', reach: '50000', basis: 'ads', error: null, period_start: '2025-01-01', period_end: '2026-11-24' },
  { brand_id: 'lux', platform: 'meta', campaign: 'Always on', reach: '20000', basis: 'ads', error: null, period_start: '2025-01-01', period_end: '2026-11-24' },
  // TikTok would not give reach for one campaign.
  { brand_id: 'lux', platform: 'tiktok', campaign: 'Diwali 2026', reach: null, basis: 'ads', error: 'TikTok: filter not supported', period_start: '2025-01-01', period_end: '2026-11-24' },
];

function fakeQuery(rows, span = { first_day: '2025-01-03', last_day: '2026-11-21' }, eng = ENG, reach = REACH) {
  const calls = [];
  const q = async (text, params) => {
    calls.push({ text, params });
    if (/from paid_reach/.test(text)) {
      if (reach === 'missing') throw Object.assign(new Error('relation "paid_reach" does not exist'), { code: '42P01' });
      if (/period_start = \$2/.test(text)) return { rows: [] };
      return { rows: params[1] === 'all_time' ? reach.filter((r) => params[0].includes(r.brand_id)) : [] };
    }
    if (/first_day/.test(text)) return { rows: [span] };
    if (/eng_ig_follows/.test(text)) return { rows: [{ seen: false }] };
    if (/bool_and/.test(text)) {
      if (eng === 'missing') throw Object.assign(new Error('column "engagements" does not exist'), { code: '42703' });
      return { rows: eng.filter((r) => params[0].includes(r.brand_id)) };
    }
    const ids = params[0];
    return { rows: rows.filter((r) => ids.includes(r.brand_id)) };
  };
  q.calls = calls;
  return q;
}

test('rates are shares of rated impressions, not of videos', () => {
  const t = R.threeWay(ROWS);
  assert.equal(t.meta.cqr_good_rate, 66.7);          // 400k / 600k
  assert.equal(t.meta.hook_good_rate, 91.7);         // (400k + 150k) / 600k, Strong counts as Good
  assert.equal(t.meta.hold_good_rate, 66.7);
  assert.equal(t.meta.cqr_good_n, 1);
  assert.equal(t.meta.rated_n, 3);
  assert.equal(t.meta.video_n, 4);
});

test('Low Delivery stays out of the rates but in Impressions rated', () => {
  const t = R.threeWay(ROWS);
  assert.equal(t.meta.rated_impressions, 600000);
  assert.equal(t.meta.impressions, 608000);
  assert.equal(t.meta.rated_share, 98.7);
});

test('combined adds impressions; it does not average the two rates', () => {
  const t = R.threeWay(ROWS);
  assert.equal(t.tiktok.cqr_good_rate, 75);          // 300k / 400k
  // (400k + 300k) / (600k + 400k) = 70%. The average of 66.7 and 75 would be 70.8.
  assert.equal(t.combined.cqr_good_rate, 70);
  // A video on both platforms counts once on each.
  assert.equal(t.combined.rated_n, 5);
  assert.equal(t.combined.cqr_good_n, 2);
});

test('nothing rated reads as no figure, not zero', () => {
  const t = R.threeWay([{ platform: 'meta', impr: 5000, cqr: 'Low Delivery' }]);
  assert.equal(t.meta.cqr_good_rate, null);
  assert.equal(t.meta.rated_share, 0);
  assert.equal(t.tiktok.impressions, 0);
  assert.equal(t.tiktok.rated_share, null);
});

test('forBrand splits by campaign, most impressions first, and passes the dates', async () => {
  R.clearCache();
  const q = fakeQuery(ROWS);
  const out = await R.forBrand(q, 'lux', { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(out.campaigns.map((c) => c.name), ['Diwali 2026', 'Always on']);
  assert.equal(out.campaigns[0].combined.impressions, 650000);
  assert.equal(out.span.first_day, '2025-01-03');
  const main = q.calls.find((c) => !/first_day/.test(c.text));
  assert.deepEqual(main.params, [['lux'], '2026-01-01', '2026-03-31']);
});

test('dates are checked before any query runs', async () => {
  R.clearCache();
  const q = fakeQuery(ROWS);
  await assert.rejects(R.forBrand(q, 'lux', { from: '2026-13-45' }), (e) => e.status === 400);
  await assert.rejects(R.forBrand(q, 'lux', { from: "2026-01-01' or 1=1" }), (e) => e.status === 400);
  await assert.rejects(R.forBrand(q, 'lux', { to: '2026-02-30' }), (e) => e.status === 400);
  await assert.rejects(R.forBrand(q, 'lux', { from: '2026-03-01', to: '2026-01-01' }), (e) => e.status === 400);
  assert.equal(q.calls.length, 0);
});

test('comparison keeps each brand to its own rows', async () => {
  R.clearCache();
  const rows = [...ROWS, { platform: 'meta', brand_id: 'dove', creative_id: 'Z', campaign: 'X', impr: '100000', cqr: 'Good', hook_q: 'Good', hold_q: 'Good' }];
  const out = await R.forBrands(fakeQuery(rows), ['lux', 'dove'], {});
  const dove = out.brands.find((b) => b.brand_id === 'dove');
  assert.equal(dove.combined.impressions, 100000);
  assert.equal(dove.combined.cqr_good_rate, 100);
  assert.equal(out.brands.find((b) => b.brand_id === 'lux').combined.impressions, 1008000);
});

test('Ask Lens records: ids carry the range, campaign and platform', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', { from: '2026-01-01' });
  const { records } = RATES.recordsFrom(out);
  const all = records['rates:2026-01-01:all:all:combined'];
  assert.equal(all.cqr_good_rate, 70);
  assert.match(all.scope_label, /All campaigns, Meta and TikTok combined, from 1 Jan 2026/);
  const diwali = records['rates:2026-01-01:all:diwali-2026:meta'];
  assert.equal(diwali.campaign, 'Diwali 2026');
  assert.equal(diwali.cqr_good_rate, 72.7);         // 400k / 550k
  for (const id of Object.keys(records)) assert.match(id, RATES.ID_RE);
});

test('an old marker id resolves again; anything else is ignored', async () => {
  R.clearCache();
  const got = await RATES.resolveIds(fakeQuery(ROWS), 'lux',
    ['rates:all:all:always-on:tiktok', 'rates:all:all:nope:meta', 'rates:../../x', 'VASELINE_1']);
  assert.deepEqual(Object.keys(got), ['rates:all:all:always-on:tiktok']);
  assert.equal(got['rates:all:all:always-on:tiktok'].cqr_good_rate, 100);
});

test('the paid_rates tool matches a campaign by part of its name', async () => {
  R.clearCache();
  const res = await RATES.tool({ campaign: 'diwali', platform: 'combined' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.equal(res.result.rows.length, 1);
  assert.equal(res.result.rows[0].id, 'rates:all:all:diwali-2026:combined');
  assert.ok(res.records['rates:all:all:diwali-2026:combined']);
  assert.ok(JSON.stringify(res.result).length < 1500);

  const miss = await RATES.tool({ campaign: 'ramadan' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.match(miss.result.error, /No campaign/);

  const bad = await RATES.tool({ from: 'yesterday' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.match(bad.result.error, /YYYY-MM-DD/);
});

test('engagement rate is engagements over true reach', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  const m = out.overall.meta;
  assert.equal(out.engagement_ready, true);
  assert.equal(out.reach.status, 'ok');
  assert.equal(out.reach.period, 'all_time');
  // (9,000 + 1,000) engagements / 200,000 people
  assert.equal(m.reach, 200000);
  assert.equal(m.paid_engagement_rate, 5);
  // Cost per engagement is unchanged: (90,000 + 20,000) / 10,000
  assert.equal(m.cost_per_engagement, 11);
  assert.equal(m.eng_coverage, 80);
});

test('combined divides all engagements by both reaches added, never an average', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  assert.equal(out.overall.tiktok.paid_engagement_rate, 12);       // 6,000 / 50,000
  // 16,000 / 250,000 = 6.4%. The average of 5 and 12 would be 8.5.
  assert.equal(out.overall.combined.reach, 250000);
  assert.equal(out.overall.combined.paid_engagement_rate, 6.4);
  // A campaign with delivery on a platform whose reach failed has no
  // Combined rate: half a denominator would overstate it.
  const diwali = out.campaigns.find((x) => x.name === 'Diwali 2026');
  assert.equal(diwali.tiktok.paid_engagement_rate, null);
  assert.equal(diwali.combined.paid_engagement_rate, null);
  assert.equal(out.campaigns.find((x) => x.name === 'Always on').meta.paid_engagement_rate, 5);   // 1,000 / 20,000
});

test('a custom range has no engagement rate; a calendar month is a period', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', { from: '2026-03-04', to: '2026-04-09' });
  assert.equal(out.reach.status, 'custom');
  assert.equal(out.overall.combined.paid_engagement_rate, null);
  assert.equal(out.overall.combined.cost_per_engagement, 7.81);     // still there
  assert.equal(R.monthPeriod('2026-02-01', '2026-02-28'), 'month:2026-02');
  assert.equal(R.monthPeriod('2026-02-01', '2026-02-27'), null);
  assert.throws(() => R.cleanPeriod('forever'), (e) => e.status === 400);
});

test('before 046 or 047 is run the CQR figures still come back', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS, undefined, 'missing'), 'lux', {});
  assert.equal(out.engagement_ready, false);
  assert.equal(out.overall.combined.cqr_good_rate, 70);
  assert.equal(out.overall.combined.paid_engagement_rate, undefined);
  R.clearCache();
  const noReach = await R.forBrand(fakeQuery(ROWS, undefined, ENG, 'missing'), 'lux', {});
  assert.equal(noReach.reach.status, 'not_ready');
  assert.equal(noReach.overall.combined.paid_engagement_rate, null);
});

test('Ask Lens records carry the engagement figures', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  const { records } = RATES.recordsFrom(out);
  assert.equal(records['rates:all:all:all:combined'].paid_engagement_rate, 6.4);
  assert.equal(records['rates:all:all:always-on:meta'].cost_per_engagement, 20);
  const res = await RATES.tool({ platform: 'combined' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.equal(res.result.rows[0].paid_engagement_rate, 6.4);
  const custom = await RATES.tool({ from: '2026-03-04', to: '2026-04-09', platform: 'combined' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.match(custom.result.engagement_rate, /true reach/);
});

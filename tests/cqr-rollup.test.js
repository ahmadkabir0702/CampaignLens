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

function fakeQuery(rows, span = { first_day: '2025-01-03', last_day: '2026-11-21' }, eng = ENG) {
  const calls = [];
  const q = async (text, params) => {
    calls.push({ text, params });
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

test('engagement rate counts only days with engagement data, on both sides', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  const m = out.overall.meta;
  assert.equal(out.engagement_ready, true);
  // (9,000 + 1,000) / (300k + 100k) = 2.5%. All 500k would give 2%.
  assert.equal(m.paid_engagement_rate, 2.5);
  // (90,000 + 20,000) / 10,000 engagements
  assert.equal(m.cost_per_engagement, 11);
  assert.equal(m.eng_coverage, 80);
  assert.equal(m.eng_creative_n, 2);
  assert.equal(m.paid_creative_n, 2);
});

test('combined engagement adds the platforms; nothing read reads as no figure', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  const t = out.overall.tiktok, c = out.overall.combined;
  assert.equal(t.paid_engagement_rate, 6);           // 6,000 / 100k; E has no data and is left out
  assert.equal(t.eng_coverage, 25);
  // 16,000 / 500k = 3.2%. The average of 2.5 and 6 would be 4.25.
  assert.equal(c.paid_engagement_rate, 3.2);
  assert.equal(c.cost_per_engagement, 7.81);         // 125,000 / 16,000
  const always = out.campaigns.find((x) => x.name === 'Always on');
  assert.equal(always.tiktok.paid_engagement_rate, null);
  assert.equal(always.tiktok.cost_per_engagement, null);
});

test('before 046 is run the CQR figures still come back, without engagement', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS, undefined, 'missing'), 'lux', {});
  assert.equal(out.engagement_ready, false);
  assert.equal(out.overall.combined.cqr_good_rate, 70);
  assert.equal(out.overall.combined.paid_engagement_rate, undefined);
});

test('Ask Lens records carry the engagement figures', async () => {
  R.clearCache();
  const out = await R.forBrand(fakeQuery(ROWS), 'lux', {});
  const { records } = RATES.recordsFrom(out);
  assert.equal(records['rates:all:all:all:combined'].paid_engagement_rate, 3.2);
  assert.equal(records['rates:all:all:always-on:meta'].cost_per_engagement, 20);
  const res = await RATES.tool({ platform: 'combined' }, { brand: 'lux' }, fakeQuery(ROWS));
  assert.equal(res.result.rows[0].paid_engagement_rate, 3.2);
});

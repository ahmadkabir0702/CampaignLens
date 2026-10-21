/**
 * signoff-items.js — the campaign sign-off checklist, defined once.
 *
 * Used by the page (progress, the form, the review) and by the server
 * (server/signoff/routes.js), which refuses a submit with required items
 * missing. One list, so the page and the server cannot disagree about
 * what "complete" means.
 *
 * A record is { brand_id, meta, fields }:
 *   meta    campaignName, market, goLive, clientLead, variant, format, datePrepared
 *   fields  funnel { tofu, mofu, bofu, budget { tofu, mofu, bofu }, bid { TOFU, MOFU, BOFU } }
 *           delivery { impressions, reach, ... }
 *           setup { audienceDone, startDate, endDate, tgSize, creativeTypes[], landingLinks }
 *           costs { platform, data, adServing, verification, pd1, retainer, ustore, google[], other }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignoffItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FUNNEL_BID = { TOFU: ['CPM'], MOFU: ['CPV', 'CPE'], BOFU: ['CPR', 'RoAS'] };
  const CREATIVE_TYPES = ['Video', 'Static', 'Carousel', 'Story', 'Collection', 'UGC'];
  const GOOGLE_ALLOC = ['pMax', 'Search', 'Demand Gen', 'Not used'];
  const DELIVERY_FIELDS = [
    ['impressions', 'Impressions'], ['reach', 'Reach'], ['vtr', 'VTR %'],
    ['er', 'ER %'], ['cvr', 'CVR %'], ['frequency', 'Frequency'],
    ['thruplays', 'ThruPlays'], ['postEng', 'Post Engagements'],
    ['clicks', 'Clicks'], ['purchases', 'Purchases'], ['purchaseValue', 'Purchases Value'],
  ];
  const YES_NO = ['Yes', 'No', 'N/A'];

  const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  const num = (v) => (v === '' || v === null || v === undefined || !isFinite(Number(v)) ? null : Number(v));
  const f = (r) => (r && r.fields) || {};
  const m = (r) => (r && r.meta) || {};
  const sect = (r, k) => f(r)[k] || {};
  const todayIso = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10); // Sri Lanka date

  const SECTIONS = [
    { key: 'details', title: 'Campaign details' },
    { key: 'funnel',  title: 'Funnel plan' },
    { key: 'delivery', title: 'Estimated delivery' },
    { key: 'setup',   title: 'Setup and targeting' },
    { key: 'costs',   title: 'Costs and allocations' },
  ];

  // Each item: what it is, whether it is needed to submit, and when it is
  // done. `problem` says what is missing, in the words shown to the user.
  const ITEMS = [
    { key: 'details', section: 'details', label: 'Campaign details', required: true,
      problem: (r) => {
        const x = m(r), miss = [];
        if (!has(x.campaignName)) miss.push('campaign name');
        if (!has(r && r.brand_id)) miss.push('brand');
        if (!has(x.market)) miss.push('market');
        if (!has(x.goLive)) miss.push('go-live date');
        if (!has(x.clientLead)) miss.push('client lead');
        if (!has(x.variant)) miss.push('variant');
        if (!has(x.format)) miss.push('format');
        return miss.length ? 'Missing ' + miss.join(', ') : null;
      } },
    { key: 'funnel_types', section: 'funnel', label: 'Campaign types across the funnel', required: true,
      problem: (r) => { const x = sect(r, 'funnel'); return has(x.tofu) || has(x.mofu) || has(x.bofu) ? null : 'Add the campaign type for at least one funnel stage'; } },
    { key: 'funnel_budget', section: 'funnel', label: 'Budget split across funnel areas', required: true,
      problem: (r) => {
        const b = sect(r, 'funnel').budget || {};
        const t = (num(b.tofu) || 0) + (num(b.mofu) || 0) + (num(b.bofu) || 0);
        return Math.abs(t - 100) < 0.01 ? null : `The split adds up to ${Math.round(t * 10) / 10}%, not 100%`;
      } },
    { key: 'funnel_bid', section: 'funnel', label: 'Bidding metrics by funnel', required: true,
      problem: (r) => {
        const x = sect(r, 'funnel'), bid = x.bid || {}, miss = [];
        if (has(x.tofu) && !has(bid.TOFU)) miss.push('TOFU');
        if (has(x.mofu) && !has(bid.MOFU)) miss.push('MOFU');
        if (has(x.bofu) && !has(bid.BOFU)) miss.push('BOFU');
        if (!has(x.tofu) && !has(x.mofu) && !has(x.bofu)) return 'Add the funnel stages first';
        return miss.length ? 'Pick a bidding metric for ' + miss.join(', ') : null;
      } },
    { key: 'delivery', section: 'delivery', label: 'Estimated delivery', required: true,
      problem: (r) => DELIVERY_FIELDS.some(([k]) => has(sect(r, 'delivery')[k])) ? null : 'Add at least one delivery estimate' },
    { key: 'audience', section: 'setup', label: 'Audience specification done?', required: true,
      problem: (r) => has(sect(r, 'setup').audienceDone) ? null : 'Answer yes, no or N/A' },
    { key: 'dates', section: 'setup', label: 'Start and end dates', required: true,
      problem: (r) => {
        const s = sect(r, 'setup');
        if (!has(s.startDate) || !has(s.endDate)) return 'Add both dates';
        return s.startDate <= s.endDate ? null : 'The end date is before the start date';
      } },
    { key: 'tg_size', section: 'setup', label: 'TG size', required: true,
      problem: (r) => has(sect(r, 'setup').tgSize) ? null : 'Add the target group size' },
    { key: 'creative_types', section: 'setup', label: 'Creative types', required: true,
      problem: (r) => (sect(r, 'setup').creativeTypes || []).length ? null : 'Pick at least one creative type' },
    { key: 'landing_links', section: 'setup', label: 'Landing page links', required: true,
      problem: (r) => has(sect(r, 'setup').landingLinks) ? null : 'Add the links, or write N/A' },
    { key: 'cost_platform', section: 'costs', label: 'Platform costs', required: true,
      problem: (r) => has(sect(r, 'costs').platform) ? null : 'Add the platform cost' },
    { key: 'cost_data', section: 'costs', label: 'Data costs', required: true,
      problem: (r) => has(sect(r, 'costs').data) ? null : 'Add the data cost, or write N/A' },
    { key: 'cost_adserving', section: 'costs', label: 'Ad serving costs', required: true,
      problem: (r) => has(sect(r, 'costs').adServing) ? null : 'Add the ad serving cost, or write N/A' },
    { key: 'cost_verification', section: 'costs', label: 'Verification costs included?', required: true,
      problem: (r) => has(sect(r, 'costs').verification) ? null : 'Answer yes, no or N/A' },
    { key: 'cost_1pd', section: 'costs', label: '1PD data allocation done?', required: true,
      problem: (r) => has(sect(r, 'costs').pd1) ? null : 'Answer yes, no or N/A' },
    { key: 'cost_retainer', section: 'costs', label: 'Retainer payment allocated?', required: true,
      problem: (r) => has(sect(r, 'costs').retainer) ? null : 'Answer yes, no or N/A' },
    { key: 'cost_ustore', section: 'costs', label: 'uStore allocation done?', required: true,
      problem: (r) => has(sect(r, 'costs').ustore) ? null : 'Answer yes, no or N/A' },
    { key: 'cost_google', section: 'costs', label: 'Google allocation', required: true,
      problem: (r) => (sect(r, 'costs').google || []).length ? null : 'Pick what is allocated, or Not used' },
    { key: 'cost_other', section: 'costs', label: 'Other costs', required: false,
      problem: () => null },
  ];

  /** Progress: required items done, out of required items. */
  function progress(record) {
    const req = ITEMS.filter((i) => i.required);
    const missing = req.filter((i) => i.problem(record));
    return { done: req.length - missing.length, total: req.length, missing: missing.map((i) => ({ key: i.key, label: i.label, problem: i.problem(record) })) };
  }

  /** Everything that stops a submit, including a go-live date already past. */
  function submitProblems(record) {
    const out = progress(record).missing.map((x) => `${x.label}: ${x.problem}`);
    const gl = m(record).goLive;
    if (has(gl) && gl < todayIso()) out.push('Campaign details: the go-live date has already passed');
    return out;
  }

  /** A blank record, the defaults the old form used. */
  function blankFields() {
    return {
      funnel: { tofu: '', mofu: '', bofu: '', budget: { tofu: 40, mofu: 35, bofu: 25 }, bid: { TOFU: null, MOFU: null, BOFU: null } },
      delivery: {},
      setup: { audienceDone: null, startDate: '', endDate: '', tgSize: '', creativeTypes: [], landingLinks: '' },
      costs: { platform: '', data: '', adServing: '', verification: null, pd1: null, retainer: null, ustore: null, google: [], other: '' },
    };
  }

  return { SECTIONS, ITEMS, FUNNEL_BID, CREATIVE_TYPES, GOOGLE_ALLOC, DELIVERY_FIELDS, YES_NO,
           progress, submitProblems, blankFields, todayIso };
});

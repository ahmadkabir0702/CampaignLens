/**
 * Digital share of voice routes. Mounted by server.js after login, so every
 * request has a session. The brand is checked with assertBrandAllowed before
 * anything is read (see the note at the top of routes.js).
 *
 *   GET /api/sov    every share of voice category the active brand belongs
 *                   to, with its latest published period, the month-by-month
 *                   history and the "what's behind this" panels.
 *                   ?preview=1 (internal accounts only) shows the latest
 *                   period even before it is published, for review.
 *
 * The tables hold shares only (0 to 1). No post, comment or mention counts
 * exist in the database, so none can reach the browser from here. Platform
 * splits are stored but not sent: the product speaks of social as a whole.
 */
const { query, assertBrandAllowed } = require('../../db');

const num = v => (v == null ? null : Number(v));

function send(res, err) {
  const msg = String(err.message || err);
  if (err.code === '42P01') {
    // Table missing: migration 017 has not been run on this database.
    return res.status(503).json({ error: 'Share of voice is not set up on this server yet.' });
  }
  const status = msg.startsWith('Access denied') || msg.startsWith('No brand access') ? 403 : 500;
  if (status === 500) console.error('[sov]', msg);
  res.status(status).json({ error: status === 403 ? msg : 'Could not load share of voice.' });
}

// Optional pieces read through a missing table or column without failing.
const soft = p => p.catch(e => { if (e.code === '42P01' || e.code === '42703') return { rows: [] }; throw e; });

async function categoryPayload(category, brandId, preview) {
  const pick = order => query(
    `select period_id, label, to_char(period_start, 'YYYY-MM-DD') as period_start,
            to_char(period_end, 'YYYY-MM-DD') as period_end, insights, is_published
       from sov_periods
      where category_id = $1 and (is_published or $2)
      order by ${order}
      limit 1`, [category.category_id, !!preview]);
  // An automated period beats the one-off study, even when the study ends
  // later (the first monthly period ends before it). Before migration 030
  // there is no cadence column, so the newest period is taken.
  const { rows: periods } = await pick(`(coalesce(cadence, 'study') = 'study'), period_end desc, period_id desc`)
    .catch(e => { if (e.code === '42703') return pick('period_end desc, period_id desc'); throw e; });
  const base = { id: category.category_id, name: category.name };
  if (!periods.length) return { ...base, period: null };
  const p = periods[0];

  const [brands, breakdowns, monthly, panelRows] = await Promise.all([
    query(
      `select cb.brand_name, cb.brand_id, cb.owner, cb.is_unilever, cb.sort_order,
              m.share_of_voice, m.share_no_contest, m.share_engagement, m.share_earned, m.share_public,
              m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative
         from sov_category_brands cb
         left join sov_brand_metrics m on m.period_id = $2 and m.brand_name = cb.brand_name
        where cb.category_id = $1
        order by cb.sort_order, cb.brand_name`, [category.category_id, p.period_id]),
    query(
      `select dimension, key, brand_name, grp, value
         from sov_breakdowns
        where period_id = $1
        order by dimension, sort_order, key`, [p.period_id]),
    // Month by month: each published monthly period's shares, oldest first.
    soft(query(
      `select to_char(p.period_start, 'YYYY-MM-DD') as month, m.brand_name, m.share_of_voice
         from sov_periods p join sov_brand_metrics m using (period_id)
        where p.category_id = $1 and p.cadence = 'monthly' and (p.is_published or p.period_id = $2)
          and p.period_end <= $3::date
        order by p.period_end`, [category.category_id, p.period_id, p.period_end])),
    soft(query(`select panel_key, content from sov_panels where period_id = $1`, [p.period_id])),
  ]);

  const by = d => breakdowns.rows.filter(r => r.dimension === d);
  const share = d => by(d).map(r => ({ label: r.key, group: r.grp || null, value: num(r.value) }));

  // Panels. Each Unilever brand sees only what was written for it.
  const active = brands.rows.find(r => brandId && r.brand_id === brandId);
  const panels = {};
  for (const r of panelRows.rows) {
    const c = r.content || {};
    const mine = active && c.implications ? c.implications[active.brand_name] : null;
    panels[r.panel_key] = { read: c.read || '', drivers: c.drivers || [], quotes: c.quotes || [],
      // Positive and negative voices, each with a short read. Older panels
      // only have quotes, and the page falls back to those.
      voices: c.voices || null,
      implication: mine ? mine.implication : null, nextStep: mine ? mine.next_step : null };
  }
  // Only months that came one after another, up to the last 12.
  const months = [...new Set(monthly.rows.map(r => r.month))].slice(-12);

  return {
    ...base,
    period: {
      label: p.label,
      start: p.period_start,
      end: p.period_end,
      preview: !p.is_published,
    },
    insights: Array.isArray(p.insights) ? p.insights : [],
    brands: brands.rows.map(r => ({
      name: r.brand_name,
      owner: r.owner,
      isUnilever: r.is_unilever,
      isActive: !!brandId && r.brand_id === brandId,
      shareOfVoice: num(r.share_of_voice),
      shareNoContest: num(r.share_no_contest),
      shareEngagement: num(r.share_engagement),
      shareEarned: num(r.share_earned),
      sharePublic: num(r.share_public),
      sentiment: r.sentiment_positive == null ? null : {
        positive: num(r.sentiment_positive),
        neutral: num(r.sentiment_neutral),
        negative: num(r.sentiment_negative),
      },
    })),
    weekly: by('weekly_share').map(r => ({ week: r.key, brand: r.brand_name, value: num(r.value) })),
    monthly: months.length >= 2
      ? monthly.rows.filter(r => months.includes(r.month)).map(r => ({ month: r.month, brand: r.brand_name, value: num(r.share_of_voice) }))
      : [],
    origin: by('voice_origin').map(r => ({ brand: r.brand_name, source: r.key, value: num(r.value) })),
    panels,
    publicBrands: share('public_brand'),
    topics: share('topic'),
    commentTypes: share('comment_type'),
    authorTypes: share('author_type'),
  };
}

module.exports = function mountShareOfVoice(app) {
  app.get('/api/sov', async (req, res) => {
    try {
      const requested = req.query.brand || req.session.activeBrand || (req.session.brands || [])[0];
      const brandId = assertBrandAllowed(req.session, requested);

      const [{ rows: brandRows }, { rows: cats }] = await Promise.all([
        query(`select brand_id, name from brands where brand_id = $1`, [brandId]),
        query(
          `select distinct c.category_id, c.name, c.sort_order
             from sov_categories c
             join sov_category_brands cb on cb.category_id = c.category_id
            where cb.brand_id = $1 and c.is_active
            order by c.sort_order, c.name`, [brandId]),
      ]);

      // Review before publishing: internal accounts can look at a period
      // that is not on the page yet.
      const preview = req.query.preview === '1' && !!req.session.isInternal;
      const categories = [];
      for (const c of cats) categories.push(await categoryPayload(c, brandId, preview));

      res.json({
        brand: { id: brandId, name: (brandRows[0] && brandRows[0].name) || brandId },
        categories,
      });
    } catch (err) {
      send(res, err);
    }
  });
};

/**
 * Digital share of voice routes. Mounted by server.js after login, so every
 * request has a session. The brand is checked with assertBrandAllowed before
 * anything is read (see the note at the top of routes.js).
 *
 *   GET /api/sov    every share of voice category the active brand belongs
 *                   to, with its latest published period
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

async function categoryPayload(category, brandId) {
  const { rows: periods } = await query(
    `select period_id, label, to_char(period_start, 'YYYY-MM-DD') as period_start,
            to_char(period_end, 'YYYY-MM-DD') as period_end, insights
       from sov_periods
      where category_id = $1 and is_published
      order by period_end desc, period_id desc
      limit 1`, [category.category_id]);
  const base = { id: category.category_id, name: category.name };
  if (!periods.length) return { ...base, period: null };
  const p = periods[0];

  const [brands, breakdowns] = await Promise.all([
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
  ]);

  const by = d => breakdowns.rows.filter(r => r.dimension === d);
  const share = d => by(d).map(r => ({ label: r.key, group: r.grp || null, value: num(r.value) }));

  return {
    ...base,
    period: {
      label: p.label,
      start: p.period_start,
      end: p.period_end,
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

      const categories = [];
      for (const c of cats) categories.push(await categoryPayload(c, brandId));

      res.json({
        brand: { id: brandId, name: (brandRows[0] && brandRows[0].name) || brandId },
        categories,
      });
    } catch (err) {
      send(res, err);
    }
  });
};

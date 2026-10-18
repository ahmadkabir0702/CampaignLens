/**
 * Collection for one category: brand posts, searches, creator countries and
 * conversation. Writes to sov_raw_posts and sov_raw_comments only.
 *
 * Incremental: `since` is where this run starts looking. Posts already
 * stored are updated (their numbers move), never duplicated. Conversation
 * is fetched once for new posts and refreshed for posts under two weeks old,
 * which is when nearly all of it arrives.
 */
const { pool } = require('./sc');
const T = require('./text');

const DAY = 86400000;

async function upsertPost(q, catId, p) {
  await q(
    `insert into sov_raw_posts (category_id, platform, post_id, source, owner_brand, url, author, published_at, body,
        likes, comments, shares, views, is_sri_lanka, sl_reason, search_brands, found_via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (category_id, platform, post_id) do update set
        likes = greatest(excluded.likes, sov_raw_posts.likes),
        comments = greatest(excluded.comments, sov_raw_posts.comments),
        shares = greatest(excluded.shares, sov_raw_posts.shares),
        views = greatest(excluded.views, sov_raw_posts.views),
        body = coalesce(nullif(excluded.body, ''), sov_raw_posts.body),
        published_at = coalesce(sov_raw_posts.published_at, excluded.published_at),
        source = case when sov_raw_posts.source = 'owned' or excluded.source = 'owned' then 'owned' else sov_raw_posts.source end,
        owner_brand = coalesce(sov_raw_posts.owner_brand, excluded.owner_brand),
        is_sri_lanka = case when sov_raw_posts.source = 'owned' or excluded.source = 'owned' then true
                            else coalesce(sov_raw_posts.is_sri_lanka, excluded.is_sri_lanka) end,
        sl_reason = coalesce(sov_raw_posts.sl_reason, excluded.sl_reason),
        search_brands = array(select distinct unnest(sov_raw_posts.search_brands || excluded.search_brands)),
        found_via = array(select distinct unnest(sov_raw_posts.found_via || excluded.found_via)),
        last_seen_at = now()`,
    [catId, p.platform, String(p.post_id), p.source, p.owner_brand || null, p.url || null, p.author || null,
     p.published_at || null, p.body || '', p.likes || 0, p.comments || 0, p.shares || 0, p.views || 0,
     p.is_sri_lanka, p.sl_reason || null, p.search_brands || [], p.found_via || []]);
}

// ── Brand pages ─────────────────────────────────────────────────────────────
async function ownedPosts(ctx) {
  const { sc, q, cat, P, since, log } = ctx;
  ctx.igUserIds = {};
  let n = 0;
  const keep = async p => { await upsertPost(q, cat.category_id, p); n++; };

  await pool(P.study, 4, async b => {
    // Facebook: three posts a page, newest first.
    if (b.facebook_url) {
      let cursor = null, old = 0;
      for (let page = 0; page < 60; page++) {
        const r = await sc.get('/v1/facebook/profile/posts', { url: b.facebook_url, cursor });
        const posts = r.posts || [];
        let pageOld = 0;
        for (const p of posts) {
          const t = T.toDate(p.publishTime || p.creation_time);
          if (!t) continue;
          if (t < since) { pageOld++; continue; }
          await keep({ platform: 'facebook', post_id: p.id, source: 'owned', owner_brand: b.brand_name, url: p.url || p.permalink,
            author: (p.author || {}).name, published_at: t, body: p.text, likes: p.reactionCount, comments: p.commentCount,
            views: p.videoViewCount, is_sri_lanka: true, sl_reason: 'brand page', found_via: ['owned'] });
        }
        old = posts.length && pageOld === posts.length ? old + 1 : 0;
        cursor = r.cursor;
        if (!cursor || !posts.length || old >= 2) break;
      }
    }
    // Instagram
    if (b.instagram_handle) {
      let cursor = null;
      for (let page = 0; page < 25; page++) {
        const r = await sc.get('/v2/instagram/user/posts', { handle: b.instagram_handle, next_max_id: cursor });
        const items = r.items || [];
        const uid = (r.user || {}).pk || (r.user || {}).id || (items[0] && (items[0].user || {}).pk);
        if (uid) ctx.igUserIds[b.brand_name] = String(uid);
        let pageOld = 0;
        for (const p of items) {
          const t = T.toDate(p.created_at || p.taken_at);
          if (!t) continue;
          if (t < since) { pageOld++; continue; }
          const cap = typeof p.caption === 'object' && p.caption ? p.caption.text : p.caption;
          await keep({ platform: 'instagram', post_id: p.code, source: 'owned', owner_brand: b.brand_name, url: p.url,
            author: (p.user || {}).username, published_at: t, body: cap, likes: Number(p.like_count || 0),
            comments: Number(p.comment_count || 0), views: Number(p.play_count || 0), is_sri_lanka: true, sl_reason: 'brand page', found_via: ['owned'] });
        }
        cursor = r.next_max_id;
        if (!r.more_available || !cursor || (items.length && pageOld === items.length)) break;
      }
    }
    // TikTok. The feed sometimes returns an empty page that is not the end.
    if (b.tiktok_handle) {
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const args = { handle: b.tiktok_handle, region: 'LK', sort_by: 'latest', trim: 'true', max_cursor: cursor };
        let r = await sc.get('/v3/tiktok/profile/videos', args);
        for (let k = 0; k < 2 && cursor && !(r.aweme_list || []).length; k++) r = await sc.get('/v3/tiktok/profile/videos', args);
        const items = r.aweme_list || [];
        let pageOld = 0;
        for (const v of items) {
          const t = T.toDate(v.create_time);
          if (!t) continue;
          if (t < since) { pageOld++; continue; }
          const s = v.statistics || {};
          await keep({ platform: 'tiktok', post_id: v.aweme_id, source: 'owned', owner_brand: b.brand_name,
            url: v.url || `https://www.tiktok.com/@${b.tiktok_handle}/video/${v.aweme_id}`, author: b.tiktok_handle,
            published_at: t, body: v.desc, likes: s.digg_count, comments: s.comment_count, shares: s.share_count,
            views: s.play_count, is_sri_lanka: true, sl_reason: 'brand page', found_via: ['owned'] });
        }
        cursor = r.max_cursor;
        if (!r.has_more || !cursor || (items.length && pageOld === items.length)) break;
      }
    }
  });
  log(`brand posts: ${n}`);
  ctx.stats.brandPosts = n;
}

// ── Searches ────────────────────────────────────────────────────────────────
function normalise(platform, a, via, P, now) {
  if (platform === 'tiktok') {
    const au = a.author || {};
    const handle = String(au.unique_id || au.uniqueId || '').toLowerCase();
    const s = a.statistics || {};
    const text = a.desc || '';
    let sl = null, why = null;
    if (a.region === 'LK') { sl = true; why = 'video country LK'; }
    else if (T.SINHALA.test(text)) { sl = true; why = 'Sinhala text'; }
    else if (a.region) { sl = false; why = `video country ${a.region}`; }
    return { platform, post_id: String(a.aweme_id || ''), url: a.url || `https://www.tiktok.com/@${handle}/video/${a.aweme_id}`,
      author: handle, published_at: T.toDate(a.create_time), body: text, likes: s.digg_count, comments: s.comment_count,
      shares: s.share_count, views: s.play_count, is_sri_lanka: sl, sl_reason: why };
  }
  if (platform === 'instagram') {
    const cap = typeof a.caption === 'object' && a.caption ? a.caption.text : (a.caption || '');
    const owner = a.owner || a.user || {};
    const handle = String(owner.username || '').toLowerCase();
    const loc = JSON.stringify(a.location || '');
    let sl = false, why = 'no Sri Lanka signal';
    if (via === 'tagged') { sl = true; why = 'tags a Sri Lankan brand account'; }
    else if (T.SINHALA.test(cap)) { sl = true; why = 'Sinhala text'; }
    else if (T.SL_SIGNS.test(cap) || T.SL_SIGNS.test(loc) || /(\.lk|_lk|\.sl|_sl|srilanka)$/.test(handle)) { sl = true; why = 'Sri Lanka mention or location'; }
    const id = a.shortcode || a.code || String(a.id || '');
    return { platform, post_id: id, url: a.url || `https://www.instagram.com/p/${id}/`, author: handle,
      published_at: T.toDate(a.taken_at) || T.igPkTime(a.pk || a.id), body: cap, likes: a.like_count, comments: a.comment_count,
      views: a.video_view_count || a.view_count, is_sri_lanka: sl, sl_reason: why };
  }
  const text = [a.title, a.description].filter(Boolean).join(' ');
  const au = a.author || {};
  const { date, views } = T.fbRelTime(a.relative_time_text, now);
  let sl = false, why = 'no Sri Lanka signal';
  if (T.SINHALA.test(text) || T.SINHALA.test(au.name || '')) { sl = true; why = 'Sinhala text'; }
  else if (T.SL_SIGNS.test(text) || T.SL_SIGNS.test(au.name || '') || T.SL_SIGNS.test(au.url || '')) { sl = true; why = 'Sri Lanka mention'; }
  return { platform: 'facebook', post_id: String(a.id || ''), url: a.url, author: au.name, published_at: date || T.toDate(a.publish_time || a.creation_time),
    body: text, likes: 0, comments: 0, views, is_sri_lanka: sl, sl_reason: why };
}

async function searches(ctx) {
  const { sc, q, cat, cfg, P, since, first, now, log } = ctx;
  let kept = 0, seen = 0;
  const pages = first ? 3 : 1;
  const ttWindow = first ? 'last-3-months' : 'this-month';
  const igWindow = 'last-year';   // the value the manual run used; older results are dropped by date below

  async function take(platform, items, via, brand) {
    for (const a of items || []) {
      seen++;
      const p = normalise(platform, a, via.split(':')[0], P, now);
      if (!p.post_id || !p.published_at || p.published_at < since) continue;
      const own = P.ownHandles.has(String(p.author || '').toLowerCase());
      const named = T.brandMentions(p.body, P);
      const other = T.otherMentions(p.body, P);
      const isCat = T.any(p.body, P.catRegs);
      if (!own && via !== 'tagged' && !named.length && !other.length && !isCat) continue;
      if (!own && T.GULF.test(p.body || '')) continue;
      const ownerBrand = own ? (P.study.find(b => b.handles.includes(String(p.author).toLowerCase())) || {}).brand_name : null;
      await upsertPost(q, cat.category_id, {
        ...p, source: own ? 'owned' : brand ? 'earned' : 'category', owner_brand: ownerBrand,
        is_sri_lanka: own ? true : p.is_sri_lanka, sl_reason: own ? 'brand account' : p.sl_reason,
        search_brands: brand ? [brand] : [], found_via: [via],
      });
      kept++;
    }
  }

  async function ttKeyword(query, brand) {
    let cursor = null;
    for (let i = 0; i < pages; i++) {
      const r = await sc.get('/v1/tiktok/search/keyword', { query, region: 'LK', date_posted: ttWindow, sort_by: 'relevance', trim: 'true', cursor });
      const list = (r.search_item_list || []).map(x => x.aweme_info || x);
      await take('tiktok', list, `kw:${query}`, brand);
      cursor = r.cursor;
      if (!cursor || !list.length) break;
    }
  }
  async function ttTag(tag, brand) {
    const r = await sc.get('/v1/tiktok/search/hashtag', { hashtag: tag, region: 'LK', trim: 'true' });
    await take('tiktok', r.aweme_list, `tag:${tag}`, brand);
  }
  async function igReels(query, brand) {
    const r = await sc.get('/v2/instagram/reels/search', { query, date_posted: igWindow, page: 1 });
    await take('instagram', r.reels, `reels:${query}`, brand);
  }
  async function igTag(tag, brand) {
    const r = await sc.get('/v1/instagram/search/hashtag', { hashtag: tag, date_posted: igWindow });
    await take('instagram', r.posts, `igtag:${tag}`, brand);
  }
  async function fbVideos(query, brand) {
    const r = await sc.get('/v1/facebook/search/videos', { query });
    await take('facebook', r.videos, `fbv:${query}`, brand);
  }

  const jobs = [];
  for (const b of P.study) {
    for (const s of b.searches || []) jobs.push(() => ttKeyword(s, b.brand_name), () => igReels(s, b.brand_name), () => fbVideos(s, b.brand_name));
    for (const h of b.hashtags || []) jobs.push(() => ttTag(h, b.brand_name), () => igTag(h, b.brand_name));
    const uid = (ctx.igUserIds || {})[b.brand_name];
    if (uid) jobs.push(async () => {
      let cursor = null;
      for (let i = 0; i < (first ? 3 : 1); i++) {
        const r = await sc.get('/v1/instagram/user/tagged-posts', { user_id: uid, cursor });
        await take('instagram', r.posts, 'tagged', b.brand_name);
        cursor = r.cursor;
        if (!cursor || !r.has_more) break;
      }
    });
  }
  for (const s of cfg.searches || []) jobs.push(() => ttKeyword(s, null));
  for (const s of cfg.facebook_searches || []) jobs.push(() => fbVideos(s, null));
  for (const s of cfg.instagram_searches || []) jobs.push(() => igReels(s, null));
  for (const h of cfg.hashtags || []) jobs.push(() => ttTag(h, null), () => igTag(h, null));

  await pool(jobs, 6, job => job());
  log(`searches: ${seen} results, ${kept} kept`);
  ctx.stats.searchResults = seen;
  ctx.stats.searchKept = kept;
}

// ── Creator countries (TikTok) ──────────────────────────────────────────────
async function creatorCountries(ctx) {
  const { sc, q, cat, log } = ctx;
  const { rows } = await q(
    `select distinct lower(p.author) as handle
       from sov_raw_posts p
       left join sov_creators c on c.handle = lower(p.author)
      where p.category_id = $1 and p.platform = 'tiktok' and p.source <> 'owned'
        and p.author is not null and p.author <> '' and c.handle is null
        and p.body !~ '[඀-෿]'
        and p.published_at >= $2`, [cat.category_id, ctx.since]);
  const limit = Number(process.env.SOV_REGION_CHECKS_PER_RUN || 600);
  const todo = rows.map(r => r.handle).slice(0, limit);
  await pool(todo, 8, async handle => {
    const r = await sc.get('/v1/tiktok/profile/region', { handle });
    await q(`insert into sov_creators (handle, region) values ($1, $2)
             on conflict (handle) do update set region = excluded.region, checked_at = now()`, [handle, r.region || null]);
  });
  // A known creator country decides, as it did in the manual run.
  await q(
    `update sov_raw_posts p
        set is_sri_lanka = (c.region = 'LK'), sl_reason = 'creator country ' || c.region
       from sov_creators c
      where p.category_id = $1 and p.platform = 'tiktok' and p.source <> 'owned'
        and c.handle = lower(p.author) and c.region is not null`, [cat.category_id]);
  log(`creator countries checked: ${todo.length}`);
  ctx.stats.creatorChecks = todo.length;
}

// ── Conversation ────────────────────────────────────────────────────────────
function commentFields(platform, c) {
  if (platform === 'facebook') {
    const a = c.author || {};
    return { id: c.id, text: c.text, date: c.created_at, likes: c.reaction_count, who: `${a.name || ''} ${a.id || ''}` };
  }
  if (platform === 'instagram') {
    const u = c.user || {};
    return { id: c.id, text: c.text, date: c.created_at, likes: c.comment_like_count, who: `${u.username || ''} ${u.pk || u.id || ''}` };
  }
  const u = c.user || {};
  return { id: c.cid || null, text: c.text, date: c.create_time, likes: c.digg_count, who: `${u.unique_id || ''} ${u.nickname || ''}` };
}

async function conversation(ctx) {
  const { sc, q, cat, P, log } = ctx;
  const fresh = new Date(Date.now() - 14 * DAY);
  // Brand posts in scope, and the Sri Lankan public content most worth reading.
  const { rows: targets } = await q(
    `(select platform, post_id, url, source, owner_brand, comments, comments_fetched_at
        from sov_raw_posts
       where category_id = $1 and source = 'owned' and comments > 0 and (label->>'relevant')::boolean
         and (comments_fetched_at is null or published_at >= $2)
         and published_at >= $3)
     union all
     (select platform, post_id, url, source, owner_brand, comments, comments_fetched_at
        from sov_raw_posts
       where category_id = $1 and source <> 'owned' and is_sri_lanka and (label->>'relevant')::boolean
         and (comments > 0 or platform = 'facebook')
         and (comments_fetched_at is null or published_at >= $2)
         and published_at >= $3
       order by comments desc
       limit 80)`, [cat.category_id, fresh, ctx.since]);

  const CAP = { facebook: 10, instagram: 8, tiktok: 8 };
  let added = 0;
  // Smallest threads first, so a few giveaway threads cannot use the budget for everyone.
  targets.sort((a, b) => Number(a.comments) - Number(b.comments));
  await pool(targets, 6, async t => {
    if (!t.url) return;
    const brand = t.owner_brand ? P.study.find(b => b.brand_name === t.owner_brand) : null;
    const brandTokens = brand ? [brand.brand_name.toLowerCase(), ...brand.handles] : [];
    const maxPages = t.source !== 'owned' ? 3 : t.comments_fetched_at ? 3 : CAP[t.platform];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      let r, items, more;
      if (t.platform === 'facebook') {
        r = await sc.get('/v1/facebook/post/comments', { url: t.url, cursor });
        items = r.comments || []; cursor = r.cursor; more = r.has_next_page;
      } else if (t.platform === 'instagram') {
        r = await sc.get('/v2/instagram/post/comments', { url: t.url, cursor });
        items = r.comments || []; cursor = r.cursor; more = !!cursor;
      } else {
        r = await sc.get('/v1/tiktok/video/comments', { url: t.url, cursor, trim: 'true' });
        items = r.comments || []; cursor = r.cursor; more = r.has_more;
      }
      for (const c of items) {
        const f = commentFields(t.platform, c);
        const who = String(f.who || '').toLowerCase();
        const key = T.sha([t.platform, t.post_id, f.id || '', f.text || '', String(f.date || ''), who].join('|'));
        const res = await q(
          `insert into sov_raw_comments (category_id, platform, post_id, comment_key, body, published_at, likes, kind, is_brand_reply)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
          [cat.category_id, t.platform, t.post_id, key, f.text || '', T.toDate(f.date), Number(f.likes || 0),
           T.commentKind(f.text), brandTokens.some(tok => tok && who.includes(tok))]);
        added += res.rowCount || 0;
      }
      if (r._error || !items.length || !more || !cursor) break;
    }
    await q(`update sov_raw_posts set comments_fetched_at = now() where category_id = $1 and platform = $2 and post_id = $3`,
      [cat.category_id, t.platform, t.post_id]);
  });
  log(`conversation: ${targets.length} threads, ${added} new`);
  ctx.stats.threads = targets.length;
  ctx.stats.newConversation = added;
}

module.exports = { ownedPosts, searches, creatorCountries, conversation };

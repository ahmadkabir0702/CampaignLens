/**
 * Text rules shared by collection, labelling and the numbers: which brand a
 * text names, whether it is about the category, whether it is Sri Lankan.
 */
const crypto = require('crypto');

const SINHALA = /[඀-෿]/;
const TAMIL = /[஀-௿]/;
const LETTERS = /[A-Za-z඀-෿஀-௿]/g;
// Sellers aiming at Sri Lankans in the Gulf write in Sinhala but are not
// Sri Lankan conversation.
const GULF = /kuwait|කුවේට්|dubai|ඩුබායි|saudi|qatar|oman|bahrain|\bkd\b|dinar|dirham|\baed\b|\bsar\b/i;
const SL_SIGNS = /sri\s?lanka|srilanka|#lka\b|\blka\b|colombo|kandy|galle|jaffna|negombo|kurunegala|matara|anuradhapura|ratnapura|batticaloa|trinco|ceylon|lanka|🇱🇰|\+94|\b07\d[\s-]?\d{3}[\s-]?\d{4}\b|keells|cargills|arpico|daraz\.lk|\.lk\b/i;

function compile(list) {
  const out = [];
  for (const s of list || []) {
    try { out.push(new RegExp(s, 'iu')); }
    catch (e) {
      try { out.push(new RegExp(s, 'i')); } catch (e2) { console.warn('[sov] bad pattern skipped:', s); }
    }
  }
  return out;
}
const any = (text, regs) => regs.some(r => r.test(text || ''));

/** Prepare a category's brands and config for matching. */
function prepare(cfg, brands) {
  const catRegs = compile(cfg.category_terms);
  const otherProducts = compile(cfg.other_products);
  const study = brands.map(b => ({
    ...b,
    termRegs: compile(b.terms && b.terms.length ? b.terms : [b.brand_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]),
    handles: [b.instagram_handle, b.tiktok_handle].filter(Boolean).map(h => h.toLowerCase()),
    tags: (b.hashtags || []).map(h => h.toLowerCase()),
  }));
  // {"Dove": "\\bdove\\b"} or {"Dove": {"pattern": "\\bdove\\b", "group": "Imported"}}
  const others = Object.entries(cfg.other_brands || {}).map(([name, v]) => {
    const pat = typeof v === 'string' ? v : (v && v.pattern) || name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { name, regs: compile([pat]), group: (v && v.group) || 'Other brand' };
  });
  const ownHandles = new Set(study.flatMap(b => b.handles));
  return { catRegs, otherProducts, study, others, ownHandles };
}

/** Study brands a text names, using the ambiguity rule. */
function brandMentions(text, P) {
  const t = (text || '').toLowerCase();
  const out = [];
  for (const b of P.study) {
    if (!any(t, b.termRegs)) continue;
    const own = b.tags.some(h => t.includes('#' + h)) || b.handles.some(h => t.includes('@' + h));
    if (own) { out.push(b.brand_name); continue; }
    if (b.is_ambiguous || b.page_scope === 'multi') { if (any(t, P.catRegs)) out.push(b.brand_name); }
    else out.push(b.brand_name);
  }
  return out;
}

function otherMentions(text, P) {
  return P.others.filter(o => any(text, o.regs)).map(o => o.name);
}

/** A label's brand name, mapped onto the tracker's own names where it is one of them. */
function canonBrand(name, P) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const b of P.study) {
    if (b.brand_name.toLowerCase() === n.toLowerCase() || b.handles.includes(n.toLowerCase().replace(/^@/, ''))) return b.brand_name;
    // The labeller already decided this is the brand, so the ambiguity rule does not apply here.
    if (any(n, b.termRegs)) return b.brand_name;
  }
  for (const o of P.others) if (o.name.toLowerCase() === n.toLowerCase() || any(n, o.regs)) return o.name;
  return n.replace(/\b\w/g, c => c.toUpperCase());
}

function productTag(text, P) {
  if (any(text, P.catRegs)) return 'category';
  if (any(text, P.otherProducts)) return 'other';
  return 'general';
}

function commentKind(text) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  const s = t.replace(/@[\w.]+/g, '').trim();
  if (!s) return 'tag';
  const letters = s.match(LETTERS) || [];
  if (!letters.length) return 'emoji';
  return letters.length <= 3 ? 'tiny' : 'text';
}

const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);

/**
 * The same short reply, written the same way, gets the same label, so it is
 * only sent to the labeller once: "price?", "nice", "done", "where to buy".
 * Only short texts that name no brand qualify; anything longer, or naming a
 * brand, depends on what it says and where, and is labelled on its own.
 * Returns null when the text does not qualify.
 */
function normKey(text, P) {
  const t = String(text || '').toLowerCase()
    .replace(/@[\w.]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}?! ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  if (P && (brandMentions(t, P).length || otherMentions(t, P).length || P.study.some(b => any(t, b.termRegs)))) return null;
  return t;
}

// A creator saying the content was made with a brand.
const DISCLOSURE = /#(ad|ads|sponsored|sponsor|paidpartnership|paid_partnership|partner|partnership|brandpartner|collab|collaboration|gifted|pr)\b|paid\s+partnership|in\s+(collab|collaboration|partnership)\s+with|sponsored\s+by|\bad\s*:/i;

/**
 * Was this public post made with one of the tracked brands? Looks at what
 * the platform says (collab co-authors, paid partnership labels, branded
 * content flags) and at disclosures in the text. Returns
 * { brand, reason } or null. A disclosure or an unnamed partnership label
 * only counts when exactly one tracked brand is named or tagged, so a
 * creator's #ad for something else is never pinned on a tracked brand.
 */
function backedBy(post, P) {
  const f = post.flags || {};
  const byHandle = h => P.study.find(b => b.handles.includes(String(h || '').toLowerCase().replace(/^@/, '')));
  for (const h of f.partners || []) {
    const b = byHandle(h);
    if (b) return { brand: b.brand_name, reason: f.coauthor ? 'collab' : 'paid partnership label' };
  }
  const text = post.body || '';
  const tagged = [...new Set((text.match(/@[\w.]+/g) || []).map(byHandle).filter(Boolean).map(b => b.brand_name))];
  const named = [...new Set([...brandMentions(text, P), ...tagged])];
  if (named.length !== 1) return null;
  if (f.paid) return { brand: named[0], reason: 'paid partnership label' };
  if (DISCLOSURE.test(text)) return { brand: named[0], reason: 'disclosure' };
  return null;
}

function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    let n = Number(v); if (n > 1e12) n = Math.floor(n / 1000);
    return new Date(n * 1000);
  }
  const d = new Date(String(v));
  return isNaN(d) ? null : d;
}

/** Instagram media id -> time it was posted. */
function igPkTime(pk) {
  try {
    const id = BigInt(String(pk).split('_')[0]);
    return new Date(Number((id >> 23n) + 1314220021721n));
  } catch (e) { return null; }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Facebook video search gives 'Sep 14 · 31K views', 'Mar 3, 2024 · ...' or '2 days ago'. */
function fbRelTime(s, now = new Date()) {
  if (!s) return { date: null, views: 0 };
  const parts = String(s).split('·').map(x => x.trim());
  let date = null, views = 0;
  let m = parts[0].match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    const y = m[3] ? Number(m[3]) : now.getUTCFullYear();
    date = new Date(Date.UTC(y, MONTHS[m[1].toLowerCase()], Number(m[2])));
    if (date > now) date = new Date(Date.UTC(y - 1, MONTHS[m[1].toLowerCase()], Number(m[2])));
  } else if ((m = parts[0].match(/(\d+)\s*([a-z]+)/i))) {
    const n = Number(m[1]), u = m[2].toLowerCase();
    const days = u.startsWith('w') ? n * 7 : u.startsWith('d') ? n : 0;
    date = new Date(now.getTime() - days * 86400000);
  } else if (/yesterday|just now/i.test(parts[0])) {
    date = new Date(now.getTime() - 86400000);
  }
  for (const p of parts.slice(1)) {
    const v = p.match(/([\d.]+)\s*([KMB]?)\s*views?/i);
    if (v) views = Math.round(Number(v[1]) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9 }[v[2].toUpperCase()]));
  }
  return { date, views };
}

module.exports = {
  SINHALA, TAMIL, GULF, SL_SIGNS, compile, any, prepare, brandMentions, otherMentions, canonBrand,
  productTag, commentKind, sha, toDate, igPkTime, fbRelTime, normKey, backedBy, DISCLOSURE,
};

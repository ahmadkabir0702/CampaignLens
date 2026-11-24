/**
 * lens_checks (server/045_lens_checks.sql). Plain queries, no logic.
 */
const { query } = require('../../db');

// The analysis fields the checks read. Kept small: the timeline text and
// anything else the creative panel already stores elsewhere are left out.
const ANALYSIS_KEYS = [
  'duration', 'format', 'product_role', 'hook', 'content_intent', 'narrative_structure',
  'hook_device', 'hook_subject', 'hook_pace', 'opens_with_product', 'opens_with_face',
  'has_text_overlay', 'logo_first_3s', 'captions', 'voiceover', 'music', 'cta', 'language',
  'timeline_attrs', 'time_to_product_s', 'product_screen_pct',
  'reasons', 'offer', 'cta_text', 'direct_action', 'urgency', 'brand_spoken_first_s',
];

function slimAnalysis(a) {
  if (!a) return null;
  const out = {};
  for (const k of ANALYSIS_KEYS) if (a[k] !== undefined) out[k] = a[k];
  if (typeof out.timeline_attrs === 'string') {
    try { out.timeline_attrs = JSON.parse(out.timeline_attrs); } catch (e) { out.timeline_attrs = []; }
  }
  return out;
}

const keyCols = ({ kind, creativeId, pretestId }) => (kind === 'creative'
  ? { where: `kind = 'creative' and creative_id = $1`, id: creativeId }
  : { where: `kind = 'pretest' and pretest_id = $1`, id: pretestId });

async function get(ref) {
  const k = keyCols(ref);
  const { rows } = await query(`select * from lens_checks where ${k.where}`, [k.id]);
  return rows[0] || null;
}

/** Insert or replace the row for one creative or pre-test. */
async function save(ref, f) {
  const funnel = f.funnel || null;
  const vals = [
    ref.kind, ref.creativeId || null, ref.pretestId || null, ref.brandId,
    f.status || 'succeeded',
    f.analysis ? JSON.stringify(f.analysis) : null,
    f.sound ? JSON.stringify(f.sound) : null,
    funnel ? JSON.stringify(funnel) : null,
    f.sound && f.sound.score != null ? f.sound.score : null,
    funnel ? funnel.intent : null,
    funnel && funnel.stages[funnel.intent] ? funnel.stages[funnel.intent].score : null,
    f.error || null, f.costUsd == null ? null : f.costUsd, f.expiresAt || null,
  ];
  const conflict = ref.kind === 'creative' ? `(creative_id) where kind = 'creative'` : `(pretest_id) where kind = 'pretest'`;
  const { rows } = await query(
    `insert into lens_checks (kind, creative_id, pretest_id, brand_id, status, analysis, sound, funnel,
                              sound_score, funnel_intent, funnel_fit, error, cost_usd, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict ${conflict} do update set
       status = excluded.status,
       analysis = coalesce(excluded.analysis, lens_checks.analysis),
       sound = coalesce(excluded.sound, lens_checks.sound),
       funnel = coalesce(excluded.funnel, lens_checks.funnel),
       sound_score = coalesce(excluded.sound_score, lens_checks.sound_score),
       funnel_intent = coalesce(excluded.funnel_intent, lens_checks.funnel_intent),
       funnel_fit = coalesce(excluded.funnel_fit, lens_checks.funnel_fit),
       error = excluded.error,
       cost_usd = coalesce(excluded.cost_usd, lens_checks.cost_usd),
       expires_at = coalesce(excluded.expires_at, lens_checks.expires_at),
       updated_at = now()
     returning *`, vals);
  return rows[0];
}

/** Only the funnel, after the Pre-test Score arrives. */
async function saveFunnel(id, funnel) {
  await query(
    `update lens_checks set funnel = $2, funnel_intent = $3, funnel_fit = $4, updated_at = now() where id = $1`,
    [id, JSON.stringify(funnel), funnel.intent,
     funnel.stages[funnel.intent] ? funnel.stages[funnel.intent].score : null]);
}

/** The latest Pre-test Score summary for a creative or a pre-test, or null. */
async function pretestSummary(ref) {
  const sql = ref.kind === 'creative'
    ? `select r.summary from brainsuite_jobs j join brainsuite_results r on r.job_id = j.id
        where j.creative_id = $1 and j.kind = 'creative' and j.status = 'succeeded'
        order by j.completed_at desc limit 1`
    : `select r.summary from brainsuite_results r where r.job_id = $1`;
  try {
    const { rows } = await query(sql, [ref.kind === 'creative' ? ref.creativeId : ref.pretestId]);
    return rows[0] ? rows[0].summary : null;
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

/** Card chips: what each creative is built for, and the sound score. */
async function forBrand(brandId) {
  try {
    const { rows } = await query(
      `select creative_id, funnel_intent, funnel_fit, sound_score from lens_checks
        where brand_id = $1 and kind = 'creative' and status = 'succeeded'`, [brandId]);
    return Object.fromEntries(rows.map(r => [r.creative_id, r]));
  } catch (e) {
    if (e.code === '42P01') return {};
    throw e;
  }
}

// Pre-test checks go when their report goes.
async function expire() {
  const { rows } = await query(
    `delete from lens_checks l using brainsuite_jobs j
      where l.kind = 'pretest' and l.pretest_id = j.id
        and (j.status = 'expired' or (l.expires_at is not null and l.expires_at < now())
             or (j.status = 'failed' and j.created_at < now() - interval '3 days'))
     returning l.id`);
  return rows.length;
}

async function removeForPretest(pretestId) {
  await query(`delete from lens_checks where kind = 'pretest' and pretest_id = $1`, [pretestId]);
}

module.exports = { slimAnalysis, get, save, saveFunnel, pretestSummary, forBrand, expire, removeForPretest, ANALYSIS_KEYS };

/**
 * Ask Lens - verified insight pipeline
 *
 * Free-form "summarise this brand" scores worse on both insightfulness and
 * correctness than a hypothesis-driven pipeline. So this does not summarise.
 * It runs a fixed set of analytical questions, answers each from computed
 * analytics, has Sonnet write it up in three sentences, then checks every
 * number in the write-up against the analytics and drops anything that does
 * not reconcile.
 *
 * Runs once per brand per rebuild. Nobody waits on it, so it uses the batch
 * price via a plain call queued after the warm response.
 */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const S = require('./schema.config');
const V = require('./vocab');
const num = (v) => (v === null || v === undefined || !isFinite(Number(v)) ? 0 : Number(v));
const { getPool } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Current Sonnet. Same listed price as 4.6. Override with ASK_LENS_WRITER_MODEL.
const WRITER_MODEL = process.env.ASK_LENS_WRITER_MODEL || 'claude-sonnet-5';
// A finding needs at least 2 creatives to compare. Below 5 it is written as
// an early signal: the writer must say so, and the verifier enforces it.
const MIN_EVIDENCE = 2;

/** A dimension as word comparisons on CQR, hook and hold. No numbers. */
function groupSentence(g) {
  const vs = g.vs || {};
  const cqr = vs.cqrSize ? `CQR ${vs.cqr} (${vs.cqrSize})` : `CQR ${vs.cqr || 'unknown'}`;
  const hook = `hook ${vs.hookMuch ? 'much ' : ''}${vs.hook || 'unknown'}`;
  const hold = `hold ${vs.holdMuch ? 'much ' : ''}${vs.hold || 'unknown'}`;
  return `${g.name || g.key}: ${cqr}, ${hook}, ${hold}${g.early ? '. Early sign, small group' : ''}.`;
}

/**
 * Two groups compared directly, worked out in code. Without this the writer
 * had to infer "Meta beats TikTok" from two separate comparisons with the
 * brand average, and the checker then rejected a true statement.
 */
function headToHead(a, b) {
  const side = (x, y, label, size) => {
    const d = num(x.v) - num(y.v);
    const rel = Math.abs(num(y.v)) > 0 ? Math.abs(d) / Math.abs(num(y.v)) : (d ? 1 : 0);
    if (rel < 0.08 && Math.abs(d) < 2) return `${label}: about even`;
    const win = d > 0 ? x.name : y.name;
    const margin = rel >= 0.5 ? 'by a wide margin' : rel >= 0.2 ? 'clearly' : 'slightly';
    return `${label}: ${win} stronger, ${margin}`;
  };
  return [
    side({ name: a.name, v: a.goodShare }, { name: b.name, v: b.goodShare }, 'CQR'),
    side({ name: a.name, v: a.hook_rate }, { name: b.name, v: b.hook_rate }, 'Hook'),
    side({ name: a.name, v: a.hold_rate }, { name: b.name, v: b.hold_rate }, 'Hold'),
  ].join('; ') + ((a.early || b.early) ? '. Early sign, small groups.' : '.');
}

/** A dimension as plain sentences on CQR, hook and hold. No numbers. */
function asWords(d) {
  if (!d || !d.groups) return null;
  const rep = d.groups.filter((g) => !g.tooFew);
  if (rep.length < MIN_EVIDENCE) return null;
  const tag = (x) => (x ? `${x.name}${x.early ? ' (early sign)' : ''}` : null);
  const out = {
    dimension: d.dimension,
    comparedWith: 'the brand overall',
    groups: rep.slice(0, 8).map(groupSentence),
    leaders: d.leaders ? `Leads on CQR: ${tag(d.leaders.cqr)}. Best hook: ${tag(d.leaders.hook)}. Best hold: ${tag(d.leaders.hold)}. Weakest on CQR: ${tag(d.leaders.weakestCqr)}.` : null,
  };
  if (rep.length === 2) out.headToHead = `${rep[0].name} against ${rep[1].name}: ${headToHead({ ...rep[0], name: rep[0].name || rep[0].key }, { ...rep[1], name: rep[1].name || rep[1].key })}`;
  if (d.groups.some((g) => g.tooFew)) out.note = 'Groups with a single creative are left out.';
  return out;
}

/** The best and weakest creatives, as a strategist would read them. */
function inside(an) {
  const line = (c) => [`${c.name}: ${c.rating}. ${c.is}.`, c.opening && `Opens: ${c.opening}`, c.losesPeople && `Loses most viewers ${c.losesPeople}.`, c.product && `${c.product}.`].filter(Boolean).join(' ');
  const ex = an.exemplars || { best: [], weakest: [] };
  return { insideTheBest: ex.best.map(line), insideTheWeakest: ex.weakest.map(line) };
}

const SEGMENT_WORDS = { 'hook to 25%': 'between the hook and a quarter of the way in', '25% to 50%': 'between 25% and 50% of the video', '50% to 75%': 'between 50% and 75% of the video', '75% to 100%': 'in the last quarter of the video' };

/**
 * The hypotheses. Each one pulls its own evidence out of the analytics
 * object. Returning null means "not enough data", and no finding is written.
 * This is where abstention is enforced, before a model ever sees the data.
 */
const HYPOTHESES = [
  {
    id: 'hook_device',
    guide: 'Say which opening hook leads on CQR and how it compares on hook and hold. Name the weakest on CQR. Mark early signs as early signs.',
    question: 'Which opening device produces the strongest hook rates, and is the gap real?',
    evidence: (an) => { const w = asWords(an.dims.hook_device); return w && { ...w, ...inside(an) }; },
  },
  {
    id: 'content_intent',
    guide: 'Say which purpose leads on CQR and how it compares on hook and hold. Name the weakest. If purposes compare similarly, say purpose makes little difference here.',
    question: 'Does what the creative is trying to do (educate, entertain, demonstrate) predict how it performs?',
    evidence: (an) => asWords(an.dims.content_intent),
  },
  {
    id: 'brandsay_vs_otherssay',
    guide: 'Compare Brand Say and Others Say on CQR, then hook, then hold. Say which is stronger on each, or that they perform alike.',
    question: 'Do creator-made (OthersSay) creatives hook or hold differently from brand-made (BrandSay)?',
    evidence: (an) => asWords(an.dims.type),
  },
  {
    id: 'spend_quality',
    guide: 'First, the lifetime split: what share of spend went to Good creatives and what share to Poor. If Poor received a share comparable to or larger than Good, that is the headline. Second, the present: say how many Poor creatives are still running and their spend (current waste), and separately how many were already stopped (a past inefficiency that has been dealt with). Never call allocation healthy when Poor received a large share, even if none are running now.',
    question: 'Is spend concentrated on the creatives that actually perform?',
    evidence: (an) => {
      const total = an.spendByCqr.Good + an.spendByCqr.Average + an.spendByCqr.Poor;
      if (!total || an.totals.creatives < MIN_EVIDENCE) return null;
      return {
        goodShare: Math.round(an.spendByCqr.Good / total * 100),
        poorShare: Math.round(an.spendByCqr.Poor / total * 100),
        spendByCqr: an.spendByCqr, cqrMix: an.cqrMix,
        poorStillRunning: { count: an.poorSplit.activeCount, spend: an.poorSplit.activeSpend },
        poorAlreadyStopped: { count: an.poorSplit.stoppedCount, spend: an.poorSplit.stoppedSpend },
      };
    },
  },
  {
    id: 'retention',
    guide: 'Say where most viewers leave after the hook and, if given, what is usually on screen at that point and when the product appears.',
    question: 'Where do creatives lose viewers, and is there a common cause?',
    evidence: (an) => {
      if (an.retention.drops.length < MIN_EVIDENCE) return null;
      const top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1])[0];
      const seg = top(an.retention.dropBySegment);
      if (!seg) return null;
      const ev = { mostViewersLeave: SEGMENT_WORDS[seg[0]] || seg[0] };
      const scr = top(an.retention.dropByScreen);
      if (scr) ev.mostOftenOnScreenAtThatPoint = scr[0];
      const t = an.retention.productTiming.avgTimeToProduct;
      if (t !== null && t !== undefined) ev.productUsuallyAppears = t <= 3 ? 'in the opening seconds' : t <= 8 ? 'early in the video' : 'late in the video';
      return ev;
    },
  },
  {
    id: 'platform_fit',
    guide: 'Compare Meta and TikTok on CQR, then hook, then hold. If they split, one stronger on hook and the other on CQR or hold, say what that means for the cuts on each platform.',
    question: 'Does the same creative perform differently on Meta and TikTok, and what does that say about the cuts?',
    evidence: (an) => {
      const w = asWords(an.dims.platform);
      if (!w) return null;
      Object.assign(w, inside(an));
      w.comparedWith = 'the average across both platforms';
      w.someCreativesRatedDifferentlyByPlatform = an.anomalies.some((a) => a.kind === 'platform_disagree');
      return w;
    },
  },
  {
    id: 'creator',
    guide: 'Say which creator leads on CQR and which trails, and how they compare on hook and hold.',
    question: 'Which creators deliver consistently, and which are inconsistent?',
    evidence: (an) => asWords(an.dims.creator),
  },
  {
    id: 'format',
    guide: 'Say which format leads on CQR and how it compares on hook and hold. Name the weakest. If formats compare similarly, say format makes little difference here.',
    question: 'Which creative formats perform best for this brand?',
    evidence: (an) => asWords(an.dims.format),
  },
  {
    id: 'product_role',
    guide: 'Say whether featuring the product more prominently goes with stronger or weaker CQR, hook and hold, or makes little difference.',
    question: 'Does featuring the product more prominently help or hurt performance?',
    evidence: (an) => asWords(an.dims.product_role),
  },
  {
    id: 'hook_hold',
    guide: 'Say where creatives mostly lose viewers and what that implies: fix the openings, or tighten the middle of the videos.',
    question: 'Do creatives mostly fail at the opening or in the body?',
    evidence: (an) => {
      const h = an.hookHold;
      if (h.rated < MIN_EVIDENCE || !h.mostlyLose) return null;
      return { whereViewersAreLost: h.mostlyLose, manyAreWeakOnBothHookAndHold: h.manyWeakOnBoth };
    },
  },
  {
    id: 'winners',
    guide: 'Say what the Good creatives have in common that the rest do not, leading with the strongest difference. Then explain why that likely works, using the playbook and what happens inside the best and weakest creatives. Then one or two specific tests.',
    question: 'What do the Good creatives share that the rest do not, and why does it likely work?',
    evidence: (an) => {
      if (!an.winners || !an.winners.statements.length) return null;
      return { whatTheGoodCreativesShare: an.winners.statements, ...(an.winners.early ? { sample: 'early sign, few creatives on one side' } : {}), ...inside(an) };
    },
  },
  {
    id: 'action',
    guide: 'Recommend exactly ONE next step, chosen from the evidence: Poor creatives still running, stopped Good creatives worth relaunching, a top action, the unboosted count, or the strongest discriminating dimension. The team judges CQR first, then hook, then hold: never recommend shifting toward something only because its hook rate is higher if its Good share or hold rate is lower. Say why. Do not claim anything is absent from the data.',
    question: 'What is the single highest-value change the team could make next?',
    evidence: (an) => {
      const topActions = an.top.filter((c) => c.action).slice(0, 5).map((c) => ({ id: c.id, action: c.action, priority: c.priority }));
      const hasSignal = an.discriminating.length || an.anomalies.length || an.waste.length
        || an.validatedUnboosted.length || topActions.length;
      if (!hasSignal || an.totals.creatives < MIN_EVIDENCE) return null;
      return {
        poorStillRunning: { count: an.poorSplit.activeCount, spend: an.poorSplit.activeSpend },
        whatSeparatesPerformance: an.discriminating.slice(0, 3).map((d) => ({
          dimension: d.dimension, leads: d.best, trails: d.worst, ...(d.early ? { sample: 'early sign' } : {}),
        })),
        anomalies: an.anomalies.map((a) => ({ kind: a.kind, n: a.n, note: a.note, ...(a.spend ? { spend: a.spend } : {}) })),
        wasteSpend: an.wasteSpend, wasteCount: an.waste.length,
        unboosted: an.validatedUnboosted.length,
        topActions,
      };
    },
  },
];


// ---------------------------------------------------------------
// Presentation. Evidence is formatted ONCE, here, and the same formatted
// version goes to the writer, the number check and the verifier. So the only
// numbers a finding can legitimately contain are ones that appear verbatim in
// what the writer was shown.
// ---------------------------------------------------------------

function compact(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v * 10) / 10);
}

function formatByKey(key, v) {
  const k = String(key);
  if (/spend/i.test(k)) return `${compact(v)} LKR`;
  if (/(hook_rate|hold_rate|engagement_rate|retention_rate|Hook$|screenpct|productscreenpct)/i.test(k)) return `${Number(v).toFixed(1)}%`;
  if (/share$/i.test(k)) return `${Math.round(Number(v))}%`;
  if (/(reach|views|impressions)$/i.test(k)) return compact(v);
  if (/timetoproduct/i.test(k)) return `${Number(v).toFixed(1)}s`;
  if (/(spread|cutsper10s)/i.test(k)) return Number(v).toFixed(1);
  return v; // counts and anything unrecognised stay as they are
}

function present(value, key = '', parentKey = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((x) => present(x, key, parentKey));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Internal fields the writer never needs. Codes are dropped in favour of
      // the plain name, so findings read "Dance or performance", not "dance_performance".
      if (['ids', 'tooFew', 'key', 'field', 'bestKey', 'worstKey', 'goodScore', 'confidence'].includes(k)) continue;
      // Children inherit this key as context: spendByCqr.Good is a spend figure.
      out[k] = present(v, k, key || parentKey);
    }
    return out;
  }
  if (typeof value === 'number') {
    const own = formatByKey(key, value);
    return own !== value ? own : formatByKey(parentKey, value);
  }
  return value;
}

// The playbook and team learnings come from the contract, so the writer and
// the chat reason from the same knowledge and the team edits it in one place.
let PLAYBOOK = '';
try {
  const c = require('fs').readFileSync(require('path').join(__dirname, 'contract.md'), 'utf8');
  const a = c.indexOf('## Creative playbook'), b = c.indexOf('## How to answer');
  if (a >= 0 && b > a) PLAYBOOK = c.slice(a, b).trim();
} catch (e) { /* the writer still works, just with less to draw on */ }

const WRITER_PROMPT = `You write findings for a creative performance dashboard used by a media team at WPP working on Unilever Sri Lanka brands. Write like a sharp creative strategist, not a report generator.

You are given one analytical question and evidence computed from the brand's data. The evidence is correct.

Write ONE paragraph in three parts, each starting with its label:
What the data shows: the fact, from the evidence. CQR first, then hook, then hold.
Why: the likely reason. Be concrete: name what happens on screen in the best and weakest creatives when the evidence includes them, and draw on the creative playbook below. Frame it as likely ("usually", "a common reason is"), never as proven.
What to test: one or two specific, testable next steps for this brand.

Keep it to about 90 to 140 words.

Rules:
- Group comparisons are given in words. Keep them in words. Do not write any digits except durations in seconds, and never state counts or percentages.
- CQR matters most, then hook, then hold. A stronger hook alone does not make something better.
- Where a head-to-head is given, use it for direct comparisons between the two groups.
- Something marked early sign is small: call it an early sign, never a pattern or rule.
- A single creative is never proof that a type works.
- Describe comparisons in the right direction. Re-read each one before finishing.
- Plain, direct wording. No em dashes, no emoji, no markdown symbols.

${PLAYBOOK}`;

const VERIFY_PROMPT = `You are checking a finding against the evidence it was written from. Call the verdict tool with your result.

The finding has three parts. "What the data shows" makes factual claims. "Why" is interpretation. "What to test" is advice.

Check the facts. Mark it NOT ok only if:
- a factual claim contradicts the evidence, including a comparison stated in the wrong direction
- it states a number, count or percentage that is not in the evidence (durations in seconds inside the advice are fine)
- it calls something marked early sign a pattern, trend or rule
- it treats a single creative as proof that a type works
- the Why part states its explanation as proven fact rather than as likely
- the advice contradicts the evidence

Group-to-group statements are correct when they follow from the evidence: if one group is stronger and another similar or weaker against the same baseline, the first is stronger than the second. A head-to-head in the evidence is authoritative.

Do NOT reject for: interpretation that is framed as likely, drawing on general creative principles, choosing what to emphasise, leaving things out, or wording and framing choices.`;

const VERDICT_TOOL = {
  name: 'verdict',
  description: 'Record whether the finding is supported by the evidence.',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      reason: { type: 'string', description: 'If not ok, one short sentence naming the specific problem.' },
    },
    required: ['ok'],
  },
};

/** Pull every number out of a string, for a cheap deterministic pre-check. */
function numbersIn(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/** Deterministic first pass: any number in the text must exist in the evidence. */
function numbersReconcile(body, evidence) {
  // Durations ("the first 3 seconds", "a 10-second cut") are advice or common
  // phrasing, not claims about the data. Everything else must be in the evidence.
  body = String(body).replace(/\b(first\s+)?\d+(\.\d+)?\s*(-|to|–)?\s*(\d+\s*)?(-?\s*seconds?|s\b|-second)/gi, '');
  const inEvidence = new Set(numbersIn(JSON.stringify(evidence)).map((n) => n.toFixed(1)));
  // Allow small integers, they are almost always counts of things listed.
  const claimed = numbersIn(body).filter((n) => n > 2);
  const bad = claimed.filter((n) => !inEvidence.has(n.toFixed(1)) && !inEvidence.has(Math.round(n).toFixed(1)));
  return { ok: bad.length === 0, bad };
}

const MAX_FINDINGS_AGE_DAYS = 7;

function fingerprint(an) {
  const rows = (an.ranked || []).map((c) => [c.id, c.cqr, c.is_active ? 1 : 0, c.hook_q, c.hold_q,
    c.hook_device, c.content_intent, c.format,
    // each platform's own status and rating: stopping on one platform matters
    Object.entries(c.per_platform || {}).map(([k, v]) => `${k}${v.is_active ? 1 : 0}${v.cqr || ''}`).sort().join(',')].join(':')).sort();
  return crypto.createHash('sha256').update(rows.join('|')).digest('hex').slice(0, 16);
}

async function writeFinding(h, evidence) {
  const res = await client.messages.create({
    model: WRITER_MODEL, max_tokens: 500,
    // The prompt and playbook are identical on every call in a run, so cache
    // them: calls come back to back, so the 5-minute cache is enough.
    system: [{ type: 'text', text: WRITER_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Question: ${h.question}\n\nWhat a good answer covers: ${h.guide || 'the clearest pattern in the evidence.'}\n\nEvidence:\n${JSON.stringify(evidence, null, 1)}` }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function verifyFinding(body, evidence) {
  const res = await client.messages.create({
    model: S.model, max_tokens: 200,
    system: VERIFY_PROMPT,
    tools: [VERDICT_TOOL],
    tool_choice: { type: 'tool', name: 'verdict' },
    messages: [{ role: 'user', content: `Finding:\n${body}\n\nEvidence:\n${JSON.stringify(evidence)}` }],
  });
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'verdict');
  if (call && typeof call.input.ok === 'boolean') return call.input;
  // Belt and braces: a forced tool call should always return, but never let a
  // parsing hiccup silently drop a finding without saying so.
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (typeof j.ok === 'boolean') return j; } catch (e) { /* fall through */ } }
  return { ok: false, reason: 'verifier gave no verdict' };
}

/** Generate and store verified findings for one brand. */
async function generateForBrand(brand, snapshot, opts = {}) {
  const pool = opts.pool || getPool();
  const an = snapshot.analytics;
  const out = { brand, written: 0, skipped: 0, rejected: 0 };

  // Start clean for this data version. Otherwise a question that now skips
  // would leave its old finding in place, and the chat would keep citing it.
  // Replace the brand's whole set. Findings are keyed by the creative
  // fingerprint, not the daily data version, so they survive until something
  // they depend on actually changes.
  const fp = fingerprint(an);
  await pool.query('delete from brand_insights where brand = $1', [brand]);

  for (const h of HYPOTHESES) {
    let evidence;
    try { evidence = h.evidence(an); }
    catch (err) {
      // A bug here must be visible, not mistaken for "not enough data".
      out.rejected += 1;
      (out.reasons = out.reasons || []).push(`${h.id}: code error while gathering evidence: ${err.message}`);
      console.error(`[insights] ${brand}/${h.id} evidence error:`, err.message);
      continue;
    }
    if (!evidence) { out.skipped += 1; continue; }   // abstention, before any model call

    const shown = present(evidence);
    try {
      const body = await writeFinding(h, shown);

      const pre = numbersReconcile(body, shown);
      let verified = pre.ok, note = pre.ok ? null : `numbers not in evidence: ${pre.bad.join(', ')}`;
      if (verified) {
        const v = await verifyFinding(body, shown);
        verified = !!v.ok; note = v.ok ? null : (v.reason || 'failed verification');
      }
      if (!verified) out.rejected += 1; else out.written += 1;

      await pool.query(
        `insert into brand_insights (brand, snapshot_ver, hypothesis, body, evidence, verified, verify_note)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (brand, snapshot_ver, hypothesis) do update
           set body = excluded.body, evidence = excluded.evidence,
               verified = excluded.verified, verify_note = excluded.verify_note,
               generated_at = now()`,
        [brand, fp, h.id, body, JSON.stringify(shown), verified, note]);
      if (!verified) (out.reasons = out.reasons || []).push(`${h.id}: ${note}`);
    } catch (err) {
      out.rejected += 1;
      (out.reasons = out.reasons || []).push(`${h.id}: error ${err.message}`);
      console.error(`[insights] ${brand}/${h.id}:`, err.message);
    }
  }
  return out;
}

/** Run for every brand. Called by the warm endpoint after snapshots rebuild. */
async function generateAll(opts = {}) {
  const pool = opts.pool || getPool();
  const { getSnapshot, buildSnapshot, generateAndStore } = require('./snapshot');
  const results = [];
  const brands = opts.brands && opts.brands.length ? opts.brands : S.brands;
  for (const brand of brands) {
    try {
      await getSnapshot(brand, 0, { pool, noPrewarm: true }); // make sure stored data is current
      const fresh = await buildSnapshot(brand, 0, { pool });  // findings need the analytics object
      const fp = fingerprint(fresh.analytics);

      // Only rewrite findings when the creatives they describe have changed,
      // or they are more than a week old. Saves most of the daily writer cost.
      if (!opts.force) {
        const { rows } = await pool.query(
          `select snapshot_ver, max(generated_at) as at from brand_insights where brand = $1 group by snapshot_ver order by at desc limit 1`, [brand]);
        const prev = rows[0];
        const ageDays = prev ? (Date.now() - new Date(prev.at).getTime()) / 86400000 : Infinity;
        if (prev && prev.snapshot_ver === fp && ageDays < MAX_FINDINGS_AGE_DAYS) {
          results.push({ brand, written: 0, skipped: 0, rejected: 0, unchanged: true });
          continue;
        }
      }

      const r = await generateForBrand(brand, fresh, { pool });
      // Findings live inside the stored brand data the chat reads, so rebuild
      // it now, and clear this brand's cached answers, which predate them.
      await generateAndStore(brand, 0, { pool });
      await pool.query('delete from chat_answer_cache where brand = $1', [brand]);
      results.push(r);
    } catch (err) {
      results.push({ brand, error: err.message });
      console.error(`[insights] ${brand}:`, err.message);
    }
  }
  if (!opts.quiet) {
    console.table(results.map(({ reasons, ...r }) => r));
    const why = results.filter((r) => r.reasons && r.reasons.length);
    if (why.length) {
      console.log('\nRejection reasons:');
      why.forEach((r) => r.reasons.forEach((x) => console.log(`  ${r.brand} / ${x}`)));
    }
  }
  return results;
}

module.exports = { generateAll, generateForBrand, HYPOTHESES, numbersReconcile, present, fingerprint };

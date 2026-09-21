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
const S = require('./schema.config');
const { getPool } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Current Sonnet. Same listed price as 4.6. Override with ASK_LENS_WRITER_MODEL.
const WRITER_MODEL = process.env.ASK_LENS_WRITER_MODEL || 'claude-sonnet-5';
const MIN_EVIDENCE = 5;   // never write a finding on fewer creatives than this

/**
 * The hypotheses. Each one pulls its own evidence out of the analytics
 * object. Returning null means "not enough data", and no finding is written.
 * This is where abstention is enforced, before a model ever sees the data.
 */
const HYPOTHESES = [
  {
    id: 'hook_device',
    question: 'Which opening device produces the strongest hook rates, and is the gap real?',
    evidence: (an) => {
      const d = an.dims.hook_device;
      const rep = d.groups.filter((g) => !g.tooFew);
      if (rep.length < 2) return null;
      return { dimension: 'hook_device', spread: d.spread, groups: rep.slice(0, 6), total: rep.reduce((s, g) => s + g.n, 0) };
    },
  },
  {
    id: 'content_intent',
    question: 'Does what the creative is trying to do (educate, entertain, demonstrate) predict how it performs?',
    evidence: (an) => {
      const d = an.dims.content_intent;
      const rep = d.groups.filter((g) => !g.tooFew);
      if (rep.length < 2) return null;
      return { dimension: 'content_intent', spread: d.spread, groups: rep.slice(0, 6) };
    },
  },
  {
    id: 'brandsay_vs_otherssay',
    question: 'Do creator-made (OthersSay) creatives hook or hold differently from brand-made (BrandSay)?',
    evidence: (an) => {
      const rep = an.dims.type.groups.filter((g) => !g.tooFew);
      if (rep.length < 2) return null;
      return { dimension: 'type', groups: rep };
    },
  },
  {
    id: 'spend_quality',
    question: 'Is spend concentrated on the creatives that actually perform?',
    evidence: (an) => {
      const total = an.spendByCqr.Good + an.spendByCqr.Average + an.spendByCqr.Poor;
      if (!total || an.totals.creatives < MIN_EVIDENCE) return null;
      return {
        goodShare: Math.round(an.spendByCqr.Good / total * 100),
        poorShare: Math.round(an.spendByCqr.Poor / total * 100),
        spendByCqr: an.spendByCqr, cqrMix: an.cqrMix,
        wasteCount: an.waste.length, wasteSpend: an.wasteSpend,
      };
    },
  },
  {
    id: 'retention',
    question: 'Where do creatives lose viewers, and is there a common cause?',
    evidence: (an) => {
      if (an.retention.drops.length < MIN_EVIDENCE) return null;
      return {
        n: an.retention.drops.length,
        bySegment: an.retention.dropBySegment,
        byScreen: an.retention.dropByScreen,
        productTiming: an.retention.productTiming,
      };
    },
  },
  {
    id: 'platform_fit',
    question: 'Does the same creative perform differently on Meta and TikTok, and what does that say about the cuts?',
    evidence: (an) => {
      const split = an.anomalies.find((a) => a.kind === 'platform_disagree');
      const groups = an.dims.platform.groups.filter((g) => !g.tooFew);
      if (groups.length < 2) return null;
      return { platforms: groups, disagreeing: split ? split.n : 0, ids: split ? split.ids : [] };
    },
  },
  {
    id: 'creator',
    question: 'Which creators deliver consistently, and which are inconsistent?',
    evidence: (an) => {
      const rep = an.dims.creator.groups.filter((g) => !g.tooFew);
      if (rep.length < 2) return null;
      return { creators: rep.slice(0, 8) };
    },
  },
  {
    id: 'action',
    question: 'What is the single highest-value change the team could make next?',
    evidence: (an) => {
      const topActions = an.top.filter((c) => c.action).slice(0, 5).map((c) => ({ id: c.id, action: c.action, priority: c.priority }));
      const hasSignal = an.discriminating.length || an.anomalies.length || an.waste.length
        || an.validatedUnboosted.length || topActions.length;
      if (!hasSignal || an.totals.creatives < MIN_EVIDENCE) return null;
      return {
        discriminating: an.discriminating.slice(0, 3),
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
      if (k === 'ids' || k === 'tooFew') continue; // internal, never cited
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

const WRITER_PROMPT = `You write findings for a creative performance dashboard used by a media team at WPP working on Unilever Sri Lanka brands.

You are given one analytical question and the computed evidence that answers it. Every number in the evidence was calculated in code and is correct.

Write the finding in at most three sentences.

Rules:
- Use only numbers that appear in the evidence, copied exactly as written there, units included ("13.8M LKR", "56%", "50.1%"). Never calculate, average, round differently, convert or estimate. If you want a number that is not written in the evidence, leave it out.
- Lead with what is true, then why it matters. No preamble.
- Talk about patterns across groups, not individual creatives, unless one creative is the clearest example of the pattern.
- Where the evidence shows a dimension does not separate performance, say so plainly. A null finding is useful.
- Plain, direct wording. No flourishes. No em dashes. No emoji.
- Do not recommend anything the evidence does not support.

Return only the finding text.`;

const VERIFY_PROMPT = `You are checking a finding against the evidence it was written from.

Return ONLY a JSON object: {"ok": true} or {"ok": false, "reason": "<short reason>"}.

Mark it not ok if the finding:
- states any number that does not appear in the evidence
- claims a comparison the evidence does not contain
- recommends something the evidence does not support
- describes a pattern in fewer creatives than the evidence shows

Numbers must match exactly. A finding saying "about 60%" when the evidence says 57 is not ok.`;

/** Pull every number out of a string, for a cheap deterministic pre-check. */
function numbersIn(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/** Deterministic first pass: any number in the text must exist in the evidence. */
function numbersReconcile(body, evidence) {
  const inEvidence = new Set(numbersIn(JSON.stringify(evidence)).map((n) => n.toFixed(1)));
  // Allow small integers, they are almost always counts of things listed.
  const claimed = numbersIn(body).filter((n) => n > 2);
  const bad = claimed.filter((n) => !inEvidence.has(n.toFixed(1)) && !inEvidence.has(Math.round(n).toFixed(1)));
  return { ok: bad.length === 0, bad };
}

async function writeFinding(h, evidence) {
  const res = await client.messages.create({
    model: WRITER_MODEL, max_tokens: 300,
    system: WRITER_PROMPT,
    messages: [{ role: 'user', content: `Question: ${h.question}\n\nEvidence:\n${JSON.stringify(evidence, null, 1)}` }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function verifyFinding(body, evidence) {
  const res = await client.messages.create({
    model: S.model, max_tokens: 150,
    system: VERIFY_PROMPT,
    messages: [{ role: 'user', content: `Finding:\n${body}\n\nEvidence:\n${JSON.stringify(evidence)}` }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { ok: false, reason: 'verifier returned unparseable output' }; }
}

/** Generate and store verified findings for one brand. */
async function generateForBrand(brand, snapshot, opts = {}) {
  const pool = opts.pool || getPool();
  const an = snapshot.analytics;
  const out = { brand, written: 0, skipped: 0, rejected: 0 };

  for (const h of HYPOTHESES) {
    let evidence;
    try { evidence = h.evidence(an); } catch { evidence = null; }
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
        [brand, snapshot.version, h.id, body, JSON.stringify(shown), verified, note]);
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
  const { getSnapshot, buildSnapshot } = require('./snapshot');
  const results = [];
  const brands = opts.brands && opts.brands.length ? opts.brands : S.brands;
  for (const brand of brands) {
    try {
      const stored = await getSnapshot(brand, 0, { pool });
      // Findings need the analytics object, which the stored row does not carry.
      const fresh = await buildSnapshot(brand, 0, { pool });
      if (fresh.version !== stored.version) { results.push({ brand, skipped: 'version moved' }); continue; }
      results.push(await generateForBrand(brand, fresh, { pool }));
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

module.exports = { generateAll, generateForBrand, HYPOTHESES, numbersReconcile, present };

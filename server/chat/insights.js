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
const V = require('./vocab');
const { getPool } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Current Sonnet. Same listed price as 4.6. Override with ASK_LENS_WRITER_MODEL.
const WRITER_MODEL = process.env.ASK_LENS_WRITER_MODEL || 'claude-sonnet-5';
// A finding needs at least 2 creatives to compare. Below 5 it is written as
// an early signal: the writer must say so, and the verifier enforces it.
const MIN_EVIDENCE = 2;

/** A dimension as word comparisons on CQR, hook and hold. No numbers. */
function asWords(d) {
  if (!d || !d.groups) return null;
  const rep = d.groups.filter((g) => !g.tooFew);
  if (rep.length < MIN_EVIDENCE) return null;
  const tag = (x) => (x ? `${x.name}${x.early ? ' (early sign)' : ''}` : null);
  return {
    dimension: d.dimension,
    comparedWith: 'the brand overall',
    groups: rep.slice(0, 8).map((g) => ({
      name: g.name || g.key,
      cqr: g.vs ? g.vs.cqr : 'unknown',
      hook: g.vs ? g.vs.hook : 'unknown',
      hold: g.vs ? g.vs.hold : 'unknown',
      sample: g.early ? 'early sign' : 'solid',
    })),
    leadsOnCqr: tag(d.leaders && d.leaders.cqr),
    bestHook: tag(d.leaders && d.leaders.hook),
    bestHold: tag(d.leaders && d.leaders.hold),
    weakestOnCqr: tag(d.leaders && d.leaders.weakestCqr),
    singleExamplesLeftOut: d.groups.some((g) => g.tooFew),
  };
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
    evidence: (an) => asWords(an.dims.hook_device),
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
- Never claim something is absent, missing or not present unless the evidence explicitly shows it (an empty list, a zero count).
- Describe relationships correctly: more creatives is more, a higher rate is higher. Re-read each comparison before finishing.
- Groups are compared in words: stronger, similar or weaker than the comparison point, on CQR, hook and hold. Write comparisons that way. Never state counts or percentages for groups; none are given.
- CQR matters most, then hook, then hold. Lead with CQR. A stronger hook alone does not make a group better.
- A group marked "early sign" is small. Call it an early sign, never a pattern, trend or rule. "Early signs", "so far" and "worth testing more" fit.
- A single example is never proof that a type of creative works.

Return only the finding text.`;

const VERIFY_PROMPT = `You are checking a finding against the evidence it was written from. Call the verdict tool with your result.

Mark it NOT ok only if the finding:
- states a number that does not appear in the evidence, or a number with the wrong unit
- makes a claim the evidence does not support
- contradicts the evidence, including getting a comparison backwards (calling more "fewer", higher "lower")
- claims something is absent or missing when the evidence does not explicitly show that
- recommends something the evidence gives no basis for
- presents a group marked "early sign" as a pattern, trend or rule rather than an early sign
- treats a single creative as proof that a type works
- reverses a comparison, for example calling a group stronger on hook when the evidence says weaker

Mark it ok otherwise. In particular these are NOT errors:
- leaving out numbers or groups; a finding does not need to mention everything
- choosing to focus on one pattern over another
- reasonable plain-language framing of what the numbers show

Numbers must match the evidence exactly as written, units included.`;

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
  body = String(body).replace(/\b(first\s+)?3\s*(seconds?|s)\b/gi, '');
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
  await pool.query('delete from brand_insights where brand = $1 and snapshot_ver = $2', [brand, snapshot.version]);

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

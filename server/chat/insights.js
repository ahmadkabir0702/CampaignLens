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
const A = require('./analytics');
const MIN_GROUP = A.MIN_GROUP;
const V = require('./vocab');
const num = (v) => (v === null || v === undefined || !isFinite(Number(v)) ? 0 : Number(v));
const { getPool } = require('./db');
const { extrasFor } = require('./router');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Current Sonnet. Same listed price as 4.6. Override with ASK_LENS_WRITER_MODEL.
const WRITER_MODEL = process.env.ASK_LENS_WRITER_MODEL || 'claude-sonnet-5';
// The checker was the weak link on Haiku: it misread amounts and lacked context.
// Findings are only rewritten when creatives change, so Sonnet here is cheap.
const CHECKER_MODEL = process.env.ASK_LENS_CHECKER_MODEL || 'claude-sonnet-5';
// A finding needs at least 2 creatives to compare. Below 5 it is written as
// an early signal: the writer must say so, and the verifier enforces it.
const MIN_EVIDENCE = 2;

/** A dimension as word comparisons on CQR, hook and hold. No numbers. */
function groupSentence(g, leaders) {
  const vs = g.vs || {};
  const cqr = vs.cqrSize ? `CQR ${vs.cqr} (${vs.cqrSize})` : `CQR ${vs.cqr || 'unknown'}`;
  const hook = `hook ${vs.hookMuch ? 'much ' : ''}${vs.hook || 'unknown'}`;
  const hold = `hold ${vs.holdMuch ? 'much ' : ''}${vs.hold || 'unknown'}`;
  // Where it ranks against the OTHER groups. Kept in the same sentence so the
  // two kinds of comparison are never read as contradicting each other.
  const ranks = [];
  // With only two groups, "best" and "weakest" say nothing the head-to-head
  // does not, and reading both on one group looks like a contradiction.
  if (leaders && !leaders.twoOnly) {
    if (leaders.cqr && leaders.cqr.key === g.key) ranks.push('best on CQR among these groups');
    if (leaders.hook && leaders.hook.key === g.key) ranks.push('best hook among these groups');
    if (leaders.hold && leaders.hold.key === g.key) ranks.push('best hold among these groups');
    if (leaders.weakestCqr && leaders.weakestCqr.key === g.key) ranks.push('weakest on CQR among these groups');
  }
  return `${g.name || g.key}: against the brand average, ${cqr}, ${hook}, ${hold}.`
    + (ranks.length ? ` Ranking against the other groups: ${ranks.join('; ')}.` : '')
    + (g.early ? ' Early sign, small group.' : '');
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
    groups: rep.slice(0, 8).map((g) => groupSentence(g, d.leaders)),
    howToRead: 'Two different comparisons. "Against the brand average" compares each group with the brand overall. "Ranking against the other groups" compares the groups with each other. A group can be the best among these groups and still only similar to the brand average; that is not a contradiction.',
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


// ---------------------------------------------------------------
// Candidates: what the cards are about. Chosen and ranked in code.
// ---------------------------------------------------------------

/** Name and tags of a creative, in words, for the writer. No numbers. */
function describe(an, id, role) {
  const c = (an.ranked || []).find((x) => x.id === id);
  if (!c) return null;
  const e = (an.exemplars && [...an.exemplars.best, ...an.exemplars.weakest].find((x) => x.id === id)) || null;
  const line = `${c.name || c.id}: CQR ${c.cqr}, hook ${c.hook_q || 'unrated'}, hold ${c.hold_q || 'unrated'}${e && e.tags ? `. Tags: ${e.tags}` : ''}${c.hook ? `. What it is: ${String(c.hook).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
  return role ? `[${role}] ${line}` : line;
}

function buildCandidates(an) {
  const out = [];
  const total = an.spendByCqr.Good + an.spendByCqr.Average + an.spendByCqr.Poor + (an.spendByCqr.Invalid || 0);

  // 1. The creative elements that make the most difference.
  for (const e of (an.elements || []).slice(0, 6)) {
    out.push({
      id: `element:${e.key}`, kind: 'element', impact: e.impact, early: e.early,
      question: `Does "${e.label}" make a difference to how creatives perform?`,
      guide: 'Headline: what this element does for CQR, then hook or hold, in plain words. Why: the likely reason, concretely, using the examples. Test: one specific change to try on named creatives.',
      evidence: {
        element: e.label, judged: e.timing === 'opening' ? 'in the first 3 seconds' : 'across the whole video',
        finding: A.elementSentence(e).replace(/\s*\[[^\]]+\]/, ''),
        direction: e.helps ? 'creatives with it do better' : 'creatives with it do worse',
        examplesWithTheElement: e.examples.showing.map((id) => describe(an, id, e.helps ? 'has the element, one of the stronger ones' : 'has the element, one of the weaker ones')).filter(Boolean),
        comparisonWithoutTheElement: e.examples.contrast.map((id) => describe(an, id, 'does NOT have the element')).filter(Boolean),
        howToUseTheExamples: 'Describe an example only from the words given here. Do not say what happens on screen beyond its description, and do not restate its ratings wrongly. If an example does not fit the point you are making, leave it out.',
      },
      proof: [`element:${e.key}`], examples: [...e.examples.showing, ...e.examples.contrast],
    });
  }

  // 1b. Organic, kept separate from paid: different reach, different rules.
  for (const e of (an.organicElements || []).slice(0, 3)) {
    out.push({
      id: `element:${e.key}`, kind: 'organic_element', impact: e.impact * 0.8, early: e.early,
      question: `In organic posts, does "${e.label}" make a difference?`,
      guide: 'Headline: what this element does for organic, CQR first. Why: the likely reason, and say plainly that this is organic, where reach comes from the algorithm rather than spend. Test: one specific thing to try in the next organic posts.',
      evidence: {
        channel: 'organic posts only, not paid',
        element: e.label, judged: e.timing === 'opening' ? 'in the first 3 seconds' : 'across the whole post',
        finding: A.elementSentence(e).replace(/\s*\[[^\]]+\]/, ''),
        direction: e.helps ? 'posts with it do better' : 'posts with it do worse',
        examplesWithTheElement: e.examples.showing.map((id) => describe(an, id, e.helps ? 'has the element, one of the stronger ones' : 'has the element, one of the weaker ones')).filter(Boolean),
        howToUseTheExamples: 'Describe an example only from the words given here. Do not say what happens on screen beyond its description, and do not restate its ratings wrongly.',
      },
      proof: [`element:${e.key}`], examples: e.examples.showing,
    });
  }

  // 1c. Organic posts worth putting money behind.
  const unboosted = an.validatedUnboosted || [];
  if (unboosted.length) {
    const good = unboosted.filter((b) => b.best_cqr === 'Good');
    out.push({
      id: 'boost', kind: 'boost', early: false, impact: 0.25 + Math.min(unboosted.length, 10) / 40,
      question: 'Which organic posts have earned a boost and have not had one?',
      guide: 'Headline: how many validated organic posts are waiting, and that the strongest are worth boosting. Why: organic performance is the cheapest signal of what paid will do. Test: name the ones to boost first.',
      evidence: {
        validatedButNotBoosted: unboosted.length,
        ratedGoodAmongThem: good.length,
        posts: unboosted.slice(0, 6).map((b) => `${b.id}: organic CQR ${b.best_cqr || 'unrated'}`),
      },
      proof: [], examples: (good.length ? good : unboosted).slice(0, 3).map((b) => b.id),
    });
  }

  // 2. Where the budget goes.
  if (total && an.totals.creatives >= MIN_EVIDENCE) {
    const poorRun = an.poorSplit.activeSpend || 0;
    out.push({
      id: 'spend', kind: 'spend', early: false,
      impact: (an.spendByCqr.Poor / total) + 2 * (poorRun / total),
      question: 'Is the budget going to the creatives that perform?',
      guide: 'Headline: which tier gets the most spend (mostSpendGoesTo, exactly as given) and whether that is healthy. Why: what it means. Test: the specific move, such as pausing the Poor creatives still running.',
      evidence: {
        mostSpendGoesTo: ['Good', 'Average', 'Poor'].sort((a, b) => an.spendByCqr[b] - an.spendByCqr[a])[0] + ' creatives',
        goodShare: Math.round(an.spendByCqr.Good / total * 100),
        averageShare: Math.round(an.spendByCqr.Average / total * 100),
        poorShare: Math.round(an.spendByCqr.Poor / total * 100),
        poorStillRunning: { count: an.poorSplit.activeCount, spend: an.poorSplit.activeSpend },
        poorAlreadyStopped: { count: an.poorSplit.stoppedCount, spend: an.poorSplit.stoppedSpend },
      },
      proof: [], examples: (an.waste || []).slice(0, 3).map((c) => c.id),
    });
  }

  // 3. Meta against TikTok, worked out head-to-head in code.
  const plat = asWords(an.dims.platform);
  if (plat && plat.headToHead) {
    const g = an.dims.platform.groups.filter((x) => !x.tooFew);
    const gap = g.length === 2 ? Math.abs(num(g[0].goodShare) - num(g[1].goodShare)) / 100 : 0;
    out.push({
      id: 'platform', kind: 'platform', early: g.some((x) => x.early), impact: gap * 0.8,
      question: 'How do Meta and TikTok compare, and what does that mean for the cuts?',
      guide: 'Headline: the head-to-head in plain words, CQR first. Why: what the split likely means for how the cuts are built. Test: one specific change per platform.',
      evidence: { headToHead: plat.headToHead, groups: plat.groups, someCreativesRatedDifferentlyByPlatform: an.anomalies.some((a) => a.kind === 'platform_disagree') },
      proof: g.map((x) => `cohort:platform:${x.key}`), examples: [],
    });
  }

  // 4. Where creatives lose people.
  const h = an.hookHold;
  if (h && h.mostlyLose && h.rated >= MIN_EVIDENCE) {
    out.push({
      id: 'hook_hold', kind: 'hook_hold', early: h.rated < MIN_GROUP, impact: 0.12,
      question: 'Do creatives mostly lose people at the opening or in the body?',
      guide: 'Headline: where most creatives lose people. Why: what that usually means. Test: fix the openings, or tighten the middle, on named creatives if possible.',
      evidence: { whereViewersAreLost: h.mostlyLose, manyAreWeakOnBothHookAndHold: h.manyWeakOnBoth },
      proof: [], examples: [],
    });
  }
  return out.sort((a, b) => b.impact - a.impact);
}

// ---------------------------------------------------------------
// Writer and checker
// ---------------------------------------------------------------

const WRITER_PROMPT = `You write insight cards for a creative performance dashboard used by a media team at WPP working on Unilever Sri Lanka brands. Write like a sharp creative strategist, not a report generator.

You get one question and evidence computed from the brand's data. The evidence is correct. Call the insight_card tool with:
- headline: the insight in one plain sentence, at most 16 words. Lead with what matters for CQR.
- why: one or two sentences on the likely reason. Be concrete about what happens on screen, using the example creatives when given. Frame it as likely ("usually", "a common reason is"), never as proven.
- test: one specific, testable next step for this brand, naming creatives when examples are given.

The dashboard shows the numbers and the example creatives next to your card, so do not repeat numbers.

Rules:
- No digits at all, except durations in seconds. Comparisons stay in words.
- CQR matters most, then hook, then hold. A stronger hook alone does not make something better.
- Something marked "Early sign" is small: say "early sign" or "so far" in the headline or why, and keep that caution in the test ("worth testing to confirm").
- A caution about one campaign must be mentioned: it may be the campaign, not the element.
- Where evidence gives a head-to-head, or says which tier gets the most spend, use it exactly.
- Describe comparisons in the right direction. Re-read each one before finishing.
- Example creatives come with a role in square brackets and a short description. Use them only as their role says, and describe them only in the words given. Never invent what happens on screen, and never state a rating that differs from the one given. If an example does not support your point, do not mention it.
- Plain, direct wording. No em dashes, no emoji, no markdown symbols.

${PLAYBOOK}`;

const CARD_TOOL = {
  name: 'insight_card',
  description: 'The insight card.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      why: { type: 'string' },
      test: { type: 'string' },
    },
    required: ['headline', 'why', 'test'],
  },
};

const REVIEW_PROMPT = `You check an insight card against the evidence it was written from, before a media team sees it. Call the review tool.

Be strict on facts and flexible on wording. Choose one outcome:

pass: every fact is right. Wording choices are the writer's.

fix: ONLY for wording. Every claim is already true, but a phrase is too strong or too weak, or a caution is missing. Allowed fixes: changing a strength word ("a wide margin" to "clearly", "proves" to "suggests"), adding a missing "early sign" or one-campaign caution, or deleting a clause the evidence does not support. Return corrected text for ONLY the fields that need it (fixed_headline, fixed_why, fixed_test), changing as little as possible, with no digits.

reject: any wrong fact, even if you could rewrite it. That includes: a comparison in the wrong direction; saying a metric is weaker, stronger or similar when the evidence says otherwise; the wrong metric (claiming hold improves when only CQR does); describing an example creative wrongly (its ratings, its tags, what it shows); the wrong group or creative named as best or weakest; a number not in the evidence; an early sign presented as an established pattern. Rejected cards go back to the writer with your reason, so be specific.

If in doubt between fix and reject, reject. Your fixes are published without anyone else checking them, so only fix what you are certain is a wording change.

Always give a one-sentence reason, even for pass.

What the terms mean:
- Brand Say is brand-made content. Others Say is creator or influencer-made content.
- CQR is the creative quality rating; Good, Average and Poor are its tiers.
- "Against the brand average" and "ranking against the other groups" are two different comparisons. A group can rank best and still be similar to the average: not a contradiction.
- Where the evidence states which tier gets the most spend, or gives a head-to-head, that statement is authoritative.
- "Why" is interpretation drawing on general creative principles. It is fine as long as it is framed as likely and does not contradict the evidence.
- Being more cautious than required is not an error.`;

const REVIEW_TOOL = {
  name: 'review',
  description: 'Your review of the card.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['pass', 'fix', 'reject'] },
      reason: { type: 'string', description: 'One sentence. For fix or reject, name the exact problem.' },
      fixed_headline: { type: 'string' },
      fixed_why: { type: 'string' },
      fixed_test: { type: 'string' },
    },
    required: ['outcome', 'reason'],
  },
};

const cardText = (c) => [c.headline, c.why, c.test].filter(Boolean).join(' ');
const blank = (c) => !c || !String(c.headline || '').trim() || !String(c.why || '').trim();

async function writeCard(cand, evidence, revision) {
  let content = `Question: ${cand.question}\n\nWhat a good card covers: ${cand.guide}\n\nEvidence:\n${JSON.stringify(evidence, null, 1)}`;
  if (revision) content += `\n\nYour previous card was rejected by a fact checker.\nCard: ${JSON.stringify(revision.card)}\nReason: ${revision.reason}\nWrite a corrected card that fixes exactly that problem.`;
  const res = await client.messages.create({
    ...extrasFor(WRITER_MODEL),
    model: WRITER_MODEL, max_tokens: 1200,
    system: [{ type: 'text', text: WRITER_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [CARD_TOOL], tool_choice: { type: 'tool', name: 'insight_card' },
    messages: [{ role: 'user', content }],
  });
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'insight_card');
  return call ? { headline: String(call.input.headline || '').trim(), why: String(call.input.why || '').trim(), test: String(call.input.test || '').trim() } : null;
}

async function reviewCard(card, evidence) {
  const res = await client.messages.create({
    ...extrasFor(CHECKER_MODEL),
    model: CHECKER_MODEL, max_tokens: 800,
    system: REVIEW_PROMPT,
    tools: [REVIEW_TOOL], tool_choice: { type: 'tool', name: 'review' },
    messages: [{ role: 'user', content: `Card:\n${JSON.stringify(card)}\n\nEvidence:\n${JSON.stringify(evidence)}` }],
  });
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'review');
  if (!call || !['pass', 'fix', 'reject'].includes(call.input.outcome)) return { outcome: 'reject', reason: 'the checker gave no verdict' };
  return call.input;
}

/** One card through the checks: number check, then review; one retry if rejected. */
async function produceCard(cand, shown) {
  const judge = async (card) => {
    if (blank(card)) return { outcome: 'reject', reason: 'the draft came back empty' };
    const pre = numbersReconcile(cardText(card), shown);
    if (!pre.ok) return { outcome: 'reject', reason: `it states numbers that are not in the evidence: ${pre.bad.join(', ')}` };
    const r = await reviewCard(card, shown);
    if (r.outcome !== 'fix') return r;
    const fixed = { headline: r.fixed_headline || card.headline, why: r.fixed_why || card.why, test: r.fixed_test || card.test };
    const again = numbersReconcile(cardText(fixed), shown);
    if (!again.ok) return { outcome: 'reject', reason: `the checker's own fix added numbers: ${again.bad.join(', ')}` };
    // A fix is an unsupervised rewrite unless it is checked too. Review the
    // fixed card fresh, and keep it only if it passes outright.
    const second = await reviewCard(fixed, shown);
    if (second.outcome === 'pass') return { outcome: 'fix', reason: r.reason, card: fixed };
    return { outcome: 'reject', reason: `${r.reason}; the corrected version did not pass a second check: ${second.reason}` };
  };

  let card = await writeCard(cand, shown);
  let r = await judge(card);
  let revised = false;
  if (r.outcome === 'reject') {
    const retry = await writeCard(cand, shown, { card, reason: r.reason });
    const r2 = await judge(retry);
    revised = true;
    if (r2.outcome !== 'reject') { card = retry; r = r2; }
    else r = { outcome: 'reject', reason: `${r.reason} (after one revision: ${r2.reason})` };
  }
  if (r.outcome === 'fix') card = r.card;
  return { card, status: r.outcome === 'pass' ? 'pass' : r.outcome === 'fix' ? 'fixed' : 'rejected', reason: r.reason, revised };
}

/** Write and store a brand's insight cards. */
async function generateForBrand(brand, snapshot, opts = {}) {
  const pool = opts.pool || getPool();
  const an = snapshot.analytics;
  const fp = fingerprint(an);
  const out = { brand, written: 0, fixed: 0, rejected: 0, revised: 0 };
  const cands = buildCandidates(an);
  out.cards = cands.length;

  const results = [];
  for (const cand of cands) {
    const shown = present(cand.evidence);
    try {
      const r = await produceCard(cand, shown);
      if (r.revised) out.revised += 1;
      if (r.status === 'rejected') { out.rejected += 1; (out.reasons = out.reasons || []).push(`${cand.id}: ${r.reason}`); }
      else { out.written += 1; if (r.status === 'fixed') out.fixed += 1; }
      results.push({ cand, shown, ...r });
    } catch (err) {
      out.rejected += 1;
      (out.reasons = out.reasons || []).push(`${cand.id}: error ${err.message}`);
      console.error(`[insights] ${brand}/${cand.id}:`, err.message);
    }
  }

  // Rank the passing cards by impact; the first three are the headline insights.
  let rank = 0;
  for (const r of results.sort((a, b) => b.cand.impact - a.cand.impact)) {
    if (r.status !== 'rejected') rank += 1;
    r.rank = r.status === 'rejected' ? null : rank;
  }

  await pool.query('delete from brand_insights where brand = $1', [brand]);
  for (const r of results) {
    const card = r.card ? { ...r.card, kind: r.cand.kind, proof: r.cand.proof, examples: r.cand.examples, early: !!r.cand.early, rank: r.rank, top: r.rank !== null && r.rank <= 3 } : null;
    await pool.query(
      `insert into brand_insights (brand, snapshot_ver, hypothesis, body, evidence, verified, verify_note, card, impact, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (brand, snapshot_ver, hypothesis) do update
         set body = excluded.body, evidence = excluded.evidence, verified = excluded.verified,
             verify_note = excluded.verify_note, card = excluded.card, impact = excluded.impact,
             status = excluded.status, generated_at = now()`,
      [brand, fp, r.cand.id, card ? cardText(card) : '', JSON.stringify(r.shown), r.status !== 'rejected',
       r.reason || null, card ? JSON.stringify(card) : null, r.cand.impact, r.status]);
  }
  return out;
}

/** Rejected cards, for the admin review list. */
async function reviewList(opts = {}) {
  const pool = opts.pool || getPool();
  const { rows } = await pool.query(
    `select brand, hypothesis, card, verify_note, generated_at from brand_insights
     where status = 'rejected' and generated_at > now() - interval '30 days'
     order by generated_at desc limit 100`);
  return rows;
}

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
    // the element tags: re-tagging a creative changes what the cards say
    c.opens_with_face, c.opens_with_product, c.logo_first_3s, c.captions, c.voiceover, c.music, c.cta,
    c.language, c.talent, c.production_style, c.aspect_ratio,
    // each platform's own status and rating: stopping on one platform matters
    Object.entries(c.per_platform || {}).map(([k, v]) => `${k}${v.is_active ? 1 : 0}${v.cqr || ''}`).sort().join(',')].join(':')).sort();
  return crypto.createHash('sha256').update(rows.join('|')).digest('hex').slice(0, 16);
}

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

module.exports = { generateAll, generateForBrand, buildCandidates, produceCard, reviewList, numbersReconcile, present, fingerprint };

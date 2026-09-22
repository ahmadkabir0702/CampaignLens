/**
 * Ask Lens - model routing
 *
 * Quick lookups ("which is best", "how much") go to Haiku: fast and cheap.
 * Analytical questions ("why", "what works", "what should we do") go to
 * Sonnet, which reasons better and writes the three-part answer properly.
 *
 * The decision is a keyword check, not a model call, so it is free and
 * instant. When in doubt it leans analytical: a lookup answered by Sonnet
 * costs a little more; an analysis answered badly costs trust.
 */

const S = require('./schema.config');

const ANALYTICAL = [
  /\bwhy\b/i, /\bhow come\b/i, /\bexplain/i, /\breason/i,
  /\bwhat (works|is working|worked|doesn'?t work|isn'?t working|should|would|could)\b/i,
  /\bwhat kind\b/i, /\bwhat type/i, /\bwhich (type|kind|style)/i,
  /\brecommend/i, /\bsuggest/i, /\badvice\b/i, /\bideas?\b/i,
  /\bshould (we|i)\b/i, /\bnext\b/i, /\bimprove/i, /\boptimi[sz]/i, /\bfix\b/i,
  /\bcompare/i, /\bcomparison\b/i, /\bvs\.?\b/i, /\bversus\b/i, /\bdifference\b/i,
  /\binsight/i, /\banaly[sz]/i, /\bpattern/i, /\bstrateg/i, /\bplan\b/i, /\btest\b/i,
  /\bwhat('?s| is) (driving|behind|causing)/i, /\bin common\b/i, /\bdoing well\b/i, /\bunderperform/i,
];

function isAnalytical(question) {
  const q = String(question || '');
  return ANALYTICAL.some((re) => re.test(q));
}

function modelFor(question) {
  return isAnalytical(question)
    ? { model: S.analysisModel, maxTokens: S.analysisMaxTokens, mode: 'analysis' }
    : { model: S.model, maxTokens: S.maxTokens, mode: 'lookup' };
}

module.exports = { isAnalytical, modelFor };

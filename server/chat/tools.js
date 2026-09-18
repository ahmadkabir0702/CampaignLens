/**
 * Ask Lens - tool definitions
 *
 * Five tools, every one returning a compact aggregate. Hard rule
 * enforced in toolHandlers.js: no result exceeds ~400 tokens. If an
 * answer needs more data than that, it needs an aggregate, not a list.
 *
 * Descriptions are deliberately short. They live in the cached prefix,
 * but every token here is read on every request.
 */

const S = require('./schema.config');

const METRIC_ENUM = S.rankableMetrics;

const tools = [
  {
    name: 'rank_creatives',
    description:
      'Rank the brand\'s creatives by one metric, with optional filters. Use only when the snapshot\'s top and bottom lists do not cover the question, for example a different metric, a platform filter, a format filter, or a rank position beyond the top five. Returns IDs and the ranked metric only.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRIC_ENUM, description: 'Metric to rank by.' },
        direction: {
          type: 'string', enum: ['best', 'worst'], default: 'best',
          description: 'best accounts for metrics where lower is better, such as CPM and CPC.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        platform: { type: 'string', enum: S.platforms },
        format: { type: 'string', description: 'Creative format, as classified in the data.' },
        origin: { type: 'string', enum: ['original', 'repurposed'] },
        range_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Defaults to the selected range.' },
      },
      required: ['metric'],
    },
  },

  {
    name: 'get_creative',
    description:
      'Full metrics for one creative over the selected period. Use when the user asks about a specific creative in detail and the snapshot line is not enough.',
    input_schema: {
      type: 'object',
      properties: {
        creative_id: { type: 'string' },
        range_days: { type: 'integer', minimum: 1, maximum: 365 },
      },
      required: ['creative_id'],
    },
  },

  {
    name: 'get_series',
    description:
      'Time series for one metric, at brand level or for one creative. Use for questions about trends, when something changed, or spikes and drops. Returns chart-ready arrays. Reference the result with [[chart:line|METRIC|series]].',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRIC_ENUM },
        granularity: { type: 'string', enum: ['day', 'week'], default: 'day' },
        range_days: { type: 'integer', minimum: 2, maximum: 180 },
        platform: { type: 'string', enum: S.platforms },
        creative_id: { type: 'string', description: 'Omit for brand level.' },
      },
      required: ['metric'],
    },
  },

  {
    name: 'compare_creatives',
    description:
      'Side-by-side metrics for two to four creatives. Use when the user asks to compare named creatives, or to compare an original against its repurposed version.',
    input_schema: {
      type: 'object',
      properties: {
        creative_ids: {
          type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4,
        },
        metrics: {
          type: 'array', items: { type: 'string', enum: METRIC_ENUM },
          description: 'Defaults to ctr, engagement_rate, impressions, spend.',
        },
        range_days: { type: 'integer', minimum: 1, maximum: 365 },
      },
      required: ['creative_ids'],
    },
  },

  {
    name: 'get_lineage',
    description:
      'The original and repurposed relatives of one creative, with each one\'s headline metrics. Use for questions about repurposing performance on a specific asset.',
    input_schema: {
      type: 'object',
      properties: {
        creative_id: { type: 'string' },
        range_days: { type: 'integer', minimum: 1, maximum: 365 },
      },
      required: ['creative_id'],
    },
  },
];

/**
 * Anthropic caches the tools block when the last tool carries
 * cache_control. Returned as a fresh array so callers cannot mutate
 * the module-level definitions.
 */
function buildTools() {
  const copy = tools.map((t) => ({ ...t }));
  copy[copy.length - 1] = {
    ...copy[copy.length - 1],
    cache_control: { type: 'ephemeral' },
  };
  return copy;
}

module.exports = { tools, buildTools, METRIC_ENUM };

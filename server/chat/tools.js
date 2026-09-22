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
      'Rank boosted creatives. Default metric is cqr, which ranks CQR then hook rate then hold rate. Use only when the snapshot lists do not cover the question: a different metric, a platform, type, format or CQR filter, or a rank beyond the top five.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRIC_ENUM, default: 'cqr', description: 'cqr is the default and means CQR then hook then hold.' },
        direction: { type: 'string', enum: ['best', 'worst'], default: 'best' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        platform: { type: 'string', enum: S.platforms },
        type: { type: 'string', description: 'Creative type, e.g. BrandSay or OthersSay.' },
        format: { type: 'string', description: 'Creative format as classified in the data.' },
        origin: { type: 'string', enum: ['original', 'repurposed'] },
        cqr: { type: 'string', enum: ['Good', 'Average', 'Poor'], description: 'Only creatives with this CQR.' },
        campaign: { type: 'string', description: 'Campaign name, partial match.' },
        content_intent: {
          type: 'string',
          enum: ['educate','entertain','demonstrate','prove','announce','inspire','promote_offer'],
          description: 'Purpose code. educate=Teaches something, entertain=Entertains, demonstrate=Shows it working, prove=Proves results, announce=Announces news, inspire=Builds emotion, promote_offer=Promotes an offer.',
        },
        narrative_structure: { type: 'string', enum: ['problem_solution','story','tips','demo','montage','testimonial_arc','performance'] },
        hook_device: {
          type: 'string',
          enum: ['question','bold_claim','problem','product_reveal','product_in_use','face_to_camera','dance_performance','everyday_moment','text_overlay','sound','before_after','unexpected_visual'],
          description: 'Opening hook code. Labels: question=Asks a question, bold_claim=Bold claim, problem=Shows a problem, product_reveal=Opens on the product, product_in_use=Product in use, face_to_camera=Talks to camera, dance_performance=Dance or performance, everyday_moment=Everyday moment, text_overlay=Text on screen, sound=Music or sound led, before_after=Before and after, unexpected_visual=Surprising visual.',
        },
        hook_subject: { type: 'string', enum: ['person','product','text','scene'] },
        hook_pace: { type: 'string', enum: ['single_shot','fast_cut'] },
        published_after: { type: 'string', description: 'ISO date. Only creatives published on or after this.' },
        creator: { type: 'string', description: 'Creator name, partial match. Others Say only.' },
        active: { type: 'boolean', description: 'true for running ads only, false for stopped only.' },
      },
      required: [],
    },
  },

  {
    name: 'get_creative',
    description:
      'Everything about one creative: metrics per platform, all its tags, the Insights verdict, and its full second-by-second timeline. Use when someone asks about a specific video, or why it performs as it does.',
    input_schema: {
      type: 'object',
      properties: { creative_id: { type: 'string' } },
      required: ['creative_id'],
    },
  },

  {
    name: 'get_series',
    description:
      'Daily or weekly series for spend, reach, impressions, video_views or clicks. Hook rate, hold rate and CQR have no daily series. Use for trend questions. Reference with [[chart:line|METRIC|series]].',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['spend', 'reach', 'impressions', 'video_views', 'clicks'] },
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
          description: 'Defaults to cqr, hook_rate, hold_rate, reach.',
        },
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
      properties: { creative_id: { type: 'string' } },
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
    cache_control: { type: 'ephemeral', ttl: '1h' },
  };
  return copy;
}

module.exports = { tools, buildTools, METRIC_ENUM };

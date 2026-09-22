/**
 * Ask Lens - creative vocabulary
 *
 * The single source of truth for how every classified value is described to
 * people. The database stores short codes; everything a human reads, in the
 * chat, in findings and on creative cards, uses the label here.
 *
 * To reword something, change the label here. To add or remove a category,
 * the classifier in worker.js and the database constraint must change too.
 */

const VOCAB = {
  hook_device: {
    title: 'Opening hook',
    values: {
      question:          ['Asks a question',       'Poses a question, spoken or on screen'],
      bold_claim:        ['Bold claim',            'Opens with a strong statement or promise'],
      problem:           ['Shows a problem',       'Opens on a pain point the product solves'],
      product_reveal:    ['Opens on the product',  'The pack or product is the first thing you see'],
      product_in_use:    ['Product in use',        'Someone using or applying the product'],
      face_to_camera:    ['Talks to camera',       'A person speaks directly to the viewer'],
      dance_performance: ['Dance or performance',  'Dancing, singing or choreography'],
      everyday_moment:   ['Everyday moment',       'A relatable real-life scene'],
      text_overlay:      ['Text on screen',        'On-screen text does the grabbing'],
      sound:             ['Music or sound led',    'A song, beat or sound effect leads'],
      before_after:      ['Before and after',      'Sets up a contrast or transformation'],
      unexpected_visual: ['Surprising visual',     'Something unexpected or unusual'],
      motion:            ['Movement (old category)', 'Retired; reclassify to replace'],
    },
  },
  content_intent: {
    title: 'Purpose',
    values: {
      educate:       ['Teaches something',  'Educational, tells the viewer something new'],
      entertain:     ['Entertains',         'The point is enjoyment'],
      demonstrate:   ['Shows it working',   'Demonstrates the product'],
      prove:         ['Proves results',     'Evidence, tests, before and after'],
      announce:      ['Announces news',     'A launch, campaign or event'],
      inspire:       ['Builds emotion',     'Aspiration, feeling, identity'],
      promote_offer: ['Promotes an offer',  'A deal, contest or promotion'],
    },
  },
  narrative_structure: {
    title: 'Structure',
    values: {
      problem_solution: ['Problem then solution', 'Sets up a problem, then solves it'],
      story:            ['Tells a story',         'Characters and a narrative'],
      tips:             ['Tips or how-to',        'Steps or advice'],
      demo:             ['Product demo',          'Walks through the product'],
      montage:          ['Montage',               'A string of clips'],
      testimonial_arc:  ['Testimonial or review', 'Someone vouches for it'],
      performance:      ['Performance',           'Dance, song or show'],
    },
  },
  hook_subject: {
    title: 'On screen at the start',
    values: { person: ['Person'], product: ['Product'], text: ['Text'], scene: ['Scene'] },
  },
  hook_pace: {
    title: 'Opening pace',
    values: { single_shot: ['One shot'], fast_cut: ['Quick cuts'] },
  },
  format: {
    title: 'Format',
    values: {
      music_video: ['Music video'], product_demo: ['Product demo'], talking_head: ['Talking head'],
      testimonial: ['Testimonial'], lifestyle: ['Lifestyle'], tutorial: ['Tutorial'],
      ugc: ['UGC'], animation: ['Animation'], other: ['Other'],
    },
  },
  product_role: {
    title: 'Product role',
    values: { hero: ['Hero'], featured: ['Featured'], incidental: ['In the background'], absent: ['Absent'] },
  },
  type: {
    title: 'Made by',
    values: { BrandSay: ['Brand Say'], OthersSay: ['Others Say'] },
  },
  platform: {
    title: 'Platform',
    values: { meta: ['Meta'], tiktok: ['TikTok'], facebook: ['Facebook'], instagram: ['Instagram'] },
  },
  language: {
    title: 'Language',
    values: { sinhala: ['Sinhala'], tamil: ['Tamil'], english: ['English'], mixed: ['Mixed languages'], none: ['No words'] },
  },
  talent: {
    title: "Who's on screen",
    values: { creator: ['A creator'], celebrity: ['A celebrity'], model: ['A model'], everyday_person: ['An everyday person'], none: ['No people'] },
  },
  production_style: {
    title: 'Production style',
    values: { phone_shot: ['Phone-shot'], polished: ['Polished'] },
  },
  aspect_ratio: {
    title: 'Frame shape',
    values: { vertical: ['Vertical'], square: ['Square'], horizontal: ['Horizontal'] },
  },
  length_bucket: {
    title: 'Length',
    values: { short: ['Up to 6 seconds'], medium: ['7 to 15 seconds'], long: ['16 to 30 seconds'], extended: ['Over 30 seconds'] },
  },
  origin: {
    title: 'Original or repurposed',
    values: { original: ['Original'], repurposed: ['Repurposed'] },
  },
};

/** Human label for a stored code. Unknown codes pass through unchanged. */
function label(field, code) {
  if (code === null || code === undefined || code === '') return code;
  const v = VOCAB[field] && VOCAB[field].values[code];
  return v ? v[0] : code;
}

/** Title for a dimension, e.g. hook_device -> "Opening hook". */
function title(field, fallback) {
  return (VOCAB[field] && VOCAB[field].title) || fallback || field;
}

/** Plain labels for everything classified on one creative. */
function creativeLabels(c) {
  const out = {};
  for (const f of ['format', 'hook_device', 'content_intent', 'narrative_structure', 'hook_subject', 'hook_pace', 'product_role', 'type', 'language', 'talent', 'production_style', 'aspect_ratio']) {
    if (c[f]) out[f] = label(f, c[f]);
  }
  return out;
}

/** Codes the classifier may emit. Excludes retired values. */
function activeCodes(field) {
  return Object.keys((VOCAB[field] || { values: {} }).values).filter((k) => k !== 'motion');
}

/**
 * The creative elements the nightly analysis compares, with vs without.
 *
 * Timing decides what each element is judged on, the way the leading
 * creative-analytics tools do it: hook rate only measures the opening, so
 * opening elements are compared on CQR and hook; everything else is compared
 * on CQR and hold. Categorical fields become one element per value.
 */
const ELEMENTS = [
  // In the first 3 seconds
  { field: 'opens_with_face', kind: 'bool', timing: 'opening', label: 'A face in the first 3 seconds' },
  { field: 'opens_with_product', kind: 'bool', timing: 'opening', label: 'The product in the first 3 seconds' },
  { field: 'logo_first_3s', kind: 'bool', timing: 'opening', label: 'The brand or logo in the first 3 seconds' },
  { field: 'hook_device', kind: 'cat', timing: 'opening' },
  { field: 'hook_subject', kind: 'cat', timing: 'opening' },
  { field: 'hook_pace', kind: 'cat', timing: 'opening' },
  // Across the whole video
  { field: 'has_text_overlay', kind: 'bool', timing: 'whole', label: 'On-screen text' },
  { field: 'captions', kind: 'bool', timing: 'whole', label: 'Captions' },
  { field: 'voiceover', kind: 'bool', timing: 'whole', label: 'Someone speaks' },
  { field: 'music', kind: 'bool', timing: 'whole', label: 'Music' },
  { field: 'cta', kind: 'bool', timing: 'whole', label: 'A call to action' },
  { field: 'content_intent', kind: 'cat', timing: 'whole' },
  { field: 'narrative_structure', kind: 'cat', timing: 'whole' },
  { field: 'format', kind: 'cat', timing: 'whole' },
  { field: 'product_role', kind: 'cat', timing: 'whole' },
  { field: 'language', kind: 'cat', timing: 'whole' },
  { field: 'talent', kind: 'cat', timing: 'whole' },
  { field: 'production_style', kind: 'cat', timing: 'whole' },
  { field: 'aspect_ratio', kind: 'cat', timing: 'whole' },
  { field: 'length_bucket', kind: 'cat', timing: 'whole' },
  { field: 'type', kind: 'cat', timing: 'whole' },
];

/** Length bucket from duration, in code. */
function lengthBucket(seconds) {
  const s = Number(seconds);
  if (!isFinite(s) || s <= 0) return null;
  if (s <= 6) return 'short';
  if (s <= 15) return 'medium';
  if (s <= 30) return 'long';
  return 'extended';
}

/** Plain label for an element, e.g. "Opening hook: Talks to camera". */
function elementLabel(el, value) {
  if (el.kind === 'bool') return el.label;
  return `${title(el.field)}: ${label(el.field, value)}`;
}

module.exports = { VOCAB, ELEMENTS, label, title, creativeLabels, activeCodes, lengthBucket, elementLabel };

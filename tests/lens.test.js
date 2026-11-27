/**
 * Sound and Funnel fit (server/lens/score.js) and the ffmpeg guard rails
 * (server/lens/ffmpeg.js). Pure functions plus two tiny generated files, so
 * no database or network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { scoreSound, refreshSound, scoreFunnel, intentOf, kpiScore, SOUND_SHARE, MIX } = require('../server/lens/score');
const lensStore = require('../server/lens/store');
const ffmpeg = require('../server/lens/ffmpeg');

// A loudness series: speech windows at `speechDb`, music windows at `musicDb`.
function series(windows, speechDb, musicDb) {
  const out = [];
  for (let t = 0; t < 16; t += 0.1) {
    const w = windows.find(x => t >= x.t && t < x.t + 2);
    out.push([t, w && (w.audio === 'both' || w.audio === 'speech') ? speechDb : musicDb]);
  }
  return out;
}

const WINDOWS = [0, 2, 4, 6, 8, 10, 12, 14].map(t => ({ t, on_screen: 'person', audio: t % 4 === 0 ? 'both' : 'music', product_visible: t < 6 }));

const strong = {
  voiceover: true, music: true, captions: true, has_text_overlay: true, logo_first_3s: true,
  opens_with_product: true, hook_pace: 'fast_cut', timeline_attrs: WINDOWS, product_screen_pct: 60,
  reasons: ['zero sugar', 'real lime', 'three ingredients'], offer: '', cta: true, cta_text: 'Try it',
  direct_action: false, urgency: false, brand_spoken_first_s: 1, content_intent: 'demonstrate',
};

test('sound: clear voice, right level, brand said early scores green', () => {
  const loud = { integrated: -14, truePeak: -1.5, series: series(WINDOWS, -12, -22) };
  const s = scoreSound({ a: strong, loud, meta: { duration: 15 } });
  assert.strictEqual(s.rag, 'green');
  assert.strictEqual(s.checks.find(c => c.id === 'voice_clear').result, 'pass');
  assert.strictEqual(s.checks.find(c => c.id === 'brand_said').result, 'pass');
});

test('sound: voice buried under loud music fails the voice check', () => {
  const loud = { integrated: -13, truePeak: -3, series: series(WINDOWS, -13, -13.2) };
  const s = scoreSound({ a: strong, loud, meta: { duration: 15 } });
  const v = s.checks.find(c => c.id === 'voice_clear');
  assert.strictEqual(v.result, 'fail');
  assert.ok(v.fix.length > 0);
});

test('sound: too loud and clipping is flagged', () => {
  const loud = { integrated: -8, truePeak: 0.5, series: series(WINDOWS, -6, -16) };
  const s = scoreSound({ a: strong, loud, meta: { duration: 15 } });
  assert.strictEqual(s.checks.find(c => c.id === 'loudness').result, 'fail');
  assert.strictEqual(s.checks.find(c => c.id === 'peak').result, 'fail');
});

test('sound: a silent video and a static have no sound score', () => {
  assert.strictEqual(scoreSound({ a: strong, loud: null, meta: {} }).score, null);
  assert.strictEqual(scoreSound({ a: strong, loud: null, meta: { isStatic: true } }), null);
});

test('sound: the Pre-test Score sound-off check wins over the analysis', () => {
  const loud = { integrated: -14, truePeak: -2, series: series(WINDOWS, -12, -22) };
  const bs = { kpis: [{ id: 'idealAudioSetting', rating: 'negative' }] };
  const s = scoreSound({ a: strong, loud, bs, meta: { duration: 15 } });
  assert.strictEqual(s.checks.find(c => c.id === 'sound_off').result, 'fail');
});

// ── Objective scores: the Pre-test Score weighted for each objective ─────────
// The categories from the pre-test in the review screenshot (TikTok, total 64).
const cats = (o = {}) => [
  { name: 'Attention', score: o.attention ?? 50 }, { name: 'Branding', score: o.branding ?? 75 },
  { name: 'Additional Metrics', score: 33, unweighted: true }, { name: 'Processing Ease', score: o.processing ?? 70 },
  { name: 'Strategic Fit', score: 50, unweighted: true }, { name: 'Emotional Engagement', score: o.emotion ?? 67 },
  { name: 'Persuasion', score: o.persuasion ?? 100, unweighted: true }];
const bsOf = (o = {}, kpis = []) => ({ total: { score: 64 }, categories: cats(o), kpis });
const noAsk = { ...strong, cta: false, direct_action: false, offer: '', urgency: false };

test('objective: every column of weights adds up to 100', () => {
  for (const [k, mix] of Object.entries(MIX)) assert.strictEqual(mix.reduce((t, x) => t + x[1], 0), 100, k);
  assert.strictEqual(SOUND_SHARE, 0.05);
});

test('objective: each score is the Pre-test Score categories weighted for it', () => {
  const f = scoreFunnel({ a: noAsk, bs: bsOf(), sound: { score: 80, checks: [] }, meta: { duration: 15 }, objective: 'Awareness' });
  // 0.35x50 + 0.35x75 + 0.10x70 + 0.15x67 + 0.05x80 = 64.8
  assert.strictEqual(f.stages.Awareness.score, 65);
  // 0.20x50 + 0.10x75 + 0.30x70 + 0.10x67 + 0.25x100 + 0.05x80 = 74.2
  assert.strictEqual(f.stages.Consideration.score, 74);
  // The ask is missed entirely: 0.20x50 + 0.10x75 + 0.15x70 + 0.20x100 + 0.30x0 + 0.05x80 = 52
  assert.strictEqual(f.stages.Conversion.score, 52);
  assert.strictEqual(f.base, 64);
  assert.strictEqual(f.basis, 'full');
  assert.strictEqual(f.soundShare, 5);
  const parts = f.stages.Awareness.parts;
  assert.deepStrictEqual(parts.map(p => p.share), [35, 35, 15, 10, 5]);
  assert.strictEqual(parts.reduce((t, p) => t + p.share, 0), 100);
});

test('objective: the same score in every category gives that score for every objective', () => {
  const even = { attention: 60, branding: 60, processing: 60, emotion: 60, persuasion: 60 };
  const ask = { ...strong, cta: false, direct_action: false, offer: '20% off', urgency: false };
  const f = scoreFunnel({ a: ask, bs: bsOf(even), meta: { duration: 15 } });
  assert.strictEqual(f.stages.Awareness.score, 60);
  assert.strictEqual(f.stages.Consideration.score, 60);
});

test('objective: without the Pre-test Score there is no score, only what it reads as', () => {
  const f = scoreFunnel({ a: strong, sound: { score: 90, checks: [] }, meta: { duration: 15 }, objective: 'Awareness' });
  for (const st of Object.values(f.stages)) { assert.strictEqual(st.score, null); assert.strictEqual(st.word, 'Needs the Pre-test Score'); }
  assert.strictEqual(f.basis, 'none');
  assert.strictEqual(f.soundShare, 0);
  assert.match(f.verdict, /worked out from the Pre-test Score, which is not in yet/);
  assert.strictEqual(lensStore.fitOf(f), null);
  const creative = scoreFunnel({ a: strong, meta: { duration: 15 } });
  assert.strictEqual(creative.intent, 'Consideration');
  assert.match(creative.verdict, /^Reads as a consideration ad .*does not have\.$/);
});

test('objective: the call to action uses the scored check when there is one', () => {
  const kpis = [{ id: 'conceptCallToActionAttention', name: 'CTA attention', category: 'Persuasion', rating: 'positive' }];
  const f = scoreFunnel({ a: noAsk, bs: bsOf({}, kpis), meta: { duration: 15 } });
  const ask = f.stages.Conversion.parts.find(p => p.key === 'ask');
  assert.strictEqual(ask.score, 38);   // CTA passed (3 of 8); direct action, offer and urgency missed
});

test('objective: to fit better names the worst scored check in a weak category', () => {
  const kpis = [{ id: 'engagingBeginning', name: 'Engaging Beginning', category: 'Attention', rating: 'negative', weighted: true },
                { id: 'memorability', name: 'Memorability', category: 'Attention', rating: 'medium', weighted: true }];
  const f = scoreFunnel({ a: noAsk, bs: bsOf({}, kpis), meta: { duration: 15 }, objective: 'Awareness' });
  const gap = f.stages.Awareness.gaps[0];
  assert.strictEqual(gap.name, 'Attention');
  assert.ok(gap.fix && gap.fix.length > 10);
  assert.match(f.verdict, /^A fair fit for awareness\. Biggest gain: /);
  assert.deepStrictEqual(f.stages.Awareness.kpis.sort(), ['engagingBeginning', 'memorability']);
});

test('objective: the chosen objective is the headline, whatever the video reads as', () => {
  // `strong` reads as consideration (three reasons); the person says awareness.
  const f = scoreFunnel({ a: strong, bs: bsOf(), meta: { duration: 15 }, objective: 'Awareness' });
  assert.strictEqual(f.objective, 'Awareness');
  assert.strictEqual(f.focus, 'Awareness');
  assert.strictEqual(f.intent, 'Consideration');
  assert.strictEqual(lensStore.focusOf(f), 'Awareness');
  assert.strictEqual(lensStore.fitOf(f), f.stages.Awareness.score);
  // Anything that is not one of the three is ignored, never trusted.
  assert.strictEqual(scoreFunnel({ a: strong, bs: bsOf(), meta: {}, objective: 'Sales' }).objective, null);
});

test('objective: where another objective is clearly stronger, the verdict says so', () => {
  const f = scoreFunnel({ a: noAsk, bs: bsOf({ attention: 30, branding: 40, persuasion: 95, processing: 90 }), meta: { duration: 15 }, objective: 'Awareness' });
  assert.strictEqual(f.stages.Awareness.rag, 'red');
  assert.match(f.verdict, /works better as a consideration asset \(\d+\)\.$/);
});

test('funnel: an offer with a direct action reads as conversion', () => {
  const a = { ...strong, offer: '20% off this week', direct_action: true, urgency: true, reasons: [], content_intent: 'promote_offer' };
  assert.strictEqual(intentOf(a).intent, 'Conversion');
  assert.strictEqual(intentOf(strong).intent, 'Consideration');
  assert.strictEqual(intentOf({ content_intent: 'inspire', reasons: [] }).intent, 'Awareness');
});

test('sound: the scored sound-off check replaces the analysis once it arrives', () => {
  const loud = { integrated: -14, truePeak: -2, series: series(WINDOWS, -12, -22) };
  const before = scoreSound({ a: strong, loud, meta: { duration: 15 } });
  assert.strictEqual(before.checks.find(c => c.id === 'sound_off').result, 'pass');
  const after = refreshSound(before, { kpis: [{ id: 'idealAudioSetting', rating: 'negative' }] }, strong);
  assert.strictEqual(after.checks.find(c => c.id === 'sound_off').result, 'fail');
  assert.ok(after.score < before.score);
  assert.deepStrictEqual(after.loudness, before.loudness, 'the loudness chart is kept');
  // Nothing scored for it: the same object comes back, so nothing is rewritten.
  assert.strictEqual(refreshSound(before, { kpis: [] }, strong), before);
  assert.strictEqual(refreshSound(null, { kpis: [] }), null);
});

test('funnel: no em dashes in anything a user reads', () => {
  const f = scoreFunnel({ a: strong, meta: { duration: 15 } });
  assert.ok(!/[—–]/.test(JSON.stringify(f)));
  for (const objective of ['Awareness', 'Consideration', 'Conversion']) {
    assert.ok(!/[—–]/.test(JSON.stringify(scoreFunnel({ a: strong, meta: { duration: 15 }, objective }))));
    assert.ok(!/[—–]/.test(JSON.stringify(scoreFunnel({ a: strong, bs: bsOf(), meta: { duration: 15 }, objective }))));
  }
  const s = scoreSound({ a: strong, loud: { integrated: -30, truePeak: 1, series: series(WINDOWS, -20, -21) }, meta: {} });
  assert.ok(!/[—–]/.test(JSON.stringify(s)));
});

test('kpiScore maps ratings', () => {
  const bs = { kpis: [{ id: 'x', rating: 'veryPositive' }, { id: 'y', rating: 'medium' }, { id: 'z', rating: 'notAvailable' }] };
  assert.strictEqual(kpiScore(bs, 'x'), 1);
  assert.strictEqual(kpiScore(bs, 'y'), 0.5);
  assert.strictEqual(kpiScore(bs, 'z'), null);
  assert.strictEqual(kpiScore(null, 'x'), null);
});

// ── ffmpeg guard rails ───────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-test-'));

test('ffmpeg: a real MP4 passes and its loudness is read', async () => {
  const file = path.join(tmp, 'tone.mp4');
  const r = spawnSync(ffmpeg.bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', file]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const info = await ffmpeg.probe(file);
  assert.ok(info.hasVideo && info.hasAudio);
  const loud = await ffmpeg.loudness(file);
  assert.ok(loud.integrated < 0 && loud.series.length > 10);
});

test('ffmpeg: a playlist pointing at another address is refused', async () => {
  const file = path.join(tmp, 'evil.m3u8');
  fs.writeFileSync(file, '#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/latest/meta-data\n');
  await assert.rejects(ffmpeg.probe(file), /Not a supported video file/);
});

test('ffmpeg: an image is not accepted as a video', async () => {
  const file = path.join(tmp, 'still.png');
  const r = spawnSync(ffmpeg.bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', file]);
  assert.strictEqual(r.status, 0);
  await assert.rejects(ffmpeg.probe(file), /Not a supported video file/);
});

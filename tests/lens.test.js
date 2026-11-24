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

const { scoreSound, scoreFunnel, intentOf, kpiScore } = require('../server/lens/score');
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

test('funnel: an offer with a direct action is built for conversion', () => {
  const a = { ...strong, offer: '20% off this week', direct_action: true, urgency: true, reasons: [], content_intent: 'promote_offer' };
  assert.strictEqual(intentOf(a).intent, 'Conversion');
  const f = scoreFunnel({ a, meta: { duration: 8 } });
  assert.strictEqual(f.intent, 'Conversion');
  assert.ok(f.stages.Conversion.score >= 70, `conversion ${f.stages.Conversion.score}`);
  assert.match(f.verdict, /Built for conversion/);
});

test('funnel: reasons to buy read as consideration; nothing reads as awareness', () => {
  assert.strictEqual(intentOf(strong).intent, 'Consideration');
  assert.strictEqual(intentOf({ content_intent: 'inspire', reasons: [] }).intent, 'Awareness');
});

test('funnel: a late brand and no reasons is a weak fit everywhere', () => {
  const a = { voiceover: true, music: true, logo_first_3s: false, opens_with_product: false, hook_pace: 'single_shot',
    timeline_attrs: WINDOWS.map(w => ({ ...w, product_visible: false })), product_screen_pct: 10, reasons: [], offer: '',
    cta: false, direct_action: false, urgency: false, brand_spoken_first_s: -1, content_intent: 'inspire' };
  const f = scoreFunnel({ a, meta: { duration: 15 } });
  for (const st of Object.values(f.stages)) assert.strictEqual(st.rag, 'red');
  assert.match(f.verdict, /not a strong fit/);
});

test('funnel: scored checks replace the analysis and their tips are used', () => {
  const bs = { total: { score: 30 }, kpis: [{ id: 'brandAvailableFirstNSeconds', rating: 'negative' }] };
  const f = scoreFunnel({ a: strong, bs, meta: { duration: 15 } });
  assert.strictEqual(f.basis, 'full');
  const gap = f.stages.Awareness.gaps.find(g => g.name === 'Brand in the first seconds');
  assert.ok(gap && /hotspot/.test(gap.fix), 'uses the Pre-test Score tip');
});

test('funnel: no em dashes in anything a user reads', () => {
  const f = scoreFunnel({ a: strong, meta: { duration: 15 } });
  assert.ok(!/[—–]/.test(JSON.stringify(f)));
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

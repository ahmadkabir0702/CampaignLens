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

const { scoreSound, refreshSound, scoreFunnel, intentOf, kpiScore, SOUND_SHARE } = require('../server/lens/score');
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

// ── Judged on the objective ──────────────────────────────────────────────────
test('objective: the chosen objective is the headline, whatever the video reads as', () => {
  // `strong` reads as consideration (three reasons); the person says awareness.
  const f = scoreFunnel({ a: strong, meta: { duration: 15 }, objective: 'Awareness' });
  assert.strictEqual(f.objective, 'Awareness');
  assert.strictEqual(f.focus, 'Awareness');
  assert.strictEqual(f.intent, 'Consideration');
  assert.match(f.verdict, /fit for awareness\./);
  assert.strictEqual(lensStore.focusOf(f), 'Awareness');
  assert.strictEqual(lensStore.fitOf(f), f.stages.Awareness.score);
});

test('objective: none given falls back to what the video reads as', () => {
  const f = scoreFunnel({ a: strong, meta: { duration: 15 } });
  assert.strictEqual(f.objective, null);
  assert.strictEqual(f.focus, f.intent);
  assert.strictEqual(lensStore.focusOf(f), 'Consideration');
  // Anything that is not one of the three is ignored, never trusted.
  assert.strictEqual(scoreFunnel({ a: strong, meta: {}, objective: 'Sales' }).objective, null);
});

test('objective: a weak fit says what to fix and where it works better', () => {
  // Brand early, short, strong opening, but no reasons, offer or ask.
  const a = { voiceover: false, music: true, logo_first_3s: true, opens_with_product: false, hook_pace: 'fast_cut',
    timeline_attrs: WINDOWS.map(w => ({ ...w, product_visible: false })), product_screen_pct: 5, reasons: [], offer: '',
    cta: false, direct_action: false, urgency: false, content_intent: 'inspire' };
  const f = scoreFunnel({ a, meta: { duration: 10 }, objective: 'Conversion' });
  assert.strictEqual(f.stages.Conversion.rag, 'red');
  assert.match(f.verdict, /^A weak fit for conversion\. Biggest gain: /);
  assert.match(f.verdict, /works better as an awareness asset \(\d+\)\.$/);
});

test('objective: the overall score no longer moves the stage scores', () => {
  const kpis = [{ id: 'brandAvailableFirstNSeconds', rating: 'positive' }];
  const low = scoreFunnel({ a: strong, bs: { total: { score: 5 }, kpis }, meta: { duration: 15 } });
  const high = scoreFunnel({ a: strong, bs: { total: { score: 95 }, kpis }, meta: { duration: 15 } });
  for (const k of Object.keys(low.stages)) assert.strictEqual(low.stages[k].score, high.stages[k].score, k);
});

test('objective: Sound counts for its share of every stage score', () => {
  const quiet = scoreFunnel({ a: strong, meta: { duration: 15 } });
  assert.strictEqual(quiet.soundShare, 0);
  const withSound = s => scoreFunnel({ a: strong, sound: { score: s, checks: [] }, meta: { duration: 15 } });
  const bad = withSound(0), good = withSound(100);
  assert.strictEqual(bad.soundShare, Math.round(SOUND_SHARE * 100));
  for (const k of Object.keys(quiet.stages)) {
    const own = quiet.stages[k].score;
    // `own` is shown rounded, so allow a point either way.
    assert.ok(Math.abs(bad.stages[k].score - (1 - SOUND_SHARE) * own) <= 1, `${k}: silent sound takes its share off`);
    assert.ok(Math.abs(good.stages[k].score - ((1 - SOUND_SHARE) * own + SOUND_SHARE * 100)) <= 1, `${k}: perfect sound adds its share`);
    assert.strictEqual(bad.stages[k].own, own, 'the stage checks themselves are unchanged');
  }
});

test('objective: consideration carries one light branding check, awareness leads with it', () => {
  const bs = { total: { score: 50 }, kpis: [{ id: 'brandAttention', rating: 'negative' }] };
  const f = scoreFunnel({ a: strong, bs, meta: { duration: 15 } });
  const inCons = f.stages.Consideration.checks.find(c => c.kpi === 'brandAttention');
  const inAware = f.stages.Awareness.checks.find(c => c.kpi === 'brandAttention');
  assert.ok(inCons && inCons.weight === 1 && inCons.result === 'fail');
  assert.ok(inAware && inAware.weight === 3);
  // No "brand in the first seconds" in consideration at all.
  assert.ok(!f.stages.Consideration.checks.some(c => c.kpi === 'brandAvailableFirstNSeconds'));
  // A missed light check costs consideration far less than it costs awareness.
  const ok = scoreFunnel({ a: strong, bs: { kpis: [{ id: 'brandAttention', rating: 'positive' }] }, meta: { duration: 15 } });
  const dropCons = ok.stages.Consideration.score - f.stages.Consideration.score;
  const dropAware = ok.stages.Awareness.score - f.stages.Awareness.score;
  assert.ok(dropCons > 0 && dropCons < dropAware, `consideration -${dropCons}, awareness -${dropAware}`);
});

test('objective: every check behind a score is listed, heaviest first', () => {
  const f = scoreFunnel({ a: strong, meta: { duration: 15 }, objective: 'Consideration' });
  const cs = f.stages.Consideration.checks;
  assert.strictEqual(cs.length, f.stages.Consideration.checked);
  assert.strictEqual(cs[0].name, 'Gives reasons to choose it');
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].weight >= cs[i].weight);
  for (const c of cs) assert.ok(['pass', 'partial', 'fail'].includes(c.result));
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

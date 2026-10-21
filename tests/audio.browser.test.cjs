// Audio engine, measured by rendering every cue offline in Chromium. Nothing here is "heard": these tests check
// peak level, silence before and after, finite samples, determinism, and what stopAll / stopGeneration really stop.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {ROOT, getBrowser, closeBrowser, reason} = require('./helpers/browser.cjs');

let page;
async function ready(t) {
  const browser = await getBrowser();
  if (!browser) return t.skip(reason()) || false;
  if (!page) {
    page = await (await browser.newContext()).newPage();
    await page.goto('about:blank');
    await page.addScriptTag({path: path.join(ROOT, 'audio-engine.js')});
    // Offline rendering helper, defined inside the page.
    await page.evaluate(() => {
      window.renderCue = async (name, {seconds = 4, params = {}, enabled = true, volume = 0.7, during} = {}) => {
        const sr = 44100, ctx = new OfflineAudioContext(1, Math.round(sr * seconds), sr);
        const engine = AudioEngine.create({context: ctx, assumeRunning: true, volume, enabled});
        const status = await engine.unlock();
        let voice = null;
        if (during) for (const [at, action] of during) ctx.suspend(at).then(() => {action(engine, voice); ctx.resume();});
        voice = engine.cue(name, {when: 0, gen: 1, duration: 2.9, index: 0, maxSeconds: 3, ...params});
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        let peak = 0, sum = 0, bad = 0, first = -1, last = -1;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (!Number.isFinite(v)) {bad++; continue;}
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sum += v;
          if (a > 1e-4) {if (first < 0) first = i; last = i;}
        }
        const rms = (from, to) => {let s = 0, n = 0; for (let i = Math.max(0, Math.round(from * sr)); i < Math.min(data.length, Math.round(to * sr)); i++) {s += data[i] * data[i]; n++;} return n ? Math.sqrt(s / n) : 0;};
        return {status, hadVoice: !!voice, peak, mean: sum / data.length, bad, firstAt: first < 0 ? null : first / sr, lastAt: last < 0 ? null : last / sr,
          rmsAt: [[0, .1], [.1, .3], [.5, .7], [1, 1.2], [3.5, 3.9]].map(([a, b]) => rms(a, b)), active: engine.active, checksum: data.reduce((h, v, i) => (h + v * (i % 97 + 1)) % 1e6, 0)};
      };
    });
  }
  return true;
}
test.after(async () => {await closeBrowser();});

// Latest time each cue may still be sounding, in seconds. Levels are checked in dBFS below.
const ENDS_BY = {intake: 0.3, tick: 0.2, resolve: 0.8, lock: 1.0, neutral: 0.8, error: 0.6, confirm: 0.5, descend: 3.2};
const dB = v => 20 * Math.log10(v);
for (const [name, lastBy] of Object.entries(ENDS_BY)) {
  test('cue "' + name + '": finite, bounded, silent at the end, no DC offset', async t => {
    if (!await ready(t)) return;
    const r = await page.evaluate(n => renderCue(n, {seconds: 4.2}), name);
    assert.equal(r.status, 'running');
    assert.equal(r.hadVoice, true);
    assert.equal(r.bad, 0, 'every sample is finite');
    assert.ok(dB(r.peak) > -34 && dB(r.peak) < -9, name + ' peak ' + dB(r.peak).toFixed(1) + ' dBFS at the default volume should sit between -34 and -9');
    assert.ok(Math.abs(r.mean) < 0.002, 'no DC offset, mean ' + r.mean);
    assert.ok(r.lastAt !== null && r.lastAt <= lastBy, name + ' ends by ' + lastBy + ' s, last sound at ' + r.lastAt);
    assert.ok(r.firstAt < 0.05, 'starts promptly, first sound at ' + r.firstAt);
    assert.ok(r.rmsAt.at(-1) < 1e-4, 'silent tail');
    console.log('    ' + name.padEnd(8) + 'peak ' + dB(r.peak).toFixed(1) + ' dBFS, ends ' + r.lastAt.toFixed(2) + ' s');
  });
  test('cue "' + name + '" at full volume stays under -5 dBFS', async t => {
    if (!await ready(t)) return;
    const r = await page.evaluate(n => renderCue(n, {seconds: 4.2, volume: 1}), name);
    assert.ok(dB(r.peak) < -5, name + ' full-volume peak ' + dB(r.peak).toFixed(1) + ' dBFS');
  });
}

test('cue "scan" runs until stopped, then fades out cleanly', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(() => renderCue('scan', {seconds: 3, params: {maxSeconds: 12}, during: [[1.0, (e, v) => v.stop(0.1)]]}));
  assert.equal(r.bad, 0);
  assert.ok(r.rmsAt[2] > 1e-3, 'audible while running (rms ' + r.rmsAt[2] + ')');
  assert.ok(r.lastAt < 1.25, 'silent shortly after the stop, last sound at ' + r.lastAt);
  assert.ok(r.peak < 0.5);
});

test('identical renders are identical (the noise source is deterministic)', async t => {
  if (!await ready(t)) return;
  const [a, b] = await page.evaluate(async () => [await renderCue('intake'), await renderCue('intake')]);
  assert.equal(a.checksum, b.checksum);
  assert.equal(a.peak, b.peak);
});

test('stopAll fades every voice and leaves silence; none remain registered', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(() => renderCue('descend', {seconds: 3, during: [[0.5, e => e.stopAll(0.05)]]}));
  assert.ok(r.rmsAt[2] > 1e-4 || r.peak > 0.001, 'was sounding before the stop');
  assert.ok(r.lastAt < 0.7, 'silent by 0.7 s, last sound at ' + r.lastAt);
  assert.equal(r.active, 0, 'no voice left registered');
});

test('stopGeneration stops only the matching generation', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(async () => {
    const sr = 44100, ctx = new OfflineAudioContext(1, sr * 3, sr), e = AudioEngine.create({context: ctx, assumeRunning: true});
    await e.unlock();
    e.cue('scan', {when: 0, gen: 1, maxSeconds: 3});
    e.cue('descend', {when: 0, gen: 2, duration: 2.8});
    ctx.suspend(0.4).then(() => {e.stopGeneration(1, 0.05); ctx.resume();});
    const d = (await ctx.startRendering()).getChannelData(0);
    const rms = (a, b) => {let s = 0, n = 0; for (let i = a * sr | 0; i < b * sr | 0; i++) {s += d[i] * d[i]; n++;} return Math.sqrt(s / n);};
    return {early: rms(0.1, 0.35), later: rms(1.4, 1.8), end: rms(2.95, 3)};
  });
  assert.ok(r.later > 1e-3, 'generation 2 kept playing (' + r.later + ')');
  assert.ok(r.early > 0, 'generation 1 had been playing');
});

test('disabled or muted: no nodes are created and cues return nothing', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(async () => {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    let made = 0;
    for (const m of ['createOscillator', 'createBufferSource', 'createGain']) {const o = ctx[m].bind(ctx); ctx[m] = (...a) => {made++; return o(...a);};}
    const e = AudioEngine.create({context: ctx, assumeRunning: true, enabled: false});
    const status = await e.unlock();
    const voices = ['intake', 'tick', 'lock', 'scan'].map(n => e.cue(n, {when: 0}));
    e.setEnabled(true);
    const created = made;
    e.setEnabled(false);
    return {status, voices, made: created};
  });
  assert.equal(r.status, 'off');
  assert.deepEqual(r.voices, [null, null, null, null]);
  assert.equal(r.made, 0);
});

test('a context that never starts (autoplay blocked) is a quiet no-op, not an error', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(async () => {
    let made = 0;
    const param = () => ({value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}});
    // Complete enough that a cue which wrongly tried to play would build real nodes (and be counted) instead of failing early.
    const node = () => ({connect() {}, disconnect() {}, start() {}, stop() {}, gain: param(), frequency: param(), Q: param(), threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}});
    class Blocked {constructor() {this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {};}
      resume() {return new Promise(() => {});}   // never settles, like a browser waiting for a gesture
      createGain() {return node();} createDynamicsCompressor() {return node();}
      createOscillator() {made++; return node();} createBufferSource() {made++; return node();}}
    const e = AudioEngine.create({AudioContext: Blocked});
    const t0 = performance.now(), status = await e.unlock(), took = performance.now() - t0;
    const voice = e.cue('tick', {when: 0});
    e.stopAll(); e.setVolume(0.5); e.setEnabled(false); e.setEnabled(true);
    return {status, blocked: e.blocked, supported: e.supported, voice, made, took};
  });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blocked, true);
  assert.equal(r.voice, null);
  assert.equal(r.made, 0);
  assert.ok(r.took < 1500, 'unlock gives up promptly instead of hanging (' + Math.round(r.took) + ' ms)');
});

test('an unsupported or throwing AudioContext is reported, never thrown', async t => {
  if (!await ready(t)) return;
  const r = await page.evaluate(async () => {
    const throwing = AudioEngine.create({AudioContext: function () {throw new Error('no audio device');}});
    const s1 = await throwing.unlock(), c1 = throwing.cue('lock', {when: 0});
    const none = AudioEngine.create({AudioContext: null});
    const patched = {A: window.AudioContext, W: window.webkitAudioContext};
    return {s1, c1, supportedAfter: throwing.supported, noneSupported: none.supported || AudioEngine.create({AudioContext: null}).supported};
  });
  assert.equal(r.s1, 'unsupported');
  assert.equal(r.c1, null);
  assert.equal(r.supportedAfter, false);
});

test('volume curve is monotonic, silent at zero and unity at one', async t => {
  if (!await ready(t)) return;
  const g = await page.evaluate(() => [0, 0.1, 0.35, 0.5, 0.75, 1, -3, 7, NaN].map(AudioEngine.volumeToGain));
  assert.equal(g[0], 0);
  assert.equal(g[5], 1);
  assert.ok(g[1] < g[2] && g[2] < g[3] && g[3] < g[4] && g[4] < g[5]);
  assert.ok(Math.abs(g[2] - Math.pow(0.35, 1.6)) < 1e-12);
  assert.equal(g[6], 0); assert.equal(g[7], 1); assert.equal(g[8], 0);
});

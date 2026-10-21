// The app in less friendly environments, in a real browser: sound blocked / muted / missing / throwing, reduced motion,
// remembered settings, no network at all, content-security-policy enforcement, missing bundled street data, a hidden tab,
// and layout at six widths. Everything here must leave the metadata result and the report exactly as correct as usual.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const B = require('./helpers/browser.cjs');

const isLocal = url => /^(file:|blob:|data:|about:)/.test(url);
test.after(async () => {await B.closeBrowser();});

function scenario(name, options, fn) {
  if (typeof options === 'function') {fn = options; options = {};}
  test(name, async t => {
    const browser = await B.getBrowser();
    if (!browser) return t.skip(B.reason());
    const app = await B.openApp(browser, options);
    try {
      await fn(app, t);
      assert.deepEqual(app.problems, [], 'console errors or warnings');
      assert.deepEqual(app.requests.filter(u => !isLocal(u)), [], 'requests outside the local file');
      assert.deepEqual(app.dialogs, [], 'unexpected dialogs');
    } finally {await app.close();}
  });
}

const LAT = 29 + 38 / 60 + 55.87 / 3600, LON = -(82 + 20 / 60 + 16.4 / 3600);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const title = page => B.text(page, 'statusTitle');
const chip = page => page.locator('#soundToggle').evaluate(e => ({state: e.dataset.state, label: e.textContent.trim(), pressed: e.getAttribute('aria-pressed')}));
const reload = async page => {await page.reload(); await page.waitForFunction(() => window.MetaTrace && document.body.dataset.presentation);};
async function beats(page) {
  const steps = (await page.evaluate(() => window.__sequence)).filter(s => s.state !== 'idle');
  const dur = {}; steps.forEach((s, i) => {if (steps[i + 1]) dur[s.state] = steps[i + 1].at - s.at;});
  return {steps, dur, total: steps.at(-1).at - steps[0].at};
}

/* Audio fakes. All are installed before any page script runs. ------------------------------------------------- */
const countNodes = () => {
  const Real = window.AudioContext; window.__nodes = 0; window.__contexts = 0;
  window.AudioContext = class extends Real {
    constructor(...a) {
      super(...a); window.__contexts++;
      for (const m of ['createOscillator', 'createBufferSource']) {const original = this[m].bind(this); this[m] = (...x) => {window.__nodes++; return original(...x);};}
    }
  };
};
const blockedAudio = () => {
  const Real = window.AudioContext; window.__resumes = 0;
  window.AudioContext = class extends Real {
    get state() {return 'suspended';}
    resume() {window.__resumes++; return Promise.resolve();}          // resolves, but the context never runs
  };
};
const missingAudio = () => {delete window.AudioContext; delete window.webkitAudioContext;};
const throwingAudio = () => {
  window.AudioContext = function () {throw new Error('AudioContext is not allowed here');};
  window.webkitAudioContext = window.AudioContext;
};

async function fullFlow(page, name = 'sample-street.jpg') {
  await B.analyze(page, name);
  const s = await B.snapshot(page);
  assert.equal(await title(page), 'GPS coordinates found');
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'exact pin');
  assert.ok(near(s.camera.lat, LAT) && near(s.camera.lng, LON) && s.camera.zoom === 18, 'street-scale finish');
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
  assert.equal(await B.content(page, 'fileHash'), B.sha256(name));
  return s;
}

/* ============================================================ sound ======================================== */

scenario('sound on: cues really play (control for the muted test below)', {motion: 'fast', init: [countNodes]}, async ({page}) => {
  await fullFlow(page);
  assert.ok(await page.evaluate(() => window.__nodes) > 10, 'oscillators and noise sources were created');
  assert.equal(await page.evaluate(() => window.__contexts), 1, 'one shared AudioContext');
  assert.deepEqual(await chip(page), {state: 'on', label: 'Sound on', pressed: 'true'});
});

scenario('muted: no audio node is ever created, and the run is otherwise identical', {motion: 'fast', init: [countNodes]}, async ({page}) => {
  await page.click('#soundToggle');
  assert.deepEqual(await chip(page), {state: 'off', label: 'Sound off', pressed: 'false'});
  await fullFlow(page);
  assert.equal(await page.evaluate(() => window.__nodes), 0, 'no oscillator or buffer source');
  assert.equal(await page.evaluate(() => window.__contexts), 0, 'not even an AudioContext');
  assert.equal((await B.snapshot(page)).audio.voices, 0);
  await page.click('#soundToggle');                                    // turning it back on plays the acknowledgement
  await page.waitForFunction(() => window.__nodes > 0);
  assert.equal((await chip(page)).state, 'on');
});

scenario('muting during a run silences it at once', {motion: 'full', init: [countNodes]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices > 0, null, {timeout: 8000});
  await page.click('#soundToggle');
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 400});
  const created = await page.evaluate(() => window.__nodes);
  await B.waitDone(page, 30000);
  assert.equal(await page.evaluate(() => window.__nodes), created, 'nothing new was started after muting');
  assert.equal((await B.snapshot(page)).pin !== null, true, 'the visual result still completed');
});

scenario('sound blocked by the browser: the run does not wait for it, the chip says so, and one retry turns sound off', {motion: 'fast', init: [blockedAudio]}, async ({page}) => {
  const t0 = Date.now();
  await fullFlow(page);
  const took = Date.now() - t0;
  assert.ok(took < 9000, 'the analysis finished in ' + took + ' ms without waiting for audio');
  assert.deepEqual(await chip(page), {state: 'blocked', label: 'Sound blocked', pressed: 'true'});
  assert.match(await page.locator('#soundToggle').getAttribute('title'), /not allowed audio/);
  assert.equal((await B.snapshot(page)).audio.voices, 0, 'no voice was started on a suspended context');
  assert.ok(await page.evaluate(() => window.__resumes) >= 1);
  await page.click('#soundToggle');                                    // retry from a gesture: still blocked
  await page.waitForFunction(() => document.getElementById('soundToggle').dataset.state === 'off', null, {timeout: 4000});
  assert.match(await B.text(page, 'toast'), /blocking audio.*turned off/);
  assert.deepEqual(await chip(page), {state: 'off', label: 'Sound off', pressed: 'false'});
  await B.analyze(page, 'no-gps.jpg');
  assert.equal(await title(page), 'No location metadata found');
});

scenario('no Web Audio support: a clear label, and everything else works', {motion: 'fast', init: [missingAudio]}, async ({page}) => {
  const c = await chip(page);
  assert.equal(c.state, 'unsupported');
  assert.equal(c.label, 'Sound unavailable');
  await fullFlow(page);
  await B.analyze(page, 'no-gps.jpg');
  assert.equal(await title(page), 'No location metadata found');
  assert.equal((await chip(page)).state, 'unsupported');
});

scenario('an AudioContext that throws on creation is contained, with no error and no retry loop', {motion: 'fast', init: [throwingAudio]}, async ({page}) => {
  await fullFlow(page);
  assert.ok(['unsupported', 'blocked'].includes((await chip(page)).state), 'chip says sound is not working: ' + (await chip(page)).state);
  await B.analyze(page, 'no-gps.jpg');
  assert.equal(await title(page), 'No location metadata found');
});

scenario('volume and sound choice are remembered; the slider reaches the audio engine', async ({page}) => {
  assert.equal(await page.inputValue('#volume'), '70');
  assert.equal((await B.snapshot(page)).audio.volume, 0.7);
  await page.locator('#volume').evaluate(e => {e.value = '25'; e.dispatchEvent(new Event('input', {bubbles: true}));});
  assert.equal((await B.snapshot(page)).audio.volume, 0.25);
  await page.click('#soundToggle');
  await reload(page);
  assert.equal(await page.inputValue('#volume'), '25');
  assert.equal((await B.snapshot(page)).audio.volume, 0.25);
  assert.deepEqual(await chip(page), {state: 'off', label: 'Sound off', pressed: 'false'});
  await page.click('#soundToggle');
  await reload(page);
  assert.equal((await chip(page)).state, 'on');
  await page.locator('#volume').evaluate(e => {e.value = '0'; e.dispatchEvent(new Event('input', {bubbles: true}));});
  assert.equal((await B.snapshot(page)).audio.volume, 0);
});

scenario('unusable storage does not break anything', {init: [() => {
  Object.defineProperty(window, 'localStorage', {get() {throw new DOMException('denied', 'SecurityError');}});
}], motion: undefined}, async ({page}) => {
  await page.locator('#volume').evaluate(e => {e.value = '40'; e.dispatchEvent(new Event('input', {bubbles: true}));});
  await page.selectOption('#motion', 'fast');
  await fullFlow(page);
  assert.equal((await B.snapshot(page)).motion, 'fast');
});

/* ============================================================ motion ======================================= */

scenario('the operating system\'s reduced-motion setting is followed: no flight, no theatrics, quick result', {contextOptions: {reducedMotion: 'reduce'}}, async ({page}) => {
  await page.evaluate(() => {window.__zoom = []; setInterval(() => window.__zoom.push(window.MetaTrace.snapshot().camera.zoom), 20);});
  assert.equal(await page.locator('html').getAttribute('data-motion'), 'reduced');
  assert.equal(await page.inputValue('#motion'), 'reduced');
  assert.equal((await B.snapshot(page)).motion, 'reduced');
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await B.waitDone(page, 8000);
  const {total, dur, steps} = await beats(page);
  assert.ok(total < 1800, 'the whole presentation took ' + Math.round(total) + ' ms');
  assert.ok((dur.fly || 0) < 60, 'no flight beat (' + Math.round(dur.fly || 0) + ' ms)');
  const zooms = await page.evaluate(() => window.__zoom);
  assert.equal(zooms.filter(z => z > 3 && z < 17.9).length, 0, 'the camera never travelled through intermediate zooms');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.camera.lng, LON) && s.camera.zoom === 18);
  assert.equal(await title(page), 'GPS coordinates found');
  assert.equal(await B.content(page, 'longitude'), '-82.33788889');
  assert.deepEqual(steps.map(x => x.state).filter((x, i, a) => a.indexOf(x) === i).includes('settled'), true);
});

scenario('the person can override the system setting, and it is remembered', {contextOptions: {reducedMotion: 'reduce'}}, async ({page}) => {
  await page.selectOption('#motion', 'full');
  assert.equal((await B.snapshot(page)).motion, 'full');
  assert.equal(await page.locator('html').getAttribute('data-motion'), 'full');
  await reload(page);
  assert.equal((await B.snapshot(page)).motion, 'full', 'remembered over the system preference');
  await page.selectOption('#motion', 'reduced');
  await reload(page);
  assert.equal(await page.inputValue('#motion'), 'reduced');
});

scenario('with no preference at all the default is the full cinematic profile', async ({page}) => {
  assert.equal((await B.snapshot(page)).motion, 'full');
  assert.equal(await page.inputValue('#motion'), 'full');
});

scenario('fast motion keeps every beat but compresses them to under three seconds', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const {total, steps} = await beats(page);
  assert.deepEqual(steps.map(s => s.state), ['acquire', 'scan', 'reveal', 'resolve', 'fly', 'lock', 'settled']);
  assert.ok(total > 2000 && total < 3500, 'fast sequence took ' + Math.round(total) + ' ms (plan 2830)');
});

/* ============================================================ network and policy =========================== */

scenario('offline: a complete analysis needs no network and makes none', {motion: 'fast', contextOptions: {offline: true}}, async ({page}) => {
  await fullFlow(page);
  await B.analyze(page, 'no-gps.jpg');
  assert.equal(await title(page), 'No location metadata found');
});

scenario('the content-security-policy blocks network, remote assets, workers from elsewhere and eval', {motion: 'reduced'}, async app => {
  const {page} = app;
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  for (const directive of ["default-src 'none'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src blob:"]) assert.ok(policy.includes(directive), 'policy has ' + directive);
  assert.doesNotMatch(policy, /unsafe-eval|\*|https?:/, 'no wildcard, remote host or eval allowance');
  const outcome = await page.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective.split(' ')[0]));
    const results = {};
    try {await fetch('https://example.com/collect', {method: 'POST', body: 'x'}); results.fetch = 'allowed';} catch (e) {results.fetch = 'blocked';}
    try {const ws = new WebSocket('wss://example.com/socket'); await new Promise(r => {ws.onerror = r; ws.onclose = r; setTimeout(r, 400);}); results.websocket = ws.readyState === 1 ? 'allowed' : 'blocked';} catch (e) {results.websocket = 'blocked';}
    try {navigator.sendBeacon('https://example.com/b', 'x'); results.beacon = 'attempted';} catch (e) {results.beacon = 'blocked';}
    try {new Worker('https://example.com/w.js'); results.worker = 'allowed';} catch (e) {results.worker = 'blocked';}
    try {const w = new Worker('data:text/javascript,postMessage(1)'); await new Promise(r => {w.onerror = r; w.onmessage = r; setTimeout(r, 400);}); results.dataWorker = 'attempted';} catch (e) {results.dataWorker = 'blocked';}
    try {eval('1 + 1'); results.eval = 'allowed';} catch (e) {results.eval = 'blocked';}
    try {new Function('return 1')(); results.fn = 'allowed';} catch (e) {results.fn = 'blocked';}
    await new Promise(resolve => {const img = new Image(); img.onerror = resolve; img.onload = resolve; img.src = 'https://example.com/pixel.png'; setTimeout(resolve, 400);});
    const script = document.createElement('script'); script.src = 'https://example.com/x.js'; document.head.append(script);
    const frame = document.createElement('iframe'); frame.src = 'https://example.com/'; document.body.append(frame);
    await new Promise(r => setTimeout(r, 400));
    return {results, violations};
  });
  assert.deepEqual([outcome.results.fetch, outcome.results.websocket, outcome.results.worker, outcome.results.eval, outcome.results.fn], ['blocked', 'blocked', 'blocked', 'blocked', 'blocked'], JSON.stringify(outcome));
  for (const d of ['connect-src', 'img-src', 'script-src', 'worker-src']) assert.ok(outcome.violations.includes(d), 'a ' + d + ' violation was reported: ' + outcome.violations.join(','));
  assert.ok(outcome.violations.includes('default-src') || outcome.violations.includes('frame-src') || outcome.violations.includes('child-src'), 'the iframe was blocked');
  // The probes above are expected to be reported by the browser; nothing else may be.
  assert.ok(app.problems.every(p => /Content Security Policy|violates|Refused/i.test(p)), 'only policy refusals were logged: ' + app.problems.join(' | '));
  app.problems.length = 0;
  app.requests.splice(0, app.requests.length, ...app.requests.filter(isLocal));   // the refused attempts never left the page
  // The app still works after all that.
  await fullFlow(page);
});

scenario('bundled street data missing: the exact point is shown on the world overview with an honest explanation', {motion: 'fast', init: [() => {
  for (const name of ['TRACE_MAP_DATA', 'TRACE_MAP_META', 'TRACE_MAP_LABELS']) Object.defineProperty(window, name, {configurable: true, get() {return undefined;}, set() {}});
}]}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const s = await B.snapshot(page);
  assert.equal(await title(page), 'GPS coordinates found');
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'the pin is still exact');
  assert.equal(s.camera.zoom, 5, 'it did not fly into a blank maximum zoom');
  assert.equal(s.coverage, 'OFFLINE / OVERVIEW');
  assert.match(await B.content(page, 'coverageNote'), /not bundled|no street/i);
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
});

scenario('a hidden tab finishes the presentation and quietens the sound', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    document.dispatchEvent(new Event('visibilitychange'));              // the event a real tab switch raises
  });
  await B.waitDone(page, 4000);
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 800});
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && s.camera.zoom === 18, 'the result was completed, not lost');
});

/* ============================================================ layout ======================================== */

const WIDTHS = [[1440, 900], [1180, 800], [1024, 768], [768, 1024], [720, 900], [390, 844]];
async function layoutProblems(page, label) {
  return page.evaluate(label => {
    const problems = [];
    const overflow = document.documentElement.scrollWidth - innerWidth;
    if (overflow > 0) problems.push('page scrolls sideways by ' + overflow + ' px');
    // Always on screen: these must have a size. The rest only exist visually once there is a file or a result.
    const always = ['analyze', 'skip', 'changeImage', 'replay', 'cleanView', 'clear', 'soundToggle', 'volume', 'motion', 'tagSearch', 'map', 'statusTitle'];
    for (const id of ['chooseButton', 'fileName', 'copyCoordinates', 'exportReport', 'recenter', ...always]) {
      const e = document.getElementById(id);
      if (!e) {problems.push('#' + id + ' missing'); continue;}
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) {if (always.includes(id)) problems.push('#' + id + ' has no size');}
      else if (r.left < -0.5 || r.right > innerWidth + 0.5) problems.push('#' + id + ' sticks out horizontally (' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + innerWidth + ')');
    }
    for (const b of document.querySelectorAll('button, .btn, select, label.motion')) {
      if (b.offsetParent === null) continue;
      if (b.scrollWidth > b.clientWidth + 1 && getComputedStyle(b).overflow !== 'visible') problems.push('clipped content in ' + (b.id ? '#' + b.id : b.className));
    }
    const map = document.getElementById('map').getBoundingClientRect();
    if (map.height < 240 || map.width < 240) problems.push('map is only ' + Math.round(map.width) + 'x' + Math.round(map.height));
    const status = document.getElementById('statusTitle').getBoundingClientRect();
    if (status.right > innerWidth + 0.5) problems.push('outcome title cut off');
    return problems.map(p => label + ': ' + p);
  }, label);
}

for (const [width, height] of WIDTHS) {
  scenario('layout at ' + width + ' x ' + height + ': nothing overflows, every control is reachable, the map keeps a usable size', {viewport: {width, height}, motion: 'fast', contextOptions: width < 500 ? {hasTouch: true, isMobile: true, deviceScaleFactor: 2} : {}}, async ({page}) => {
    await B.save(page, 'layout-' + width + '-1-idle.png');
    assert.deepEqual(await layoutProblems(page, 'idle'), []);
    await B.choose(page, 'sample-street.jpg');
    await page.click('#analyze');
    await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
    assert.deepEqual(await layoutProblems(page, 'scan'), []);
    await B.waitDone(page);
    await B.sleep(300);
    await B.save(page, 'layout-' + width + '-2-located.png');
    assert.deepEqual(await layoutProblems(page, 'located'), []);
    // Even the longest real values fit: the SHA-256 and the full coordinates wrap rather than overflow.
    const wide = await page.evaluate(() => [...document.querySelectorAll('#coordinates *, #fileHash, #metadataBody td')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible' && e.getBoundingClientRect().right > innerWidth).map(e => e.id || e.className || e.tagName));
    assert.deepEqual(wide, [], 'values that run past the window edge');
    await B.analyze(page, 'no-gps.jpg');
    await B.save(page, 'layout-' + width + '-3-no-location.png');
    assert.deepEqual(await layoutProblems(page, 'no location'), []);
    const s = await B.snapshot(page);
    assert.ok(s.camera.zoom < 3.5);
  });
}

scenario('phone width: primary controls are comfortable touch targets', {viewport: {width: 390, height: 844}, motion: 'fast', contextOptions: {hasTouch: true, isMobile: true, deviceScaleFactor: 2}}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const sizes = await page.evaluate(() => {
    const out = {};
    for (const id of ['analyze', 'skip', 'changeImage', 'clear', 'replay', 'cleanView', 'copyCoordinates', 'exportReport', 'recenter', 'soundToggle', 'motion', 'zoomIn', 'zoomOut', 'chooseButton']) {
      const e = document.getElementById(id); if (!e) {out[id] = null; continue;}
      const r = e.getBoundingClientRect(); out[id] = [Math.round(r.width), Math.round(r.height)];
    }
    return out;
  });
  const hidden = Object.entries(sizes).filter(([id, s]) => !s || s[0] === 0 || s[1] === 0).map(([id]) => id);
  assert.ok(hidden.length <= 1, 'only the empty-state chooser may be hidden after a result: ' + hidden.join(', '));
  const small = Object.entries(sizes).filter(([id, s]) => s && s[0] && s[1] && Math.min(...s) < 44).map(([id, s]) => '#' + id + ' ' + s.join('x'));
  assert.deepEqual(small, [], 'targets smaller than 44 px in one direction');
});

/* ============================================================ visual evidence ============================== */

scenario('visual evidence: the cinematic stages and the main outcomes are captured when META_TRACE_ARTIFACTS is set', {motion: 'full'}, async ({page}) => {
  await B.save(page, 'stage-0-idle.png');
  await B.choose(page, 'sample-street.jpg');
  await B.save(page, 'stage-1-ready.png');
  await page.click('#analyze');
  const seen = [];
  for (const [state, shot, delay] of [['scan', 'stage-2-scan.png', 350], ['reveal', 'stage-3-reveal.png', 450], ['resolve', 'stage-4-resolve.png', 150], ['fly', 'stage-5-descent.png', 1300], ['lock', 'stage-6-lock.png', 150]]) {
    await page.waitForFunction(s => window.MetaTrace.snapshot().presentation === s, state, {timeout: 20000});
    await B.sleep(delay);
    await B.save(page, shot); seen.push(state);
  }
  await B.waitDone(page, 20000);
  await B.sleep(400);
  await B.save(page, 'stage-7-settled-street.png');
  assert.deepEqual(seen, ['scan', 'reveal', 'resolve', 'fly', 'lock']);
  await B.analyze(page, 'handoff-overview.jpg');
  await B.save(page, 'outcome-overview-outside-streets.png');
  await B.analyze(page, 'no-gps.jpg');
  await B.save(page, 'outcome-no-location.png');
  await B.analyze(page, 'conflicting-gps.jpg');
  await B.save(page, 'outcome-conflict.png');
  await B.analyze(page, 'gps-near-pole.jpg');
  await B.save(page, 'outcome-polar-notice.png');
  await B.analyze(page, 'corrupt.tiff');
  await B.save(page, 'outcome-read-error.png');
  if (process.env.META_TRACE_ARTIFACTS) for (const f of ['stage-7-settled-street.png', 'outcome-polar-notice.png']) assert.ok(fs.statSync(path.join(process.env.META_TRACE_ARTIFACTS, f)).size > 10000, f + ' is a real image');
});

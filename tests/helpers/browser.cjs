// Shared helpers for the real-browser tests. Playwright is a development dependency only: the app itself needs no
// packages. When Playwright or its Chromium is missing, every browser test reports a skip with the reason.
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const APP_URL = 'file://' + path.join(ROOT, 'META_trace_Console.html');
const ARTIFACT_DIR = process.env.META_TRACE_ARTIFACTS || '';

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const id of candidates) {try {return require(id);} catch {/* try the next */}}
  return null;
}

let launching = null, skipReason = null;
/** One shared Chromium for the whole file. Resolves to null (and records why) when it cannot start. */
function getBrowser() {
  if (launching) return launching;
  launching = (async () => {
    const pw = loadPlaywright();
    if (!pw) {skipReason = 'Playwright is not installed (npm install, then npx playwright install chromium).'; return null;}
    try {
      return await pw.chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
    } catch (error) {skipReason = 'Chromium could not be started: ' + String(error.message).split('\n')[0]; return null;}
  })();
  return launching;
}
async function closeBrowser() {const b = await launching; if (b) await b.close(); launching = null;}
const reason = () => skipReason;

/**
 * Opens the built app in a fresh context. Records console problems, page errors and every request the page makes,
 * so tests can assert there were none outside the local file, blob and data schemes.
 */
async function openApp(browser, {viewport = {width: 1440, height: 900}, url = APP_URL, init = [], contextOptions = {}, motion} = {}) {
  const context = await browser.newContext({viewport, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'], ...contextOptions});
  const page = await context.newPage();
  const problems = [], requests = [], dialogs = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => {if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text());});
  page.on('request', r => requests.push(r.url()));
  page.on('dialog', d => {dialogs.push(d.message()); d.dismiss();});
  // A passive recorder of presentation state changes, installed before any page script runs.
  await page.addInitScript(() => {
    window.__sequence = [];
    window.__revoked = 0;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = u => {window.__revoked++; return revoke(u);};
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const s = document.body.dataset.presentation, last = window.__sequence[window.__sequence.length - 1];
        if (!last || last.state !== s) window.__sequence.push({state: s, at: performance.now()});
      }).observe(document.body, {attributes: true, attributeFilter: ['data-presentation']});
    });
  });
  for (const script of init) await page.addInitScript(script);
  if (motion) await page.addInitScript(m => {try {localStorage.setItem('metatrace.settings.v1', JSON.stringify({sound: true, volume: 35, motion: m}));} catch {}}, motion);
  await page.goto(url);
  await page.waitForFunction(() => window.MetaTrace && document.body.dataset.presentation);
  return {context, page, problems, requests, dialogs, close: () => context.close()};
}

const snapshot = page => page.evaluate(() => window.MetaTrace.snapshot());
const fixture = name => path.join(FIXTURES, name);
const sha256 = name => crypto.createHash('sha256').update(fs.readFileSync(fixture(name))).digest('hex');
const text = (page, id) => page.locator('#' + id).innerText();
const content = (page, id) => page.locator('#' + id).textContent();

/** Select a file and wait until the app has either accepted it (Image ready) or rejected it with an error. */
async function choose(page, name, {path: filePath} = {}) {
  await page.setInputFiles('#fileInput', filePath || fixture(name));
  await page.waitForFunction(() => {
    const status = document.getElementById('status');
    return document.getElementById('statusTitle').textContent === 'Image ready' || status.dataset.kind === 'error';
  });
}
const waitDone = (page, timeout = 20000) => page.waitForFunction(() => {const s = window.MetaTrace.snapshot(); return !s.running && (s.presentation === 'settled' || s.presentation === 'error');}, null, {timeout});
/** Select a fixture, press Analyze and wait for the presentation to finish. */
async function analyze(page, name, {wait = true} = {}) {
  await choose(page, name);
  await page.click('#analyze');
  if (wait) await waitDone(page);
}
async function save(page, name) {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, {recursive: true});
  await page.screenshot({path: path.join(ARTIFACT_DIR, name)});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Measures the final five-mile frame from what is on screen, without asking the app to measure itself.
 * The frame's DOM rectangle and the renderer's camera (as reported by the read-only snapshot) are turned back into
 * longitude/latitude, and the ground distances between the frame's edge midpoints are taken on the WGS84 ellipsoid
 * (Vincenty, checked separately against published geodesics in globe-math.test.cjs).
 * Flat map: Web Mercator inverse around the map's centre. Globe: the globe camera's own unprojection of those pixels.
 */
const GM = require('../../globe-math.js');
async function measureFrame(page) {
  const m = await page.evaluate(() => {
    const s = window.MetaTrace.snapshot();
    const box = id => {const b = document.getElementById(id).getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height};};
    const f = document.getElementById('frame5');
    return {view: s.view, camera: s.camera, globe: s.globe, frame: box('frame5'), map: box('map'), gc: box('globeCanvas'), shown: !f.hidden && f.dataset.on === 'true', app: s.sequence.frame};
  });
  const d = (a, b) => GM.vincentyInverse(a.lat, a.lon, b.lat, b.lon);
  const fx = m.frame.x + m.frame.w / 2, fy = m.frame.y + m.frame.h / 2, hw = m.frame.w / 2, hh = m.frame.h / 2;
  let at, renderer = m.view;
  if (m.view === 'map') {
    const world = 256 * Math.pow(2, m.camera.zoom);
    const y0 = (0.5 - Math.log(Math.tan(Math.PI / 4 + m.camera.lat * Math.PI / 360)) / (2 * Math.PI)) * world, x0 = (m.camera.lng + 180) / 360 * world;
    const mapCx = m.map.x + m.map.w / 2, mapCy = m.map.y + m.map.h / 2;
    const wrap = lon => ((lon + 540) % 360) - 180;
    at = (px, py) => {const x = x0 + (px - mapCx), y = y0 + (py - mapCy); return {lon: wrap(x / world * 360 - 180), lat: (2 * Math.atan(Math.exp((0.5 - y / world) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI};};
  } else {
    const cam = GM.createCamera(m.gc.w, m.gc.h).set(m.globe.lon, m.globe.lat, m.globe.alt);
    at = (px, py) => cam.unproject(px - m.gc.x, py - m.gc.y);
  }
  const P = {w: at(fx - hw, fy), e: at(fx + hw, fy), n: at(fx, fy - hh), s: at(fx, fy + hh), c: at(fx, fy)};
  if (Object.values(P).some(p => !p)) return {renderer, shown: m.shown, missing: true, camera: m.camera, app: m.app};
  return {
    renderer, shown: m.shown, camera: m.camera, sidePx: {w: m.frame.w, h: m.frame.h},
    widthMiles: d(P.w, P.e) / GM.MILE, heightMiles: d(P.n, P.s) / GM.MILE, centre: P.c,
    centreOffsetM: (lat, lon) => d(P.c, {lat, lon}), app: m.app
  };
}

/**
 * The final view is five miles wide and five miles high, centred on the point. The frame is square on screen, and Web
 * Mercator is not exactly equal-scale east-west and north-south on the ellipsoid, so the measured distances differ from
 * five miles by a fraction of a percent (0.35% at the equator, less towards the poles); the test allows 0.6%.
 */
async function expectFrame(page, lat, lon, label = '', {renderer} = {}) {
  const m = await measureFrame(page);
  assert.ok(!m.missing, label + 'the frame corners lie on the visible surface');
  assert.equal(m.shown, true, label + 'the five-mile frame is shown');
  if (renderer) assert.equal(m.renderer, renderer, label + 'final renderer');
  assert.ok(Math.abs(m.widthMiles - 5) < 0.03 && Math.abs(m.heightMiles - 5) < 0.03, label + 'frame measures ' + m.widthMiles.toFixed(3) + ' x ' + m.heightMiles.toFixed(3) + ' miles');
  assert.ok(m.centreOffsetM(lat, lon) < 15, label + 'the point is at the frame centre (off by ' + m.centreOffsetM(lat, lon).toFixed(1) + ' m)');
  return m;
}


/**
 * A per-frame recorder of the read-only snapshot, installed in the page. Each sample is one animation frame:
 * t (ms), the renderer in view, the globe camera, the flat-map camera, the sequence phase and the number of live voices.
 */
async function startTrace(page) {
  await page.evaluate(() => {
    window.__trace = [];
    const tick = t => {
      const s = window.MetaTrace.snapshot();
      window.__trace.push({t, view: s.view, lon: s.globe.lon, lat: s.globe.lat, alt: s.globe.alt, quality: s.globe.quality, size: s.globe.size, mlat: s.camera.lat, mlng: s.camera.lng, zoom: s.camera.zoom, phase: s.sequence.phase, running: s.sequence.running, pres: s.presentation, voices: s.audio.voices, rready: s.regions ? s.regions.ready : 0, rtiles: s.layer ? s.layer.regionTiles : 0});
      window.__traceId = requestAnimationFrame(tick);
    };
    window.__traceId = requestAnimationFrame(tick);
  });
}
const readTrace = async page => {await page.evaluate(() => cancelAnimationFrame(window.__traceId)); return page.evaluate(() => window.__trace);};
const circ = (a, b) => ((b - a + 540) % 360) - 180;
/** Longitude of the camera that is in view in a sample, made continuous across the +/-180 line. */
function unwrapped(samples) {
  const out = [];
  samples.forEach((s, i) => {const raw = s.view === 'globe' ? s.lon : s.mlng; out.push(i ? out[i - 1] + circ(out[i - 1], raw) : raw);});
  return out;
}
/** Frame-to-frame intervals of a trace, with percentiles. */
function intervals(samples) {
  const dts = samples.slice(1).map((s, i) => s.t - samples[i].t).sort((a, b) => a - b);
  const pct = p => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  return {frames: samples.length, median: +pct(.5).toFixed(1), p95: +pct(.95).toFixed(1), worst: +dts.at(-1).toFixed(1)};
}
/** JS heap and DOM size from the browser's own counters (Chromium). */
async function heap(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  await cdp.detach();
  return {jsHeapUsedMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), jsHeapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(1), nodes: m.Nodes};
}
/** Writes a JSON measurement next to the other artifacts when META_TRACE_ARTIFACTS is set. */
function record(name, data) {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, {recursive: true});
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(data, null, 2));
}

module.exports = {startTrace, readTrace, unwrapped, intervals, circ, heap, record, expectFrame, measureFrame, ROOT, FIXTURES, APP_URL, getBrowser, closeBrowser, reason, openApp, snapshot, fixture, sha256, text, content, choose, analyze, waitDone, save, sleep};

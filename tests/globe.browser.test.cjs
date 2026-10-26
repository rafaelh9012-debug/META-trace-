// The globe and the camera, in a real browser (Chromium via Playwright), against the built single-file app.
// What is measured here is measured from outside the app: the per-frame snapshot, the DOM rectangle of the five-mile
// frame and the renderers' cameras, never the app's own opinion of whether it did the right thing.
//
// Everything runs in headless Chromium with software rasterisation. Timing numbers are evidence of the environment they
// were taken in, not a performance claim for other machines.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./helpers/browser.cjs');
const GM = require('../globe-math.js');

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
const IDLE = GM.IDLE_ALT;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const until = (page, predicate, timeout = 30000) => page.waitForFunction(predicate, null, {timeout});
const states = async page => (await page.evaluate(() => window.__sequence.map(x => x.state))).filter((s, i, a) => s !== 'idle' && s !== a[i - 1]);
const waitPhase = (page, phase, timeout = 30000) => page.waitForFunction(p => {const q = window.MetaTrace.snapshot().sequence; return q.running && q.phase === p;}, phase, {timeout});
/** Voices fade out over about 40 ms and leave the registry when the fade ends: silent within 400 ms is "at once". */
const silent = (page, why) => page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 400}).catch(() => {throw new Error('audio still playing 400 ms after ' + why);});

/** After Skip the sequence sounds are cut at once and only the short closing confirmation (one voice, about 0.7 s) may remain. */
const closingOnly = async (page, why) => {
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices <= 1, null, {timeout: 400}).catch(() => {throw new Error('more than the closing cue still playing 400 ms after ' + why);});
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 2500}).catch(() => {throw new Error('the closing cue did not end within 2.5 s of ' + why);});
};

/** Looks at the pixels the globe actually drew. */
const globePixels = page => page.evaluate(() => {
  const c = document.getElementById('globeCanvas'), g = c.getContext('2d'), {width, height} = c, d = g.getImageData(0, 0, width, height).data, n = width * height;
  // space: the near-black of the corners (luminance under 9); body: everything else the globe drew (disc, glow, stars);
  // lit: the linework (coastlines, borders, graticule highlights) at luminance 40 and over.
  let space = 0, bright = 0, lit = 0, r = 0, gr = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], Bl = d[i + 2], L = 0.2126 * R + 0.7152 * G + 0.0722 * Bl;
    if (L < 9) space++;
    if (L > 235) bright++;
    if (L >= 40) {lit++; r += R; gr += G; b += Bl;}
  }
  const px = (x, y) => Array.from(d.slice((y * width + x) * 4, (y * width + x) * 4 + 3));   // from the same single read-back
  return {width, height, space: space / n, body: 1 - space / n, bright: bright / n, lit: lit / n, mean: lit ? [r / lit, gr / lit, b / lit] : null, corners: [px(2, 2), px(width - 3, 2), px(2, height - 3), px(width - 3, height - 3)]};
});

/** The marker and the frame must not hide under a panel: the topmost element at the centre and corners is the map itself. */
const covered = page => page.evaluate(() => {
  const f = document.getElementById('frame5').getBoundingClientRect(), bad = [];
  const pts = {centre: [f.x + f.width / 2, f.y + f.height / 2], nw: [f.x + 4, f.y + 4], ne: [f.right - 4, f.y + 4], sw: [f.x + 4, f.bottom - 4], se: [f.right - 4, f.bottom - 4]};
  for (const [k, [x, y]] of Object.entries(pts)) {
    const e = document.elementFromPoint(x, y);
    if (!(e && (e.id === 'globeCanvas' || e.id === 'map' || e.closest('#map')))) bad.push(k + ': ' + (e ? (e.id || e.className || e.tagName) : 'nothing'));
  }
  return bad;
});

/* ============================================================== the default view ============================ */

scenario('idle: a real 3D globe in dark space, red and legible, with no bloom, turning slowly by itself', {motion: 'full'}, async ({page}) => {
  const s0 = await B.snapshot(page);
  assert.equal(s0.view, 'globe');
  assert.ok(near(s0.globe.alt, IDLE, 1), 'resting height');
  await B.sleep(1200);
  const s1 = await B.snapshot(page);
  const turn = B.circ(s0.globe.lon, s1.globe.lon);
  assert.ok(turn < -1.5 && turn > -9, 'the globe turned ' + turn.toFixed(2) + ' degrees west in about 1.2 s (idle rate 3.2 degrees a second)');
  const p = await globePixels(page);
  B.record('globe-idle-pixels.json', {...p, note: 'fractions of the globe canvas; headless Chromium, 1440x900'});
  assert.ok(p.space > 0.4, 'space is the dark majority (' + p.space.toFixed(2) + ')');
  assert.ok(p.body > 0.15 && p.body < 0.6, 'the globe covers part of the view, not all of it or none (' + p.body.toFixed(2) + ')');
  assert.ok(p.lit > 0.004 && p.lit < 0.15, 'the coastlines and borders are lit, without flooding the view (' + p.lit.toFixed(3) + ')');
  assert.ok(p.bright < 0.01, 'no blown-out highlights or bloom (' + (p.bright * 100).toFixed(2) + ' % near white)');
  assert.ok(p.mean[0] > 1.6 * p.mean[1] && p.mean[0] > 1.25 * p.mean[2], 'the lit parts are red, not grey or blue: ' + p.mean.map(v => v.toFixed(0)).join(', '));
  for (const c of p.corners) assert.ok(Math.max(...c) < 60, 'the corners are dark space: ' + c.join(','));
  assert.equal(await page.locator('#globeCanvas').getAttribute('role'), 'application');
  assert.ok((await page.locator('#globeCanvas').getAttribute('aria-label')).includes('Drag to turn'));
});

scenario('drag, wheel, double-click, keyboard and Recenter all work on the idle globe', {motion: 'full'}, async ({page}) => {
  const box = await page.locator('#globeCanvas').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cam = async () => (await B.snapshot(page)).globe;
  let a = await cam();
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy, {steps: 8}); await B.sleep(200); await page.mouse.up();
  let b = await cam();
  assert.ok(B.circ(a.lon, b.lon) < -3, 'dragging right turns the surface with the cursor: longitude fell by ' + (-B.circ(a.lon, b.lon)).toFixed(1));
  a = b;
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await B.sleep(150);
  b = await cam();
  assert.ok(b.alt < a.alt * 0.8, 'wheel up moves in: ' + Math.round(a.alt) + ' to ' + Math.round(b.alt) + ' m');
  await page.mouse.wheel(0, 800); await B.sleep(150);
  assert.ok((await cam()).alt > b.alt * 1.5, 'wheel down moves out');
  // Keyboard: the canvas takes focus on click; arrows move it, + and - zoom, Home goes home.
  await page.locator('#globeCanvas').focus();
  a = await cam(); await page.keyboard.press('ArrowRight'); await B.sleep(60); b = await cam();
  assert.ok(B.circ(a.lon, b.lon) > 0.5, 'ArrowRight moves the view east over the surface (longitude rose by ' + B.circ(a.lon, b.lon).toFixed(2) + ')');
  a = b; await page.keyboard.press('ArrowUp'); await B.sleep(60); b = await cam();
  assert.ok(b.lat > a.lat + 0.3, 'ArrowUp moves the view north');
  a = b; await page.keyboard.press('+'); b = await cam();
  assert.ok(b.alt < a.alt * 0.85, 'plus zooms in');
  // Double-click recentres on the spot and zooms in.
  a = await cam(); await page.mouse.dblclick(cx + 60, cy - 40); await B.sleep(800); b = await cam();
  assert.ok(b.alt < a.alt * 0.7, 'double-click zooms in');
  await page.keyboard.press('Home');
  await B.sleep(1300);
  b = await cam();
  assert.ok(Math.abs(b.lat - 18) < 0.6 && near(b.alt, IDLE, IDLE * 0.01), 'Home returns to the home view (lat ' + b.lat.toFixed(2) + ', alt ' + Math.round(b.alt) + ')');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 100, cy + 80, {steps: 6}); await page.mouse.up(); await B.sleep(400);
  await page.click('#recenter'); await B.sleep(1300);
  b = await cam();
  assert.ok(Math.abs(b.lat - 18) < 0.6 && near(b.alt, IDLE, IDLE * 0.01), 'Recenter returns to the home view');
});

/* ============================================================== the sequence ================================ */

scenario('the sequence: a measured full revolution, orientation, one continuous descent, hand-off and a centred frame', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await B.startTrace(page);
  await page.click('#analyze');
  await B.waitDone(page, 40000);
  const trace = await B.readTrace(page);
  const final = await B.snapshot(page);
  const run = trace.filter(s => s.running);
  assert.ok(run.length > 300, 'frames while the sequence ran: ' + run.length);

  // 1. The revolution, measured from the camera itself.
  const u = B.unwrapped(run), plan = final.sequence.plan;
  const sweep = u[0] - u[u.length - 1];
  assert.ok(sweep >= 360, 'the camera swept ' + sweep.toFixed(1) + ' degrees of longitude');
  assert.ok(Math.abs(sweep - plan.sweep) < 4, 'and it matches the plan (' + plan.sweep.toFixed(1) + ')');
  let east = 0, maxStep = 0;
  for (let i = 1; i < u.length; i++) {east = Math.max(east, u[i] - u[i - 1]); maxStep = Math.max(maxStep, Math.abs(u[i] - u[i - 1]));}
  assert.ok(east < 0.3, 'it never turned back (largest eastward step ' + east.toFixed(3) + ')');
  assert.ok(maxStep < 14, 'largest step in one frame ' + maxStep.toFixed(1) + ' degrees (the plan peaks near 3.3)');
  const k360 = u.findIndex(v => u[0] - v >= 360);
  assert.ok(k360 > 0 && run[k360].view === 'globe' && run[k360].alt > 6e6, 'the full turn was done while the whole globe was still in view (altitude ' + Math.round(run[k360].alt) + ' m)');

  // 2. Phases and the descent: spin, then orient, then descend, in that order, with height only ever falling.
  const phases = run.map(s => s.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases.filter(p => ['spin', 'orient', 'descend'].includes(p)), ['spin', 'orient', 'descend']);
  const globeDescent = run.filter(s => s.view === 'globe' && s.phase === 'descend');
  assert.ok(globeDescent.length > 60, 'descent frames on the globe: ' + globeDescent.length);
  let rise = 1, worstDrop = 1;
  for (let i = 1; i < globeDescent.length; i++) {rise = Math.max(rise, globeDescent[i].alt / globeDescent[i - 1].alt); worstDrop = Math.min(worstDrop, globeDescent[i].alt / globeDescent[i - 1].alt);}
  assert.ok(rise < 1.0005, 'height never increases during the descent (' + rise + ')');
  assert.ok(worstDrop > 0.85, 'no frame drops the height by more than 15 % (worst ' + worstDrop.toFixed(3) + ')');
  // The orientation overlaps both the revolution and the start of the descent (planned: orient 0.10 to 0.58, descent from
  // 0.46), so the distance to the target is not monotonic: it swings with the longitude while the globe turns. What must
  // hold is that the latitude closes on the target without overshooting, and that the view is on the target before the
  // flat map takes over.
  const closing = run.filter(s => s.view === 'globe' && (s.phase === 'orient' || s.phase === 'descend'));
  let overshoot = 0, retreat = 0;
  for (let i = 1; i < closing.length; i++) {
    overshoot = Math.max(overshoot, (LAT - closing[i].lat) * Math.sign(LAT - closing[0].lat) * -1);
    retreat = Math.max(retreat, Math.abs(closing[i].lat - LAT) - Math.abs(closing[i - 1].lat - LAT));
  }
  assert.ok(overshoot < 0.01, 'the latitude never goes past the target (' + overshoot.toFixed(4) + ' degrees)');
  assert.ok(retreat < 0.02, 'and never moves away from it (' + retreat.toFixed(4) + ' degrees)');
  const away = s => GM.haversine(s.lat, s.lon, LAT, LON), lastGlobe = globeDescent[globeDescent.length - 1];
  assert.ok(away(lastGlobe) < 50, 'the view is on the target by the end of the globe descent (' + away(lastGlobe).toFixed(1) + ' m)');

  // 3. The hand-off: the flat map takes over at the same centre and ground scale, to within one frame of the descent.
  const idx = run.findIndex(s => s.view === 'map');
  assert.ok(idx > 0, 'the flat map took over');
  const before = run[idx - 1], after = run[idx], focal = GM.focalFor(before.size.w, before.size.h);
  const globeScale = GM.groundScaleForAlt(focal, before.lat, before.alt), mapScale = GM.mercatorGroundScale(after.mlat, after.zoom).mean;
  const ratio = mapScale / globeScale;
  B.record('globe-handoff.json', {globeAltitudeM: before.alt, globeMetersPerPixel: globeScale, mapZoom: after.zoom, mapMetersPerPixel: mapScale, ratio, centreOffsetDeg: {lat: after.mlat - before.lat, lon: B.circ(before.lon, after.mlng)}});
  assert.ok(ratio > 0.9 && ratio < 1.1, 'ground scale across the hand-off agrees to within one frame of descent (ratio ' + ratio.toFixed(3) + ')');
  assert.ok(Math.abs(after.mlat - before.lat) < 0.01 && Math.abs(B.circ(before.lon, after.mlng)) < 0.01, 'and so does the centre');
  assert.ok(run.slice(idx).every(s => s.view === 'map'), 'it hands off once and does not flicker back');

  // 4. The sounds ride the sequence and end with it.
  const spin = run.filter(s => s.phase === 'spin'), descend = run.filter(s => s.phase === 'descend');
  assert.ok(spin.filter(s => s.voices > 0).length > 0.8 * spin.length, 'sound during the revolution');
  assert.ok(descend.filter(s => s.voices > 0).length > 0.8 * descend.length, 'sound during the descent');
  await page.waitForFunction(() => window.MetaTrace.snapshot().audio.voices === 0, null, {timeout: 3000});

  // 5. The end state.
  assert.deepEqual(await states(page), ['acquire', 'scan', 'reveal', 'resolve', 'fly', 'lock', 'settled']);
  await B.expectFrame(page, LAT, LON, 'full sequence: ', {renderer: 'map'});
  assert.deepEqual(await covered(page), [], 'the marker and the frame are not under a panel');
  assert.equal(final.pin.popupOpen, true);
  B.record('globe-sequence.json', {environment: 'headless Chromium, software rasterisation, 1440x900', plan, sweepDegrees: +sweep.toFixed(1), frames: B.intervals(run), globeFrames: B.intervals(run.filter(s => s.view === 'globe')), mapFrames: B.intervals(run.filter(s => s.view === 'map')), handoffAltitudeM: Math.round(before.alt)});
});

/* ============================================================== places, hemispheres, edges =================== */

const PLACES = [
  ['gps-north-west.jpg', 'Gainesville, Florida (N, W)', LAT, LON],
  ['gps-sydney.jpg', 'Sydney (S, E)', -(33 + 51 / 60 + 24.48 / 3600), 151 + 12 / 60 + 55.08 / 3600],
  ['gps-quito.jpg', 'Quito, almost on the equator (S, W)', -(10 / 60 + 48 / 3600), -(78 + 28 / 60 + 12 / 3600)],
  ['gps-zero-zero.jpg', '0, 0 (equator and prime meridian)', 0, 0],
  ['handoff-overview.jpg', 'Qinghai-Tibet plateau (N, E)', 34.204527, 89.283237],
  ['gps-outside-region.jpg', 'Paris, outside the street data (N, E)', 48 + 51 / 60 + 29.52 / 3600, 2 + 17 / 60 + 40.2 / 3600],
  ['gps-tromso.jpg', 'Tromso, 69.6 N', 69 + 38 / 60 + 57 / 3600, 18 + 57 / 60 + 19 / 3600],
  ['gps-longyearbyen.jpg', 'Longyearbyen, 78.2 N', 78 + 13 / 60 + 24 / 3600, 15 + 37 / 60 + 36 / 3600],
  ['gps-mcmurdo.jpg', 'McMurdo, 77.8 S', -(77 + 50 / 60 + 30 / 3600), 166 + 40 / 60],
  ['gps-antimeridian-east.jpg', 'just east of the antimeridian (S)', -17.75, 179 + 59 / 60 + 59.64 / 3600],
  ['gps-antimeridian-west.jpg', 'just west of the antimeridian (S)', -17.75, -(179 + 59 / 60 + 59.64 / 3600)],
  ['gps-lat-85.jpg', '85 N, the Web Mercator limit', 85, 10],
  ['gps-near-pole.jpg', '89.5 N', 89.5, 45],
  ['gps-south-pole.jpg', '89.5 S', -89.5, -45]
];

scenario('every place ends centred in a five-mile by five-mile frame: both hemispheres, the equator, high latitudes, the antimeridian and both poles', {motion: 'fast'}, async ({page}) => {
  const table = [];
  for (const [file, label, lat, lon] of PLACES) {
    await B.analyze(page, file);
    const s = await B.snapshot(page);
    assert.equal(await B.text(page, 'statusTitle'), 'GPS coordinates found', label);
    assert.ok(near(s.location.latitude, lat, 1e-6) && near(s.location.longitude, lon, 1e-6), label + ': the app plots the coordinate that is in the file');
    const m = await B.expectFrame(page, lat, lon, label + ': ');
    assert.equal(m.renderer, s.sequence.final.renderer, label + ': the renderer in view is the one the plan chose');
    if (Math.abs(lat) >= 85) assert.equal(m.renderer, 'globe', label + ': beyond the flat map the globe is the final view');
    if (Math.abs(lat) <= 78.3) assert.equal(m.renderer, 'map', label + ': the flat map is the final view');
    assert.ok(Math.abs(m.widthMiles - s.sequence.frame.measured.widthMiles) < 0.01 && Math.abs(m.heightMiles - s.sequence.frame.measured.heightMiles) < 0.01, label + ': the outside measurement agrees with the app\'s own');
    assert.deepEqual(await covered(page), [], label + ': nothing covers the marker or the frame');
    if (m.renderer === 'globe') {
      // A final that stays on the globe must hold still: the idle turn belongs to the whole-globe view and must not carry
      // the marker away from the middle of the frame once the sequence is over.
      const before = (await B.snapshot(page)).globe; await B.sleep(1200); const after = (await B.snapshot(page)).globe;
      assert.ok(before.lon === after.lon && before.lat === after.lat && before.alt === after.alt, label + ': the globe holds still at its final view (longitude moved ' + B.circ(before.lon, after.lon).toFixed(3) + ' degrees)');
      await B.expectFrame(page, lat, lon, label + ' (a second later): ');
    }
    table.push({file, label, latitude: lat, longitude: lon, renderer: m.renderer, widthMiles: +m.widthMiles.toFixed(4), heightMiles: +m.heightMiles.toFixed(4), centreOffsetM: +m.centreOffsetM(lat, lon).toFixed(2), framePx: m.sidePx.w});
  }
  B.record('frame-measurements.json', {method: 'independent: DOM rectangle of the frame plus the renderer camera, Vincenty on WGS84', viewport: '1440x900', table});
  const worst = Math.max(...table.map(r => Math.max(Math.abs(r.widthMiles - 5), Math.abs(r.heightMiles - 5))));
  console.log('    frames measured at ' + table.length + ' places; the largest deviation from 5 miles was ' + worst.toFixed(4) + ' mi (' + (worst / 5 * 100).toFixed(2) + ' %)');
  assert.ok(worst < 0.03);
});

scenario('a second place replaces the first without leaving anything of it behind', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'gps-sydney.jpg');
  await B.analyze(page, 'gps-tromso.jpg');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, 69 + 38 / 60 + 57 / 3600, 1e-6));
  assert.equal(await page.locator('#map .leaflet-marker-icon').count(), 1, 'one pin');
  await B.expectFrame(page, 69 + 38 / 60 + 57 / 3600, 18 + 57 / 60 + 19 / 3600, 'second place: ', {renderer: 'map'});
});

/* ============================================================== stopping it ================================= */

for (const [label, phase] of [['the revolution', 'spin'], ['the descent', 'descend']]) {
  scenario('Skip during ' + label + ' finishes at once, in the same final frame, and silences the sounds', {motion: 'full'}, async ({page}) => {
    await B.choose(page, 'sample-street.jpg');
    await page.click('#analyze');
    await waitPhase(page, phase);
    await B.sleep(250);
    assert.ok((await B.snapshot(page)).audio.voices > 0, 'the sequence sounds are playing');
    const t0 = Date.now();
    await page.click('#skip');
    await B.waitDone(page, 4000);
    assert.ok(Date.now() - t0 < 1500, 'finished in ' + (Date.now() - t0) + ' ms');
    await closingOnly(page, 'Skip');
    const s = await B.snapshot(page);
    assert.equal(s.sequence.running, false);
    assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON));
    await B.expectFrame(page, LAT, LON, 'skipped in ' + label + ': ', {renderer: 'map'});
    assert.equal(await B.content(page, 'latitude'), '29.64885278');
  });

  scenario('Clear during ' + label + ' stops it, silences it and returns the globe home', {motion: 'full'}, async ({page}) => {
    await B.choose(page, 'sample-street.jpg');
    await page.click('#analyze');
    await waitPhase(page, phase);
    await B.sleep(250);
    await page.click('#clear');
    await silent(page, 'Clear');
    const s = await B.snapshot(page);
    assert.deepEqual([s.view, s.sequence.running, s.running, s.globe.lat, s.globe.alt], ['globe', false, false, 18, IDLE]);
    assert.equal(s.pin, null);
    assert.equal(await B.text(page, 'statusTitle'), 'Waiting for an image');
    const frozen = s.globe.alt;
    await B.sleep(1500);
    const later = await B.snapshot(page);
    assert.equal(later.globe.alt, frozen, 'no late camera move');
    assert.equal(later.sequence.running, false);
    assert.ok(['idle', 'cancelled'].includes(later.presentation), 'the presentation stopped (' + later.presentation + ')');
  });

  scenario('a new image during ' + label + ' cancels it; the next analysis starts again from the whole globe with a full revolution', {motion: 'full'}, async ({page}) => {
    await B.choose(page, 'sample-street.jpg');
    await page.click('#analyze');
    await waitPhase(page, phase);
    if (phase === 'descend') await until(page, () => window.MetaTrace.snapshot().globe.alt < 1.2e7);
    await B.choose(page, 'gps-sydney.jpg');
    await silent(page, 'choosing another image');
    assert.equal((await B.snapshot(page)).sequence.running, false);
    await B.startTrace(page);
    await page.click('#analyze');
    await B.waitDone(page, 40000);
    const run = (await B.readTrace(page)).filter(s => s.running);
    // The first frames of the new analysis are the globe easing back up after the cancelled descent (Relax); what matters is
    // that the revolution itself begins from the whole globe.
    const spinFrom = run.findIndex(s => s.phase === 'spin');
    assert.ok(spinFrom >= 0 && run[spinFrom].view === 'globe' && run[spinFrom].alt >= 0.97 * IDLE, 'the revolution of the new sequence starts from the whole globe (altitude ' + Math.round((run[spinFrom] || {}).alt) + ' m)');
    const u = B.unwrapped(run.slice(spinFrom));
    assert.ok(u[0] - u[u.length - 1] >= 360, 'and turns it at least once: ' + (u[0] - u[u.length - 1]).toFixed(1) + ' degrees');
    await B.expectFrame(page, -(33 + 51 / 60 + 24.48 / 3600), 151 + 12 / 60 + 55.08 / 3600, 'replacement: ', {renderer: 'map'});
    assert.equal(await page.locator('#map .leaflet-marker-icon').count(), 1, 'only the new pin');
  });
}

scenario('Replay repeats the whole sequence: the globe comes back up, turns at least once, and ends in the same frame', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  await B.startTrace(page);
  await page.click('#replay');
  await B.waitDone(page, 20000);
  const run = (await B.readTrace(page)).filter(s => s.running);
  // The replay starts on the street map. During the scan the view backs out to the globe, so the revolution itself must
  // begin from the whole globe even though the very first frames of the replay are still the map.
  const spin = run.filter(s => s.phase === 'spin');
  assert.ok(spin.length >= 3 && spin[0].view === 'globe' && spin[0].alt >= 0.97 * IDLE, 'the revolution of the replay starts from the whole globe (altitude ' + Math.round(spin[0].alt) + ' m)');
  const u = B.unwrapped(run.slice(run.findIndex(s => s.phase === 'spin')));
  assert.ok(u[0] - u[u.length - 1] >= 360, 'a full revolution again: ' + (u[0] - u[u.length - 1]).toFixed(1));
  await B.expectFrame(page, LAT, LON, 'replay: ', {renderer: 'map'});
  assert.equal(await page.locator('#map .leaflet-marker-icon').count(), 1);
});

const MANUAL = [
  ['a drag on the globe during the revolution', 'spin', async page => {const b = await page.locator('#globeCanvas').boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 20, {steps: 4}); await page.mouse.up();}],
  ['the wheel over the globe during the descent', 'descend', async page => {const b = await page.locator('#globeCanvas').boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.wheel(0, 300);}],
  ['an arrow key on the globe during the revolution', 'spin', async page => {await page.locator('#globeCanvas').focus(); await page.keyboard.press('ArrowLeft');}],
  ['the zoom button during the descent', 'descend', async page => {await page.click('#zoomIn');}]
];
for (const [label, phase, act] of MANUAL) {
  scenario('manual control — ' + label + ' — takes the camera at once: sequence and sounds stop, the result is still reported, and Recenter returns to the frame', {motion: 'full'}, async ({page}) => {
    await B.choose(page, 'sample-street.jpg');
    await page.click('#analyze');
    await waitPhase(page, phase);
    await B.sleep(250);
    await act(page);
    const a = await B.snapshot(page);
    assert.equal(a.sequence.running, false, 'the sequence stopped at once');
    assert.equal(a.flying, false);
    await silent(page, 'the person took the camera');
    assert.equal(a.sequence.frame.visible, false, 'no five-mile frame is claimed over a view the person has changed');
    await B.waitDone(page, 20000);
    const s = await B.snapshot(page);
    assert.equal(await B.text(page, 'statusTitle'), 'GPS coordinates found');
    assert.equal(await B.content(page, 'latitude'), '29.64885278');
    assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'the exact result is still reported');
    assert.equal(s.sequence.running, false, 'the sequence did not restart');
    await page.click('#recenter');
    await page.waitForFunction(() => {const q = window.MetaTrace.snapshot(); return q.sequence.frame.visible && !q.flying && !q.sequence.running;}, null, {timeout: 15000});
    await B.sleep(300);
    await B.expectFrame(page, LAT, LON, 'after Recenter: ');
  });
}

/* ============================================================== motion, sound, graphics ===================== */

scenario('reduced motion: the globe does not turn, no sweep is planned, and the result is the same frame', {contextOptions: {reducedMotion: 'reduce'}}, async ({page}) => {
  const a = (await B.snapshot(page)).globe;
  await B.sleep(1200);
  const b = (await B.snapshot(page)).globe;
  assert.equal(a.lon, b.lon, 'no idle turn');
  await B.choose(page, 'gps-sydney.jpg');
  await B.startTrace(page);
  await page.click('#analyze');
  await B.waitDone(page, 10000);
  const run = await B.readTrace(page);
  const u = B.unwrapped(run);
  assert.ok(Math.max(...u) - Math.min(...u) < 1e-6 || run.every(s => s.view === 'globe' ? s.lon === run[0].lon : true), 'no revolution: the longitude only changes by the jump to the final view');
  await B.expectFrame(page, -(33 + 51 / 60 + 24.48 / 3600), 151 + 12 / 60 + 55.08 / 3600, 'reduced motion: ', {renderer: 'map'});
});

scenario('a muted run moves the camera exactly as a sounding run does, with no audio node created', {init: [() => {
  const Real = window.AudioContext; window.__nodes = 0;
  window.AudioContext = class extends Real {constructor(...a) {super(...a); for (const m of ['createOscillator', 'createBufferSource']) {const o = this[m].bind(this); this[m] = (...x) => {window.__nodes++; return o(...x);};}}};
  try {localStorage.setItem('metatrace.settings.v1', JSON.stringify({sound: false, volume: 35, motion: 'fast'}));} catch {}
}]}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await B.startTrace(page);
  await page.click('#analyze');
  await B.waitDone(page, 20000);
  const run = (await B.readTrace(page)).filter(s => s.running), u = B.unwrapped(run);
  assert.ok(u[0] - u[u.length - 1] >= 360, 'the revolution does not depend on sound');
  assert.equal(await page.evaluate(() => window.__nodes), 0, 'no oscillator or noise source was created');
  await B.expectFrame(page, LAT, LON, 'muted: ', {renderer: 'map'});
});

scenario('limited graphics: with the processor slowed six-fold the sequence still keeps its clock, turns once, and ends in the same frame', {motion: 'fast'}, async ({page, context}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
  await B.choose(page, 'sample-street.jpg');
  await B.startTrace(page);
  const t0 = Date.now();
  await page.click('#analyze');
  await B.waitDone(page, 60000);
  const wall = Date.now() - t0;
  const trace = await B.readTrace(page), run = trace.filter(s => s.running), u = B.unwrapped(run);
  const sweep = u[0] - u[u.length - 1], iv = B.intervals(run);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
  const q = (await B.snapshot(page)).globe;
  B.record('globe-throttled.json', {throttle: '6x CPU (CDP Emulation.setCPUThrottlingRate)', profile: 'fast (plan 5.07 s)', wallMs: wall, frames: iv, sweepDegrees: +sweep.toFixed(1), qualityStart: trace[0].quality, qualityEnd: q.quality, globeAvgMs: +q.avgMs.toFixed(1)});
  console.log('    throttled 6x: ' + wall + ' ms wall, ' + iv.frames + ' frames in the run (median ' + iv.median + ' ms, worst ' + iv.worst + ' ms), sweep ' + sweep.toFixed(0) + ' degrees, quality ' + trace[0].quality + ' to ' + q.quality);
  assert.ok(wall < 5070 * 2.2 + 3000, 'the sequence kept its clock: ' + wall + ' ms for a 5.07 s plan');
  assert.ok(sweep >= 360, 'and still turned the globe at least once (' + sweep.toFixed(0) + ')');
  assert.ok(iv.frames >= 12, 'with frames still being produced (' + iv.frames + ')');
  await B.expectFrame(page, LAT, LON, 'throttled: ', {renderer: 'map'});
});

/* ============================================================== offline ==================================== */

scenario('offline with every outside request refused: the globe, the whole sequence and the final frame come from bundled data', {motion: 'fast', contextOptions: {offline: true}}, async ({page, context}) => {
  const refused = [];
  await context.route(url => !isLocal(url.toString()), route => {refused.push(route.request().url()); return route.abort();});
  const p = await globePixels(page);
  assert.ok(p.lit > 0.004 && p.body > 0.15 && p.space > 0.4, 'the globe is drawn with the network gone');
  await B.analyze(page, 'gps-sydney.jpg');
  await B.expectFrame(page, -(33 + 51 / 60 + 24.48 / 3600), 151 + 12 / 60 + 55.08 / 3600, 'offline: ', {renderer: 'map'});
  assert.deepEqual(refused, [], 'the page did not even try to reach anything');
  assert.deepEqual(await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name).filter(n => !/^(blob:|data:)/.test(n))), [], 'no sub-resource was loaded: everything is inline');
  assert.match(await B.content(page, 'coverageNote'), /No offline roads or buildings are installed for this area/);
});

/* ============================================================== layouts ==================================== */

for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
  scenario('at ' + width + ' x ' + height + ' the globe fills its panel, the frame is square and visible, and no panel covers the marker', {viewport: {width, height}, motion: 'fast', contextOptions: width < 500 ? {hasTouch: true, isMobile: true, deviceScaleFactor: 2} : {}}, async ({page}) => {
    await B.save(page, 'globe-' + width + '-idle.png');
    const box = await page.evaluate(() => {const m = document.getElementById('map').getBoundingClientRect(), g = document.getElementById('globeCanvas').getBoundingClientRect(); return {map: [m.x, m.y, m.width, m.height], globe: [g.x, g.y, g.width, g.height]};});
    assert.deepEqual(box.globe.map(Math.round), box.map.map(Math.round), 'the globe canvas covers exactly the map area');
    for (const file of ['sample-street.jpg', 'gps-lat-85.jpg']) {
      await B.analyze(page, file);
      await B.sleep(300);
      const [lat, lon] = file === 'gps-lat-85.jpg' ? [85, 10] : [LAT, LON];
      const m = await B.expectFrame(page, lat, lon, width + ' px, ' + file + ': ');
      assert.ok(Math.abs(m.sidePx.w - m.sidePx.h) < 0.5, 'the frame is square on screen');
      assert.deepEqual(await covered(page), [], width + ' px, ' + file + ': the marker and the frame are not under a panel');
      if (file === 'sample-street.jpg') {
        // The coordinate card opens by itself only where there is room above the pin; elsewhere it is one click away.
        const open = (await B.snapshot(page)).pin.popupOpen;
        assert.equal(open, width >= 1440, width + ' px: the card ' + (open ? 'opened' : 'stayed closed') + ' by itself');
        if (!open) {
          await page.locator('#map .leaflet-marker-icon').first().click({force: true});
          assert.equal((await B.snapshot(page)).pin.popupOpen, true, 'and a click on the pin opens it');
        }
      }
      await B.save(page, 'globe-' + width + '-' + (file === 'gps-lat-85.jpg' ? 'polar' : 'street') + '.png');
    }
  });
}

/* ============================================================== measurements for the record ================ */

scenario('measurements for the record: heap, DOM size and page weight at rest and after a full run', {motion: 'fast'}, async ({page}) => {
  const fs = require('node:fs'), path = require('node:path');
  const html = path.join(B.ROOT, 'META_trace_Console.html');
  const before = await B.heap(page);
  await B.analyze(page, 'sample-street.jpg');
  await B.analyze(page, 'gps-sydney.jpg');
  const after = await B.heap(page);
  const zlib = require('node:zlib'), bytes = fs.readFileSync(html);
  B.record('memory-and-weight.json', {environment: 'headless Chromium 141, software rasterisation', pageBytes: bytes.length, pageGzipBytes: zlib.gzipSync(bytes, {level: 9}).length, idle: before, afterTwoRuns: after});
  console.log('    heap at rest ' + before.jsHeapUsedMB + ' MB, after two runs ' + after.jsHeapUsedMB + ' MB; page ' + (bytes.length / 1048576).toFixed(2) + ' MiB');
  assert.ok(after.jsHeapUsedMB < 200, 'JS heap stays modest (' + after.jsHeapUsedMB + ' MB)');
  assert.ok(after.jsHeapUsedMB - before.jsHeapUsedMB < 80, 'and two full runs do not grow it by much (' + (after.jsHeapUsedMB - before.jsHeapUsedMB).toFixed(1) + ' MB)');
});

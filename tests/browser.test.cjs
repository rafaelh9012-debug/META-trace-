// End-to-end flows in a real browser (Chromium via Playwright), against the built single-file app.
// Every scenario also asserts that the page raised no console errors, made no request outside the local file,
// and opened no dialog. These tests replace the old jsdom check: every assertion in it is repeated below.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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

// Gainesville fixture: 29 deg 38' 55.87" N, 82 deg 20' 16.4" W.
const LAT = 29 + 38 / 60 + 55.87 / 3600, LON = -(82 + 20 / 60 + 16.4 / 3600);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sequence = async page => (await page.evaluate(() => window.__sequence.map(x => x.state))).filter(s => s !== 'idle');
const title = page => B.text(page, 'statusTitle');
const enabled = async (page, id) => !(await page.locator('#' + id).isDisabled());
async function wideOnly(page) {const s = await B.snapshot(page); assert.ok(s.camera.zoom <= 3.5, 'camera stayed on the world view (zoom ' + s.camera.zoom + ')'); return s;}

/* ----------------------------------------------------------------------------------------- */

scenario('starts idle: nothing selected, controls disabled, no simulation or playback wording', async ({page}) => {
  assert.equal(await title(page), 'Waiting for an image');
  for (const id of ['analyze', 'skip', 'replay', 'clear', 'changeImage', 'cleanView', 'copyCoordinates', 'exportReport', 'recenter']) assert.equal(await enabled(page, id), false, id + ' is disabled');
  assert.equal(await page.title(), 'META trace');
  const visible = await page.locator('body').innerText();
  const attributes = await page.evaluate(() => [...document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')].map(e => [e.getAttribute('aria-label'), e.title, e.getAttribute('placeholder'), e.getAttribute('alt')].filter(Boolean).join(' ')).join(' | '));
  assert.doesNotMatch(visible + ' ' + attributes, /simulat|playback|demo\b|mock|fake|placeholder data|sample data/i);
  const s = await B.snapshot(page);
  assert.deepEqual([s.presentation, s.analysis, s.camera.zoom, s.pin, s.audio.voices], ['idle', 'idle', 2.2, null, 0]);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
});

scenario('success (fast motion): ordered presentation, exact values, street-scale finish', {motion: 'fast'}, async ({page}) => {
  await B.choose(page, 'gps-north-west.jpg');
  assert.equal(await title(page), 'Image ready');
  assert.equal(await enabled(page, 'analyze'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'analyze', 'focus moves to Analyze after choosing a file');
  assert.equal(await B.snapshot(page).then(s => s.pin), null, 'nothing is plotted before Analyze');
  assert.equal(await page.locator('#coordinates').isHidden(), true);
  await page.click('#analyze');
  await B.waitDone(page);

  assert.deepEqual(await sequence(page), ['acquire', 'scan', 'reveal', 'resolve', 'fly', 'lock', 'settled']);
  assert.equal(await title(page), 'GPS coordinates found');
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
  assert.equal(await B.content(page, 'longitude'), '-82.33788889');
  assert.equal(await B.content(page, 'fileHash'), B.sha256('gps-north-west.jpg'));
  assert.equal(await page.locator('#coordinates').isVisible(), true);
  assert.equal(await B.content(page, 'coverageBadge'), 'OFFLINE / STREETS');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'pin sits exactly on the recorded coordinate');
  assert.ok(near(s.camera.lat, LAT) && near(s.camera.lng, LON), 'camera ended on the pin');
  assert.equal(s.camera.zoom, 18);
  assert.equal(s.pin.popupOpen, true);
  assert.equal(s.mapNotice, null);
  assert.equal(s.stagePhase, 'settled');
  assert.equal(await page.locator('#bay').getAttribute('data-outcome'), 'located');
  for (const id of ['copyCoordinates', 'exportReport', 'replay', 'analyze', 'clear', 'changeImage', 'recenter']) assert.equal(await enabled(page, id), true, id);
  assert.equal(await enabled(page, 'skip'), false);

  await page.fill('#tagSearch', 'Fixture 1');
  assert.match(await B.content(page, 'metadataBody'), /Fixture 1/);
  await page.fill('#tagSearch', 'zzz-no-such-tag');
  assert.match(await B.text(page, 'metadataEmpty'), /No tags match/);
});

scenario('success with a recorded position error: the circle is centred on the original coordinate', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const s = await B.snapshot(page);
  assert.ok(near(s.accuracy.lat, s.pin.lat) && near(s.accuracy.lng, s.pin.lng), 'circle centre equals the pin');
  assert.ok(near(s.accuracy.lat, LAT) && near(s.accuracy.lng, LON));
  assert.equal(s.accuracy.radius, 12.5);
  assert.equal(await B.content(page, 'accuracy'), '12.5 m');
  assert.equal(await B.content(page, 'altitude'), '47.46 m');
});

scenario('a file without GPSHPositioningError draws no circle and says "Not recorded"', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'gps-north-west.jpg');
  const s = await B.snapshot(page);
  assert.equal(s.accuracy, null);
  assert.equal(await B.content(page, 'accuracy'), 'Not recorded');
});

scenario('cinematic: beat durations follow the plan and the flight keeps producing frames', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {window.__frames = []; const tick = t => {window.__frames.push(t); requestAnimationFrame(tick);}; requestAnimationFrame(tick);});
  await page.click('#analyze');
  await B.waitDone(page, 30000);
  const {steps, frames} = await page.evaluate(() => ({steps: window.__sequence.filter(s => s.state !== 'idle'), frames: window.__frames}));
  const dur = {};
  steps.forEach((s, i) => {if (steps[i + 1]) dur[s.state] = steps[i + 1].at - s.at;});
  const total = steps.at(-1).at - steps[0].at;
  const within = (name, plan, tol) => assert.ok(Math.abs(dur[name] - plan) <= tol, name + ' lasted ' + Math.round(dur[name]) + ' ms, plan ' + plan + ' +/- ' + tol);
  within('acquire', 300, 150); within('scan', 900, 200); within('reveal', 1000, 200); within('resolve', 600, 150); within('fly', 2900, 500); within('lock', 500, 150);
  assert.ok(Math.abs(total - 6200) < 700, 'whole sequence ' + Math.round(total) + ' ms, plan 6200');
  const flightFrames = frames.filter(t => t >= steps.find(s => s.state === 'fly').at && t <= steps.find(s => s.state === 'lock').at);
  const dts = flightFrames.slice(1).map((t, i) => t - flightFrames[i]).sort((a, b) => a - b);
  const pct = p => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  console.log('    full sequence ' + Math.round(total) + ' ms; flight frames ' + flightFrames.length + ', frame interval median ' + pct(.5).toFixed(1) + ' ms, p95 ' + pct(.95).toFixed(1) + ' ms, worst ' + dts.at(-1).toFixed(1) + ' ms (headless software rendering, not a performance claim)');
  if (process.env.META_TRACE_ARTIFACTS) {fs.mkdirSync(process.env.META_TRACE_ARTIFACTS, {recursive: true}); fs.writeFileSync(path.join(process.env.META_TRACE_ARTIFACTS, 'frame-timing.json'), JSON.stringify({environment: 'headless Chromium, software rasterisation, 1440x900', fullSequenceMs: Math.round(total), phaseMs: Object.fromEntries(Object.entries(dur).map(([k, v]) => [k, Math.round(v)])), flightFrames: flightFrames.length, frameIntervalMs: {median: +pct(.5).toFixed(1), p95: +pct(.95).toFixed(1), worst: +dts.at(-1).toFixed(1)}}, null, 2));}
  assert.ok(flightFrames.length > 25, 'the flight rendered ' + flightFrames.length + ' frames');
  const layer = (await B.snapshot(page)).layer;
  assert.ok(layer.avgMs < 40, 'average base-map redraw ' + layer.avgMs.toFixed(1) + ' ms');
});

scenario('a missing GPS tag is reported plainly: no pin, no coordinates, the map stays on the world view', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'no-gps.jpg');
  assert.equal(await title(page), 'No location metadata found');
  assert.equal(await page.locator('#coordinates').isHidden(), true);
  assert.equal(await enabled(page, 'copyCoordinates'), false);
  assert.equal(await enabled(page, 'exportReport'), true);
  assert.equal(await enabled(page, 'recenter'), false);
  assert.equal(await page.locator('#mapNotice').isVisible(), true);
  assert.equal(await B.content(page, 'coverageBadge'), 'OFFLINE MAP');
  assert.deepEqual(await sequence(page), ['acquire', 'scan', 'reveal', 'settled'], 'no resolve, fly or lock without a location');
  const s = await wideOnly(page);
  assert.equal(s.pin, null);
  assert.equal(s.location, null);
  assert.equal(await page.locator('#bay').getAttribute('data-outcome'), 'neutral');
  assert.match(await B.text(page, 'resultEmpty'), /no GPS position/);
});

for (const [file, expected, kind] of [
  ['partial-gps.jpg', 'Location metadata is incomplete', 'warning'],
  ['missing-ref.jpg', 'Location metadata is incomplete', 'warning'],
  ['invalid-gps.jpg', 'Location metadata is invalid', 'warning'],
  ['conflicting-gps.jpg', 'Location metadata conflicts', 'warning']
]) {
  scenario('partial, invalid and conflicting GPS stay distinct and never produce a pin: ' + file, {motion: 'reduced'}, async ({page}) => {
    await B.analyze(page, file);
    assert.equal(await title(page), expected);
    assert.equal(await page.locator('#status').getAttribute('data-kind'), kind);
    const s = await wideOnly(page);
    assert.equal(s.pin, null);
    assert.equal(s.location, null);
    assert.equal(await page.locator('#coordinates').isHidden(), true);
    assert.equal(await enabled(page, 'copyCoordinates'), false);
    assert.equal(await page.locator('#mapNotice').isVisible(), true);
    if (file === 'conflicting-gps.jpg') {
      assert.equal(await page.locator('#candidates').isVisible(), true);
      assert.equal(await page.locator('#candidateList li').count(), 2, 'both candidate pairs are listed, neither chosen');
    }
  });
}

scenario('XMP-only coordinates are read, and the exact pair is plotted', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'xmp-gps.jpg');
  assert.equal(await title(page), 'GPS coordinates found');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, 48 + 51.492 / 60) && near(s.pin.lng, 2 + 17.670 / 60));
  assert.equal(s.camera.zoom, 5, 'Paris is outside the bundled streets: world overview');
});

scenario('read failures and unsupported files keep their own messages', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'corrupt.tiff');
  assert.equal(await title(page), 'Could not read image metadata');
  assert.equal(await page.locator('#status').getAttribute('data-kind'), 'error');
  assert.equal(await enabled(page, 'exportReport'), false, 'nothing to export after a failed read');
  assert.equal(await page.locator('#bay').getAttribute('data-phase'), 'error');
  assert.equal((await B.snapshot(page)).analysis, 'failed');
  await B.analyze(page, 'corrupt.webp');
  assert.equal(await title(page), 'Could not read image metadata');

  await B.choose(page, 'unsupported.bin');
  assert.equal(await title(page), 'Unsupported image format');
  assert.equal(await enabled(page, 'analyze'), false);
  await B.choose(page, 'empty.jpg');
  assert.equal(await title(page), 'Empty image file');
  assert.equal(await enabled(page, 'analyze'), false);

  const huge = path.join(os.tmpdir(), 'metatrace-huge-' + process.pid + '.jpg');
  const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 65 * 1024 * 1024); fs.closeSync(fd);
  try {
    await B.choose(page, null, {path: huge});
    assert.equal(await title(page), 'Image is too large');
    assert.equal(await enabled(page, 'analyze'), false);
  } finally {fs.rmSync(huge, {force: true});}
  // The app recovers: a good file after any failure works normally.
  await B.analyze(page, 'gps-north-west.jpg');
  assert.equal(await title(page), 'GPS coordinates found');
});

scenario('zero/zero is a real coordinate and is plotted like any other', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'gps-zero-zero.jpg');
  assert.equal(await B.content(page, 'latitude'), '0.00000000');
  assert.equal(await B.content(page, 'longitude'), '0.00000000');
  const s = await B.snapshot(page);
  assert.deepEqual([s.pin.lat, s.pin.lng], [0, 0]);
  assert.equal(await B.content(page, 'coverageBadge'), 'OFFLINE / OVERVIEW');
});

scenario('outside the bundled region the exact point stays on the world overview, with an explanation', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'gps-outside-region.jpg');
  assert.equal(await B.content(page, 'coverageBadge'), 'OFFLINE / OVERVIEW');
  assert.match(await B.content(page, 'coverageNote'), /not bundled/);
  const s = await B.snapshot(page);
  assert.equal(s.camera.zoom, 5, 'never flies into a blank maximum zoom');
  assert.ok(near(s.pin.lat, 48 + 51 / 60 + 29.52 / 3600) && near(s.pin.lng, 2 + 17 / 60 + 40.2 / 3600));
  assert.ok(near(s.camera.lat, s.pin.lat) && near(s.camera.lng, s.pin.lng));
});

scenario('the handoff coordinate finishes on the world overview, with elevation, error radius and numbers intact', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'handoff-overview.jpg');
  assert.equal(await B.content(page, 'latitude'), '34.20452700');
  assert.equal(await B.content(page, 'longitude'), '89.28323700');
  assert.equal(await B.content(page, 'altitude'), '47.46 m');
  assert.equal(await B.content(page, 'accuracy'), '12.5 m');
  const s = await B.snapshot(page);
  assert.equal(s.camera.zoom, 5);
  assert.equal(s.coverage, 'OFFLINE / OVERVIEW');
  assert.ok(near(s.accuracy.lat, 34.204527, 1e-7) && near(s.accuracy.lng, 89.283237, 1e-7) && s.accuracy.radius === 12.5);
  assert.match(await B.content(page, 'mapSubtitle'), /world overview/);
});

scenario('projection limit: 85 degrees is plotted, 89.5 north and south stay numeric with a notice', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'gps-lat-85.jpg');
  let s = await B.snapshot(page);
  assert.deepEqual([s.pin.lat, s.pin.lng], [85, 10]);
  for (const [file, lat, lon] of [['gps-near-pole.jpg', '89.50000000', '45.00000000'], ['gps-south-pole.jpg', '-89.50000000', '-45.00000000']]) {
    await B.analyze(page, file);
    assert.equal(await title(page), 'GPS coordinates found');
    assert.equal(await B.content(page, 'latitude'), lat);
    assert.equal(await B.content(page, 'longitude'), lon);
    s = await B.snapshot(page);
    assert.equal(s.pin, null);
    assert.equal(s.mapNotice, 'GPS found near a pole');
    assert.equal(s.coverage, 'GPS / POLAR');
    assert.equal(await enabled(page, 'copyCoordinates'), true);
    assert.equal(await enabled(page, 'exportReport'), true);
    assert.equal(await enabled(page, 'recenter'), false);
    assert.ok(s.camera.zoom < 6, 'the camera did not fly to an unrepresentable place');
  }
});

// Drags the map until its centre longitude is near `target` (circular). Real mouse input, as a person would do it.
async function panNear(page, target) {
  const box = await page.locator('#map').boundingBox();
  for (let i = 0; i < 8; i++) {
    const c = (await B.snapshot(page)).camera;
    const delta = ((target - c.lng + 540) % 360) - 180;          // degrees to travel, east positive
    if (Math.abs(delta) < 4) return c;
    const perDegree = 256 * Math.pow(2, c.zoom) / 360, reach = box.width - 80;       // stay inside the map and the window
    const dx = Math.max(-reach, Math.min(reach, -delta * perDegree));
    const x0 = dx > 0 ? box.x + 40 : box.x + box.width - 40;
    // A start point that is bare map: not under a control, the notice or the coverage panel.
    const y = await page.evaluate(([x, top, height]) => {
      for (const f of [0.5, 0.65, 0.35, 0.8, 0.2]) {
        const e = document.elementFromPoint(x, top + height * f);
        if (e && (e.id === 'map' || e.closest('.leaflet-pane')) && !e.closest('.leaflet-control, button, a, input, select')) return top + height * f;
      }
      return null;
    }, [x0, box.y, box.height]);
    assert.notEqual(y, null, 'found bare map to drag from');
    await page.mouse.move(x0, y); await page.mouse.down(); await page.mouse.move(x0 + dx, y, {steps: 10});
    await B.sleep(150);                                           // hold still before release: no inertia throw
    await page.mouse.up();
    await B.sleep(150);
  }
  return (await B.snapshot(page)).camera;
}
const circular = (a, b) => ((b - a + 540) % 360) - 180;
/** Turns wrapped longitude samples into one continuous track, so a crossing shows as a small step, not a 360 jump. */
function unwrapTrack(samples) {const track = [samples[0]]; for (let i = 1; i < samples.length; i++) track.push(track[i - 1] + circular(samples[i - 1], samples[i])); return track;}

scenario('antimeridian: flights take the short way across, and the pin and camera end on the true longitude', {motion: 'fast'}, async ({page}) => {
  await page.evaluate(() => {window.__lng = []; setInterval(() => window.__lng.push(window.MetaTrace.snapshot().camera.lng), 25);});
  const east = 179 + 59 / 60 + 59.64 / 3600, west = -east;       // +/-179.9999 degrees

  // From a camera about 30 degrees west of the antimeridian, to a point just east of it: the path goes west.
  const startA = await panNear(page, -150);
  assert.ok(Math.abs(circular(-150, startA.lng)) < 6, 'camera positioned near -150 (' + startA.lng.toFixed(1) + ')');
  await page.evaluate(() => {window.__lng = [];});
  await B.analyze(page, 'gps-antimeridian-east.jpg');
  let s = await B.snapshot(page);
  assert.ok(near(s.pin.lng, east) && near(s.camera.lng, east), 'east: pin and camera end on +179.9999');
  assert.ok(near(s.pin.lat, -17.75) && near(s.camera.lat, -17.75));
  let track = unwrapTrack(await page.evaluate(() => window.__lng));
  assert.ok(track.length > 20, 'enough samples (' + track.length + ')');
  const travelled = Math.max(...track) - Math.min(...track);
  assert.ok(travelled < 40, 'the camera moved ' + travelled.toFixed(1) + ' degrees of longitude (the short way is about 30, round the world would be 330)');
  assert.ok(Math.max(...track) < startA.lng + 6 && Math.min(...track) > -181, 'east case stayed between the start and the antimeridian: ' + Math.min(...track).toFixed(2) + '..' + Math.max(...track).toFixed(2));
  assert.ok(Math.min(...track) < -179 || Math.max(...track) > 179, 'the track reached the antimeridian');
  assert.ok(Math.max(...track.slice(1).map((v, i) => Math.abs(v - track[i]))) < 20, 'no jump between consecutive samples');

  // And back: from east of the antimeridian to a point just west of it.
  await page.click('#clear');
  const startB = await panNear(page, 150);
  assert.ok(Math.abs(circular(150, startB.lng)) < 6, 'camera positioned near +150 (' + startB.lng.toFixed(1) + ')');
  await page.evaluate(() => {window.__lng = [];});
  await B.analyze(page, 'gps-antimeridian-west.jpg');
  s = await B.snapshot(page);
  assert.ok(near(s.pin.lng, west) && near(s.camera.lng, west), 'west: pin and camera end on -179.9999');
  assert.ok(Math.abs(s.camera.lng) <= 180 && Math.abs(s.pin.lng) <= 180, 'longitudes are normalised to +/-180');
  track = unwrapTrack(await page.evaluate(() => window.__lng));
  assert.ok(Math.min(...track) > startB.lng - 6 && Math.max(...track) < 181, 'west case stayed between the start and the antimeridian: ' + Math.min(...track).toFixed(2) + '..' + Math.max(...track).toFixed(2));
  assert.ok(Math.max(...track) - Math.min(...track) < 40, 'west: short way, ' + (Math.max(...track) - Math.min(...track)).toFixed(1) + ' degrees');
  assert.equal(s.camera.zoom, 5);
  assert.equal(await B.content(page, 'longitude'), '-179.99990000');
});

scenario('Recenter returns to the exact point after the person pans away, and map input hands control back', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 20, {steps: 8}); await page.mouse.up();
  await B.sleep(300);
  let s = await B.snapshot(page);
  assert.ok(!near(s.camera.lng, LON, 1e-5), 'the map panned away');
  assert.equal(s.pin.lat === undefined, false);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON), 'the pin did not move with the camera');
  await page.click('#recenter');
  await page.waitForFunction(() => {const s = window.MetaTrace.snapshot(); return !s.flying && Math.abs(s.camera.lng - (-82.33788888888889)) < 1e-7;}, null, {timeout: 5000});
  s = await B.snapshot(page);
  assert.ok(near(s.camera.lat, LAT) && near(s.camera.lng, LON) && s.camera.zoom === 18);
  // Interrupting a recenter flight with the mouse stops it where it is.
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 200, {steps: 5}); await page.mouse.up();
  await page.click('#recenter');
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.up();
  await B.sleep(50);
  assert.equal((await B.snapshot(page)).flying, false, 'a click on the map stopped the flight');
});

scenario('the zoom buttons stop a descent in progress', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().flying, null, {timeout: 10000});
  await page.click('#zoomIn');
  assert.equal((await B.snapshot(page)).flying, false);
  await B.waitDone(page);
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT), 'the pin still lands on the true coordinate even though the person took over the camera');
});

scenario('copy puts the exact pair on the clipboard; the export is the report and nothing else', {motion: 'reduced'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  await page.click('#copyCoordinates');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '29.64885278, -82.33788889');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportReport')]);
  assert.equal(download.suggestedFilename(), 'sample-street.jpg.metadata.json');
  const report = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.deepEqual(Object.keys(report).sort(), ['analyzedAt', 'file', 'issues', 'location', 'metadata', 'schemaVersion', 'status', 'summary']);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, 'located');
  assert.ok(near(report.location.latitude, LAT) && near(report.location.longitude, LON));
  assert.equal(report.location.accuracyMeters, 12.5);
  assert.equal(report.file.sha256, B.sha256('sample-street.jpg'));
  assert.equal(report.file.name, 'sample-street.jpg');
  assert.ok(report.metadata.length > 10 && report.metadata.every(m => typeof m.tag === 'string' && typeof m.value === 'string'));
});

scenario('file names are text, never markup', {motion: 'reduced'}, async ({page}) => {
  await page.setInputFiles('#fileInput', {name: '<img src=x onerror=alert(1)>.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(B.fixture('gps-north-west.jpg'))});
  await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Image ready');
  await page.click('#analyze'); await B.waitDone(page);
  assert.equal(await page.locator('#fileName').evaluate(e => e.children.length), 0);
  assert.ok((await B.text(page, 'fileName')).startsWith('<img'));
  assert.equal(await page.locator('#analysisLog img, #fileCard img').count(), 0);
});

scenario('Clear resets everything: pin, readout, preview, map, log and focus', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  await page.click('#clear');
  const s = await B.snapshot(page);
  assert.equal(s.pin, null); assert.equal(s.accuracy, null); assert.equal(s.file, null);
  assert.deepEqual([s.presentation, s.analysis, s.stagePhase], ['idle', 'idle', 'idle']);
  assert.deepEqual([s.camera.lat.toFixed(1), s.camera.zoom], ['20.0', 2.2], 'the map returns to the world view');
  assert.equal(await page.locator('#coordinates').isHidden(), true);
  assert.equal(await page.locator('#fileCard').isHidden(), true);
  assert.equal(await title(page), 'Waiting for an image');
  assert.equal(await page.locator('#preview').getAttribute('src'), null);
  assert.ok(await page.evaluate(() => window.__revoked) > 0, 'the preview object URL was released');
  assert.equal(await enabled(page, 'analyze'), false);
  assert.equal(await page.locator('#bayEmpty').isVisible(), true);
  assert.equal(await page.locator('#analysisLog .log-line').count(), 1);
  assert.equal(await page.locator('#fileInput').inputValue(), '');
});

scenario('choosing another file after a result clears the old result at once', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  await B.choose(page, 'no-gps.jpg');
  const s = await B.snapshot(page);
  assert.equal(s.pin, null); assert.equal(s.accuracy, null); assert.equal(s.location, null);
  assert.equal(await page.locator('#coordinates').isHidden(), true);
  assert.equal(await enabled(page, 'copyCoordinates'), false);
  assert.equal(await enabled(page, 'replay'), false);
  assert.equal(await B.text(page, 'fileName'), 'no-gps.jpg');
  assert.equal(await page.locator('#metadataBody tr').count(), 0);
});

scenario('replay shows the same result again without reading or parsing the file a second time', {motion: 'fast', init: [() => {
  window.__reads = []; window.__workers = 0;
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function () {window.__reads.push(this.size); return original.call(this);};
  const W = window.Worker;
  window.Worker = function (...a) {window.__workers++; return new W(...a);};
}]}, async ({page}) => {
  await B.analyze(page, 'sample-street.jpg');
  const fileSize = fs.statSync(B.fixture('sample-street.jpg')).size;
  const before = await page.evaluate(() => ({reads: window.__reads.filter(n => n > 1000).length, workers: window.__workers, lines: document.querySelectorAll('#analysisLog .log-line').length}));
  assert.deepEqual([before.reads, before.workers], [1, 1], 'one full read and one parse for the analysis (read of ' + fileSize + ' bytes)');
  await page.evaluate(() => {window.__sequence = [];});
  await page.click('#replay');
  assert.equal(await enabled(page, 'replay'), false, 'replay is disabled while it runs');
  assert.equal(await enabled(page, 'analyze'), false);
  await page.waitForFunction(() => document.body.dataset.presentation === 'acquire');
  assert.equal(await page.locator('#coordinates').isHidden(), true, 'the readout is withheld again until it resolves');
  await B.waitDone(page);
  const after = await page.evaluate(() => ({reads: window.__reads.filter(n => n > 1000).length, workers: window.__workers, lines: document.querySelectorAll('#analysisLog .log-line').length}));
  assert.deepEqual(after, before, 'no extra file read, no extra worker, no extra log lines');
  assert.deepEqual((await sequence(page)), ['acquire', 'scan', 'reveal', 'resolve', 'fly', 'lock', 'settled']);
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && near(s.pin.lng, LON) && s.camera.zoom === 18);
  assert.equal(await title(page), 'GPS coordinates found');
  assert.equal(await B.content(page, 'latitude'), '29.64885278');
  assert.equal(await enabled(page, 'exportReport'), true);
});

scenario('replaying a result with no location shows the same message', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, 'no-gps.jpg');
  await page.click('#replay');
  await B.waitDone(page);
  assert.equal(await title(page), 'No location metadata found');
  assert.equal((await B.snapshot(page)).pin, null);
});

scenario('drag and drop select a file; extra files are named in a notice; drops elsewhere do nothing', {motion: 'reduced'}, async ({page}) => {
  const b64 = n => fs.readFileSync(B.fixture(n)).toString('base64');
  await page.evaluate(async ([one, two]) => {
    const mk = (b64, name) => new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, {type: 'image/jpeg'});
    const bay = document.getElementById('bay'), dt = new DataTransfer();
    dt.items.add(mk(one, 'dropped-a.jpg')); dt.items.add(mk(two, 'dropped-b.jpg'));
    bay.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true, cancelable: true}));
    window.__dragging = bay.classList.contains('dragging');
    bay.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    window.__draggingAfter = bay.classList.contains('dragging');
    const outside = new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true});
    document.body.dispatchEvent(outside);
    window.__outsidePrevented = outside.defaultPrevented;
  }, [b64('gps-north-west.jpg'), b64('no-gps.jpg')]);
  assert.deepEqual(await page.evaluate(() => [window.__dragging, window.__draggingAfter, window.__outsidePrevented]), [true, false, true]);
  await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Image ready');
  assert.equal(await B.text(page, 'fileName'), 'dropped-a.jpg', 'the first file is used');
  assert.match(await B.text(page, 'toast'), /first image/);
  await page.click('#analyze'); await B.waitDone(page);
  assert.equal(await title(page), 'GPS coordinates found');
});

scenario('keyboard only: choose, analyze, skip with Escape, and focus never gets lost', {motion: 'full'}, async ({page}) => {
  const order = [];
  for (let i = 0; i < 12; i++) {await page.keyboard.press('Tab'); const id = await page.evaluate(() => document.activeElement.id); order.push(id); if (id === 'chooseButton') break;}
  assert.deepEqual(order, ['soundToggle', 'volume', 'motion', 'fullscreen', 'chooseButton']);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(B.fixture('sample-street.jpg'));
  await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Image ready');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'analyze');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'skip', 'focus follows the action to the Skip control');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  const t0 = Date.now();
  await page.keyboard.press('Escape');
  await B.waitDone(page);
  assert.ok(Date.now() - t0 < 1000, 'Escape finished the presentation at once (' + (Date.now() - t0) + ' ms)');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'replay', 'focus moved to a control that still works');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth);
  assert.match(outline, /^solid 2px/, 'visible keyboard focus ring');
  const s = await B.snapshot(page);
  assert.ok(near(s.pin.lat, LAT) && s.camera.zoom === 18);
  // Decorative layers are hidden from assistive technology; the readout and live regions are not.
  assert.equal(await page.locator('#scanCanvas').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#ticker').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#latitudeFx').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#latitude').getAttribute('aria-hidden'), null);
  assert.match(await B.content(page, 'announce'), /GPS coordinates found\. Latitude 29\.64885278, longitude -82\.33788889\./);
});

scenario('clean view hides the instrument layers but never the file name, outcome or controls', {motion: 'fast'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#cleanView');
  assert.equal(await page.locator('#cleanView').getAttribute('aria-pressed'), 'true');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  for (const id of ['fileName', 'statusTitle', 'skip']) assert.equal(await page.locator('#' + id).isVisible(), true, id + ' stays visible');
  assert.equal(await page.locator('#scanCanvas').evaluate(e => getComputedStyle(e).opacity), '0');
  await B.waitDone(page);
  await page.click('#cleanView');
  assert.equal(await page.locator('#cleanView').getAttribute('aria-pressed'), 'false');
});

scenario('the file name, the outcome and the controls are visible in every presentation state', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.evaluate(() => {
    window.__audit = new Set();
    const visible = id => {const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight;};
    setInterval(() => {
      const state = document.body.dataset.presentation;
      for (const id of ['fileName', 'statusTitle', 'statusMessage', 'skip', 'clear', 'changeImage']) if (!visible(id)) window.__audit.add(state + ':' + id);
    }, 60);
  });
  await page.click('#analyze');
  await B.waitDone(page, 30000);
  assert.deepEqual(await page.evaluate(() => [...window.__audit]), []);
});

for (const [motion, via] of [['fast', 'run'], ['full', 'skip'], ['full', 'run']]) {
  scenario('after a street-scale result, a file with nothing to plot leaves the camera at rest on the wide view (' + motion + ' motion, ' + via + ')', {motion}, async ({page}) => {
    await B.analyze(page, 'sample-street.jpg', {wait: false});
    if (motion === 'full') await page.click('#skip');
    await B.waitDone(page, 30000);
    assert.equal((await B.snapshot(page)).camera.zoom, 18);
    for (const file of ['no-gps.jpg', 'conflicting-gps.jpg', 'gps-near-pole.jpg']) {
      await B.choose(page, file);
      await page.click('#analyze');
      if (via === 'skip') {await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan'); await B.sleep(200); await page.click('#skip');}
      await B.waitDone(page, 30000);
      const s = await B.snapshot(page);
      assert.equal(s.flying, false, file + ': no move in progress');
      assert.equal(s.camera.zoom, 3, file + ': at rest on the wide view, not mid-zoom and not on the old street (' + s.camera.zoom + ')');
      assert.equal(s.pin, null);
      await B.sleep(250);
      assert.deepEqual((await B.snapshot(page)).camera, s.camera, file + ': and it stays there');
    }
    await B.choose(page, 'corrupt.tiff');
    await page.click('#analyze');
    await B.waitDone(page);
    assert.equal((await B.snapshot(page)).camera.zoom, 3, 'a read failure also leaves the wide view');
    // Replaying a no-location result keeps it there too.
    await B.analyze(page, 'no-gps.jpg');
    await page.click('#replay'); await B.waitDone(page, 30000);
    assert.equal((await B.snapshot(page)).camera.zoom, 3);
  });
}

const logText = page => page.locator('#analysisLog').innerText();
const logMs = async (page, needle) => {
  const lines = await page.locator('#analysisLog .log-line').evaluateAll(els => els.map(e => [e.children[0].textContent, e.children[1].textContent]));
  const hit = lines.find(([, text]) => text.includes(needle));
  assert.ok(hit, 'a log line containing "' + needle + '"');
  const m = hit[0].match(/^\+([\d.]+) (ms|s)$/); assert.ok(m, 'a real offset label, got ' + hit[0]);
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
};

scenario('the analysis log does not announce the result before the screen does, and its times stay the real ones', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  await B.sleep(250);
  let log = await logText(page);
  assert.match(log, /Reading sample-street\.jpg/);
  assert.match(log, /SHA-256 calculated/);
  assert.doesNotMatch(log, /GPSLatitude|GPSLongitude|29\.6488|82\.3378|Analysis complete|metadata tags read/, 'no result in the log during the scan');
  assert.equal(await B.text(page, 'elapsed'), '…');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Reading the selected image.');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'reveal');
  await B.sleep(100);
  log = await logText(page);
  assert.match(log, /19 metadata tags read\./);
  assert.match(log, /GPSLatitude: 29\.64885278/);
  assert.match(log, /Analysis complete\./);
  assert.match(await B.text(page, 'elapsed'), /^\d+ ms$/);
  const analysisMs = await logMs(page, 'Analysis complete.');
  assert.ok(analysisMs < 800, 'the line shows when the analysis really finished (' + analysisMs + ' ms), not when it appeared (about 1.2 s into the show)');
  assert.equal(Number((await B.text(page, 'elapsed')).replace(' ms', '')) <= analysisMs + 5, true);
  await B.waitDone(page, 30000);
  assert.match(await logText(page), /GPS marker placed on the local street map/);
});

scenario('Skip releases the held log lines at once, and a failure releases nothing it should not', {motion: 'full'}, async ({page}) => {
  await B.choose(page, 'sample-street.jpg');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  assert.doesNotMatch(await logText(page), /Analysis complete/);
  await page.click('#skip');
  await B.waitDone(page, 5000);
  const log = await logText(page);
  assert.match(log, /GPSLongitude: -82\.33788889/);
  assert.match(log, /Analysis complete\./);
  assert.match(await B.text(page, 'elapsed'), /^\d+ ms$/);
  await B.analyze(page, 'corrupt.tiff');
  assert.doesNotMatch(await logText(page), /Analysis complete/, 'a failed read never claims completion');
  assert.match(await logText(page), /Detected format|Parsing EXIF/);
});

scenario('the map heading says what is happening at each step', {motion: 'full'}, async ({page}) => {
  assert.equal(await B.text(page, 'mapSubtitle'), 'Select an image to locate its GPS tags.');
  await B.choose(page, 'sample-street.jpg');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Select Analyze to read this image.');
  await page.click('#analyze');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'scan');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Reading the selected image.');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'resolve');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Locating the embedded GPS position.');
  await B.waitDone(page, 30000);
  assert.match(await B.text(page, 'mapSubtitle'), /Detailed offline street geometry/);
  await page.click('#replay');
  await page.waitForFunction(() => window.MetaTrace.snapshot().presentation === 'acquire' || window.MetaTrace.snapshot().presentation === 'scan');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Showing the saved result again.');
  await B.waitDone(page, 30000);
  await page.click('#clear');
  assert.equal(await B.text(page, 'mapSubtitle'), 'Select an image to locate its GPS tags.');
});

scenario('the fullscreen button either enters fullscreen or says what to do instead, and the page keeps working', {motion: 'reduced'}, async ({page}) => {
  await page.click('#fullscreen');
  await B.sleep(400);
  const entered = await page.evaluate(() => !!document.fullscreenElement);
  if (!entered) assert.match(await B.text(page, 'toast'), /fullscreen/i, 'refused fullscreen is explained');
  else {await page.click('#fullscreen'); await B.sleep(300); assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, 'a second press leaves fullscreen');}
  await B.analyze(page, 'sample-street.jpg');
  assert.equal(await title(page), 'GPS coordinates found');
});

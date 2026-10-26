// Optional regional map packages, in a real browser (Chromium via Playwright), against the built single-file app.
//
// The packages are synthetic (tests/helpers/test-package.cjs): real PMTiles bytes holding gzip vector tiles in the Protomaps layer
// vocabulary, laid over the places of the fixtures as a street grid. They prove the loader, the cache, the drawing, the coverage
// messages and the offline guarantees. They are test patterns, not maps, and the app says so when one is installed.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./helpers/browser.cjs');
const {makeSyntheticPackage} = require('./helpers/test-package.cjs');
const PM = require('./helpers/pmtiles-writer.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');

const isLocal = url => /^(file:|blob:|data:|about:)/.test(url);
test.after(async () => {await B.closeBrowser();});

/** `allow` lists console messages a scenario provokes on purpose; anything else is a failure. */
function scenario(name, options, fn) {
  if (typeof options === 'function') {fn = options; options = {};}
  const {allow, ...openOptions} = options;
  test(name, async t => {
    const browser = await B.getBrowser();
    if (!browser) return t.skip(B.reason());
    const app = await B.openApp(browser, openOptions);
    try {
      await fn(app, t);
      assert.deepEqual(app.problems.filter(p => !(allow && allow.test(p))), [], 'console errors or warnings');
      assert.deepEqual(app.requests.filter(u => !isLocal(u)), [], 'requests outside the local file');
      assert.deepEqual(app.dialogs, [], 'unexpected dialogs');
    } finally {await app.close();}
  });
}

/* ---------------------------------------------------------------- packages -------------------------------------------- */

const SYDNEY = {lat: -(33 + 51 / 60 + 24.48 / 3600), lon: 151 + 12 / 60 + 55.08 / 3600, bounds: [151.17, -33.89, 151.26, -33.82], file: 'gps-sydney.jpg'};
const QUITO = {lat: -(10 / 60 + 48 / 3600), lon: -(78 + 28 / 60 + 12 / 3600), bounds: [-78.52, -0.23, -78.42, -0.13], file: 'gps-quito.jpg'};
const GAINESVILLE = {lat: 29 + 38 / 60 + 55.87 / 3600, lon: -(82 + 20 / 60 + 16.4 / 3600), bounds: [-82.40, 29.60, -82.28, 29.70], file: 'gps-north-west.jpg'};
const ANTI_E = {lat: -17.75, lon: 179 + 59 / 60 + 59.64 / 3600, bounds: [179.9, -17.85, 180, -17.65], file: 'gps-antimeridian-east.jpg'};
const ANTI_W = {lat: -17.75, lon: -(179 + 59 / 60 + 59.64 / 3600), bounds: [-180, -17.85, -179.9, -17.65], file: 'gps-antimeridian-west.jpg'};
const made = new Map();
function pkg(place, options = {}) {
  const key = JSON.stringify([place.bounds, options]);
  if (!made.has(key)) made.set(key, makeSyntheticPackage({bounds: place.bounds, minZoom: 9, maxZoom: 15, name: options.name || 'Test pattern ' + place.file.replace(/^gps-|\.jpg$/g, ''), ...options}));
  return made.get(key);
}
const input = (p, name = 'test.pmtiles') => ({name, mimeType: 'application/octet-stream', buffer: Buffer.from(p.bytes || p)});

/** Opens the dialog, adds a package through the real file input, waits for the verdict, and closes the dialog again. */
async function install(page, p, {name, keep, close = true} = {}) {
  await page.click('#mapData');
  if (keep !== undefined) await page.setChecked('#mapDataKeep', keep);
  await page.setInputFiles('#mapDataFile', input(p, name));
  await page.waitForFunction(() => {const e = document.getElementById('mapDataStatus'); return e.dataset.kind && !/^Reading/.test(e.textContent);}, null, {timeout: 20000});
  const verdict = {kind: await page.getAttribute('#mapDataStatus', 'data-kind'), text: await page.innerText('#mapDataStatus')};
  if (close) await page.click('#mapDataClose');
  return verdict;
}
const regionsIdle = page => page.waitForFunction(() => {const r = window.MetaTrace.snapshot().regions; return r.active === 0 && r.queued === 0;}, null, {timeout: 20000});
const covered = page => page.evaluate(() => {
  const f = document.getElementById('frame5').getBoundingClientRect(), bad = [];
  const pts = {centre: [f.x + f.width / 2, f.y + f.height / 2], nw: [f.x + 4, f.y + 4], ne: [f.right - 4, f.y + 4], sw: [f.x + 4, f.bottom - 4], se: [f.right - 4, f.bottom - 4]};
  for (const [k, [x, y]] of Object.entries(pts)) {
    const e = document.elementFromPoint(x, y);
    if (!(e && (e.id === 'globeCanvas' || e.id === 'map' || e.closest('#map')))) bad.push(k + ': ' + (e ? (e.id || e.className || e.tagName) : 'nothing'));
  }
  return bad;
});
/** Pixels the street layer drew that are bright enough to be linework (not land fill), over the whole canvas or one half of it. */
const linework = (page, half) => page.evaluate(h => {
  const c = document.querySelector('#map canvas.trace-canvas'), {width, height} = c;
  const copy = document.createElement('canvas');
  copy.width = width; copy.height = height;
  const g = copy.getContext('2d', {willReadFrequently: true});
  g.drawImage(c, 0, 0);
  const x0 = h === 'left' ? 0 : h === 'right' ? Math.floor(width / 2) : 0, x1 = h === 'left' ? Math.floor(width / 2) : width;
  const d = g.getImageData(x0, 0, x1 - x0, height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] >= 60) n++;
  return n;
}, half);
/**
 * The same count once the picture has stopped changing. Names are chosen on a short timer after the view or the tiles change, so a
 * count taken straight after a flight can come before them; two equal reads 350 ms apart mean the layer has settled.
 */
const settledLinework = async (page, half) => {
  let last = await linework(page, half);
  for (let i = 0; i < 20; i++) {
    await B.sleep(350);
    const now = await linework(page, half);
    if (now === last) return now;
    last = now;
  }
  return last;
};
/** Hands the Leaflet map to the test, for scripted tours that no person could do by hand. */
const leafletHook = () => {
  let held;
  Object.defineProperty(window, 'L', {configurable: true, enumerable: true, get: () => held, set: v => {held = v; if (v && v.Map && v.Map.addInitHook) v.Map.addInitHook(function () {window.__leafletMap = this;});}});
};
const BASELINE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/* ============================================================== the dialog ====================================== */

scenario('the Map data dialog lists what is built in, is operable from the keyboard, and the page policy is unchanged', {motion: 'reduced'}, async ({page}) => {
  const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  assert.equal(policy, BASELINE_CSP, 'the offline policy is byte for byte what it was (connect-src stays none)');
  const violations = await page.evaluate(() => {window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective)); return true;});
  assert.ok(violations);

  await page.focus('#mapData');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.getElementById('mapDataDialog').open), true, 'Enter on the control opens the dialog');
  const body = await page.innerText('#mapDataDialog');
  assert.match(body, /World outlines and reference cities/);
  assert.match(body, /Gainesville, Florida streets and buildings/);
  assert.match(body, /Natural Earth/);
  assert.match(body, /OpenStreetMap contributors/);
  assert.equal(await page.isVisible('#mapDataEmpty'), true, 'with nothing added the dialog says how to add a package');
  assert.equal(await page.evaluate(() => document.getElementById('mapDataKeep').checked), true, 'a copy is kept by default when the browser offers storage');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('mapDataDialog').open), false, 'Escape closes it');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'mapData', 'focus returns to the control that opened it');

  const verdict = await install(page, pkg(SYDNEY), {name: 'sydney.pmtiles'});
  assert.equal(verdict.kind, 'ok');
  assert.match(verdict.text, /Added "Test pattern sydney"/);
  assert.match(verdict.text, /generated test pattern, not a map/);
  const s = await B.snapshot(page);
  assert.equal(s.regions.packages.length, 1);
  assert.deepEqual(s.regions.packages[0].bounds, SYDNEY.bounds);
  assert.match(await page.innerText('#coverageNote'), /Added map data: Test pattern sydney/, 'the idle note names what was added');
  await page.click('#mapData');
  assert.match(await page.innerText('#mapDataList'), /Test pattern sydney[\s\S]*Test pattern, not a real map/);
  assert.equal(await page.isVisible('#mapDataEmpty'), false);
  await page.click('#mapDataClose');
  assert.deepEqual(await page.evaluate(() => window.__csp), [], 'no policy violations were reported');
});

scenario('files that are not usable map packages are refused with a reason, and nothing is added', {motion: 'reduced'}, async ({page}) => {
  const good = Buffer.from(pkg(SYDNEY).bytes);
  const patched = (offset, value) => {const b = Buffer.from(good); b[offset] = value; return b;};
  const cases = [
    ['not a PMTiles file at all', Buffer.alloc(400, 0x41), /not a PMTiles file/i],
    ['too short to have a header', good.subarray(0, 100), /too short/i],
    ['an old PMTiles version', patched(7, 2), /version 2/],
    ['raster tiles instead of vector tiles', patched(99, 2), /not vector/i],
    ['layers this map does not draw', makeSyntheticPackage({bounds: SYDNEY.bounds, extra: {vector_layers: [{id: 'contours'}, {id: 'hillshade'}]}}).bytes, /contours, hillshade/]
  ];
  for (const [label, buffer, expected] of cases) {
    const verdict = await install(page, buffer, {name: label.replace(/\W+/g, '-') + '.pmtiles'});
    assert.equal(verdict.kind, 'error', label);
    assert.match(verdict.text, /was not added/, label);
    assert.match(verdict.text, expected, label);
  }
  const s = await B.snapshot(page);
  assert.equal(s.regions.packages.length, 0, 'nothing was installed');
  assert.equal(s.mapData.listed, 0);
  await page.click('#mapData');
  assert.equal(await page.isVisible('#mapDataEmpty'), true);
  await page.click('#mapDataClose');
});

/* ============================================================== drawing ========================================= */

scenario('a package added while a result is on screen draws its streets and updates the coverage; removing it takes them away', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, SYDNEY.file);
  const control = await B.snapshot(page);
  assert.equal(control.coverage, 'OFFLINE / OUTLINES');
  assert.match(await page.innerText('#coverageNote'), /No offline roads or buildings are installed for this area/);
  assert.equal(await page.isVisible('#coverageAdd'), true, 'the note offers to add map data');
  const before = await settledLinework(page);

  const verdict = await install(page, pkg(SYDNEY));
  assert.equal(verdict.kind, 'ok');
  await regionsIdle(page);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles > 0);
  const s = await B.snapshot(page);
  assert.equal(s.coverage, 'OFFLINE / STREETS');
  assert.match(await page.innerText('#coverageNote'), /Generated test pattern, not a map of this place\./);
  assert.match(await page.innerText('#mapSubtitle'), /Five-mile view with streets from "Test pattern sydney"/);
  assert.equal(await page.isVisible('#coverageAdd'), false);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionLabels > 0, null, {timeout: 5000});
  assert.ok((await B.snapshot(page)).layer.regionLabels > 0, 'names from the package\'s tiles are placed on the map');
  const after = await settledLinework(page);
  assert.ok(after > before + 1500, 'the street layer drew ' + (after - before) + ' more linework pixels than without the package (' + before + ' to ' + after + ')');
  await B.expectFrame(page, SYDNEY.lat, SYDNEY.lon, 'with the package: ', {renderer: 'map'});
  assert.equal(s.regions.errors, 0);
  assert.equal(s.regions.failed, 0);

  // Removing it: the picture and the message go back, and the file on disk was never ours to touch.
  await page.click('#mapData');
  await page.click('#mapDataList button:has-text("Remove")');
  await page.waitForFunction(() => /^Removed/.test(document.getElementById('mapDataStatus').textContent));
  assert.match(await page.innerText('#mapDataStatus'), /Removed "Test pattern sydney"\. Your file on disk was not touched\./);
  await page.click('#mapDataClose');
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles === 0);
  const gone = await B.snapshot(page);
  assert.equal(gone.regions.packages.length, 0);
  assert.equal(gone.coverage, 'OFFLINE / OUTLINES');
  assert.equal(await settledLinework(page), before, 'the street layer is back to what it drew without the package');
  assert.equal(gone.regions.tiles, 0, 'its tiles were dropped from the cache');
});

scenario('with a package installed the whole choreography is unchanged, and its tiles are in before the map takes over', {motion: 'full', viewport: {width: 1440, height: 900}}, async ({page}) => {
  await install(page, pkg(SYDNEY));
  await B.choose(page, SYDNEY.file);
  await B.startTrace(page);
  await page.click('#analyze');
  await B.waitDone(page, 40000);
  const trace = await B.readTrace(page), final = await B.snapshot(page);
  const run = trace.filter(s => s.running), u = B.unwrapped(run);
  const sweep = u[0] - u[u.length - 1];
  assert.ok(sweep >= 360, 'the camera still swept ' + sweep.toFixed(1) + ' degrees of longitude');
  const firstMap = run.find(s => s.view === 'map');
  assert.ok(firstMap, 'the flat map took over');
  assert.ok(firstMap.rready > 0, 'tiles were already loaded when the map appeared (' + firstMap.rready + ' ready); they were requested while the globe turned');
  assert.ok(final.layer.regionTiles > 0);
  await regionsIdle(page);
  await B.expectFrame(page, SYDNEY.lat, SYDNEY.lon, 'full sequence: ', {renderer: 'map'});
  assert.deepEqual(await covered(page), []);
  assert.equal(final.pin.popupOpen, true);
  const settled = await B.snapshot(page);
  B.record('regions-sequence.json', {environment: 'headless Chromium, software rasterisation, 1440x900', package: {bytes: pkg(SYDNEY).bytes.length, tiles: pkg(SYDNEY).tiles}, sweepDegrees: +sweep.toFixed(1), tilesReadyAtHandOff: firstMap.rready, frames: B.intervals(run), mapFrames: B.intervals(run.filter(s => s.view === 'map')), regions: settled.regions, layer: settled.layer});
});

scenario('a package that covers the point only on paper says that nothing is drawn there', {motion: 'fast'}, async ({page}) => {
  // Data only about ten kilometres west of the point, in a box that the header claims is much larger.
  const sparse = makeSyntheticPackage({bounds: [151.10, -33.93, 151.12, -33.91], minZoom: 9, maxZoom: 15, name: 'Sparse test pattern'});
  const bytes = Buffer.from(sparse.bytes), wide = [151.05, -33.95, 151.35, -33.78];
  [wide[0], wide[1], wide[2], wide[3]].forEach((v, i) => bytes.writeInt32LE(Math.round(v * 1e7), 102 + 4 * i));
  assert.equal((await install(page, bytes, {name: 'sparse.pmtiles'})).kind, 'ok');
  await B.analyze(page, SYDNEY.file);
  await regionsIdle(page);
  await page.waitForFunction(() => /no map features in this frame/.test(document.getElementById('coverageNote').textContent), null, {timeout: 10000});
  assert.match(await page.innerText('#coverageNote'), /"Sparse test pattern" covers this area on paper but has no map features in this frame/);
  assert.equal((await B.snapshot(page)).coverage, 'OFFLINE / OUTLINES');
  assert.equal(await page.isVisible('#coverageAdd'), true);
  await B.expectFrame(page, SYDNEY.lat, SYDNEY.lon, 'sparse package: ', {renderer: 'map'});
});

scenario('outside every package the note says so, offers the dialog, and focus comes back to the control', {motion: 'fast'}, async ({page}) => {
  await install(page, pkg(SYDNEY));
  await B.analyze(page, QUITO.file);
  const s = await B.snapshot(page);
  assert.equal(s.coverage, 'OFFLINE / OUTLINES');
  assert.match(await page.innerText('#coverageNote'), /No offline roads or buildings are installed for this area/);
  assert.equal(s.layer.regionTiles, 0, 'no tile of the Sydney package is asked for in Quito');
  await page.click('#coverageAdd');
  assert.equal(await page.evaluate(() => document.getElementById('mapDataDialog').open), true, 'the action opens the dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'coverageAdd', 'focus returns to the button that opened the dialog');
  await B.expectFrame(page, QUITO.lat, QUITO.lon, 'Quito: ', {renderer: 'map'});
});

scenario('a bundled-data place gives way to a package that is detailed enough, and not to one that is coarse', {motion: 'fast'}, async ({page}) => {
  await B.analyze(page, GAINESVILLE.file);
  let s = await B.snapshot(page);
  assert.equal(s.layer.superseded, false);
  assert.match(await page.innerText('#coverageNote'), /12,671 local map features/);

  await install(page, pkg(GAINESVILLE, {minZoom: 9, maxZoom: 12, name: 'Coarse test pattern'}));
  await regionsIdle(page);
  s = await B.snapshot(page);
  assert.equal(s.layer.superseded, false, 'a package that stops at zoom 12 does not replace the bundled streets');
  assert.match(await page.innerText('#coverageNote'), /"Coarse test pattern" is coarse here \(zoom 12 at most\)/);

  await install(page, pkg(GAINESVILLE, {name: 'Detailed test pattern'}));
  await regionsIdle(page);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.superseded === true);
  assert.match(await page.innerText('#coverageNote'), /Generated test pattern/);
  assert.match(await page.innerText('#mapSubtitle'), /Detailed test pattern/);
});

/* ============================================================== places ========================================== */

scenario('packages at both hemispheres, the equator and either side of the antimeridian: centred five-mile frames with the package drawn', {motion: 'fast'}, async ({page}) => {
  for (const place of [SYDNEY, QUITO, GAINESVILLE, ANTI_E, ANTI_W]) assert.equal((await install(page, pkg(place), {name: place.file + '.pmtiles'})).kind, 'ok', place.file);
  const rows = [];
  for (const place of [SYDNEY, QUITO, GAINESVILLE, ANTI_E, ANTI_W]) {
    await B.analyze(page, place.file);
    await regionsIdle(page);
    await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles > 0);
    const s = await B.snapshot(page);
    assert.equal(s.coverage, 'OFFLINE / STREETS', place.file);
    const m = await B.expectFrame(page, place.lat, place.lon, place.file + ': ', {renderer: 'map'});
    assert.deepEqual(await covered(page), [], place.file);
    assert.equal(s.regions.failed, 0, place.file);
    const left = await linework(page, 'left'), right = await linework(page, 'right');
    assert.ok(left > 800 && right > 800, place.file + ': streets on both halves of the view (' + left + ' left, ' + right + ' right)');
    rows.push({file: place.file, tiles: s.layer.regionTiles, widthMiles: +m.widthMiles.toFixed(4), heightMiles: +m.heightMiles.toFixed(4)});
  }
  B.record('regions-places.json', {note: 'synthetic packages laid over each fixture place; frame measured from outside the app', rows});
});

/* ============================================================== keeping and forgetting ========================= */

scenario('a kept copy survives a reload; a visit-only package does not; removing forgets both', {motion: 'reduced'}, async ({page}) => {
  await install(page, pkg(SYDNEY), {keep: true, name: 'kept.pmtiles'});
  await install(page, pkg(QUITO), {keep: false, name: 'visit.pmtiles'});
  await page.click('#mapData');
  const flags = await page.locator('#mapDataList .data-flag').allInnerTexts();
  assert.ok(flags.includes('Saved in this browser') && flags.includes('This visit only'), flags.join(' / '));
  await page.click('#mapDataClose');

  await page.reload();
  await page.waitForFunction(() => window.MetaTrace && window.MetaTrace.snapshot().mapData.restored);
  let s = await B.snapshot(page);
  assert.deepEqual(s.regions.packages.map(p => p.name), ['Test pattern sydney'], 'only the kept copy came back');
  assert.equal(s.mapData.faults.length, 0);
  assert.match(await page.innerText('#coverageNote'), /Added map data: Test pattern sydney/);
  await B.analyze(page, SYDNEY.file);
  await regionsIdle(page);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles > 0);
  assert.equal((await B.snapshot(page)).coverage, 'OFFLINE / STREETS', 'and it draws after the reload, read from the browser\'s copy');

  await page.click('#mapData');
  await page.click('#mapDataList button:has-text("Remove")');
  await page.click('#mapDataClose');
  await page.reload();
  await page.waitForFunction(() => window.MetaTrace && window.MetaTrace.snapshot().mapData.restored);
  s = await B.snapshot(page);
  assert.equal(s.regions.packages.length, 0, 'removing it also removed the saved copy');
  assert.equal(s.mapData.listed, 0);
});

scenario('without browser storage packages work for this visit only, and the dialog says so', {motion: 'reduced', init: [() => {Object.defineProperty(window, 'indexedDB', {configurable: true, get: () => undefined});}]}, async ({page}) => {
  await page.click('#mapData');
  assert.equal(await page.isDisabled('#mapDataKeep'), true);
  assert.match(await page.innerText('#mapDataKeepText'), /this visit only/);
  assert.match(await page.innerText('#mapDataStorage'), /persistent storage/);
  await page.click('#mapDataClose');
  assert.equal((await install(page, pkg(SYDNEY))).kind, 'ok');
  await B.analyze(page, SYDNEY.file);
  await regionsIdle(page);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles > 0);
  assert.equal((await B.snapshot(page)).mapData.persistent, false);
});

/* ============================================================== limits and failures ============================= */

scenario('a long tour of a large package stays inside the cache limits and the heap stays flat', {motion: 'reduced', init: [leafletHook], viewport: {width: 1280, height: 800}}, async ({page}) => {
  const big = makeSyntheticPackage({bounds: [150.9, -34.2, 151.4, -33.7], minZoom: 9, maxZoom: 15, name: 'Large test pattern'});
  assert.equal((await install(page, big, {name: 'large.pmtiles'})).kind, 'ok');
  await B.analyze(page, SYDNEY.file);
  await regionsIdle(page);
  const heap0 = await B.heap(page);
  // A scripted tour no hand could do: 520 views at the finest zoom, in a lattice across the whole package, waiting for the tiles each time.
  const tour = await page.evaluate(async () => {
    const map = window.__leafletMap, samples = [];
    let steps = 0, maxMs = 0, sumMs = 0, draws = 0;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 26; col++) {
        const lat = -34.15 + row * 0.0245, lon = 150.95 + col * 0.0172;
        map.setView([lat, lon], 15, {animate: false});
        await new Promise(r => setTimeout(r, 12));
        steps++;
        const s = window.MetaTrace.snapshot();
        maxMs = Math.max(maxMs, s.layer.regionMs); sumMs += s.layer.regionMs; draws++;
        if (steps % 52 === 0) samples.push({tiles: s.regions.tiles, bytes: s.regions.bytes, evicted: s.regions.evicted});
      }
    }
    return {steps, samples, maxRegionMs: maxMs, meanRegionMs: sumMs / draws};
  });
  await regionsIdle(page);
  const s = await B.snapshot(page), heap1 = await B.heap(page);
  assert.equal(tour.steps, 520);
  assert.ok(s.regions.loaded > 400, 'the tour loaded ' + s.regions.loaded + ' tiles');
  assert.ok(s.regions.evicted > 100, 'older tiles were evicted (' + s.regions.evicted + ')');
  for (const x of tour.samples) assert.ok(x.tiles <= s.regions.maxTiles && x.bytes <= s.regions.maxBytes, 'inside the budget at every sample: ' + JSON.stringify(x));
  assert.ok(s.regions.tiles <= s.regions.maxTiles && s.regions.bytes <= s.regions.maxBytes);
  assert.equal(s.regions.failed, 0);
  assert.ok(heap1.jsHeapUsedMB - heap0.jsHeapUsedMB < 60, 'heap grew by ' + (heap1.jsHeapUsedMB - heap0.jsHeapUsedMB).toFixed(1) + ' MB over the tour');
  B.record('regions-tour.json', {environment: 'headless Chromium, software rasterisation, 1280x800', package: {bytes: big.bytes.length, tiles: big.tiles, features: big.features}, views: tour.steps, loaded: s.regions.loaded, evicted: s.regions.evicted, tilesInCache: s.regions.tiles, cacheBytes: s.regions.bytes, bytesReadFromFile: s.regions.tileBytesRead, decodeMsTotal: +s.regions.decodeMs.toFixed(1), adaptMsTotal: +s.regions.adaptMs.toFixed(1), maxTileLoadMs: +s.regions.maxLoadMs.toFixed(1), regionDrawMs: {mean: +tour.meanRegionMs.toFixed(2), max: +tour.maxRegionMs.toFixed(2)}, heapMB: {before: heap0.jsHeapUsedMB, after: heap1.jsHeapUsedMB}});
});

scenario('unreadable tiles are counted and skipped; the readable ones still draw and the sequence completes', {motion: 'fast', allow: /^error:/}, async ({page}) => {
  // Half of the tiles at the zoom levels the final view uses hold text instead of a vector tile; the rest are intact.
  const p = pkg(SYDNEY);
  const list = p.list.map(t => (t.z === 12 || t.z === 13) && (t.x + t.y) % 2 === 0 ? {...t, data: Buffer.from('this is not a vector tile')} : t);
  const bytes = PM.build(list, {bounds: SYDNEY.bounds, metadata: p.metadata, tileCompression: 2, internalCompression: 2});
  assert.equal((await install(page, bytes, {name: 'damaged.pmtiles'})).kind, 'ok', 'the header and directories are fine, so it installs');
  await B.analyze(page, SYDNEY.file);
  await regionsIdle(page);
  const s = await B.snapshot(page);
  assert.ok(s.regions.failed > 0, 'damaged tiles were counted (' + s.regions.failed + ')');
  assert.ok(s.regions.ready > 0, 'intact tiles were still read (' + s.regions.ready + ')');
  assert.equal(s.presentation, 'settled', 'the sequence completed');
  await B.expectFrame(page, SYDNEY.lat, SYDNEY.lon, 'damaged package: ', {renderer: 'map'});
});

/* ============================================================== interrupting ==================================== */

scenario('Skip, Clear and a replacement during the revolution and the descent leave nothing half-loaded', {motion: 'full'}, async ({page}) => {
  await install(page, pkg(SYDNEY));
  const waitPhase = (phase, timeout = 30000) => page.waitForFunction(p => {const q = window.MetaTrace.snapshot().sequence; return q.running && q.phase === p;}, phase, {timeout});

  await B.choose(page, SYDNEY.file);
  await page.click('#analyze');
  await waitPhase('descend');
  await page.click('#skip');
  await B.waitDone(page, 20000);
  await regionsIdle(page);
  await B.expectFrame(page, SYDNEY.lat, SYDNEY.lon, 'Skip in the descent: ', {renderer: 'map'});
  assert.ok((await B.snapshot(page)).layer.regionTiles > 0, 'Skip lands on a view with the package drawn');

  await page.click('#clear');
  await B.choose(page, SYDNEY.file);
  await page.click('#analyze');
  await waitPhase('spin');
  await page.click('#clear');
  await page.waitForFunction(() => !window.MetaTrace.snapshot().sequence.running);
  await regionsIdle(page);
  let s = await B.snapshot(page);
  assert.equal(s.regions.active, 0);
  assert.equal(s.regions.errors, 0);

  await B.choose(page, SYDNEY.file);
  await page.click('#analyze');
  await waitPhase('descend');
  await B.choose(page, QUITO.file);                                  // a replacement while the descent is under way
  await page.click('#analyze');
  await B.waitDone(page, 40000);
  await regionsIdle(page);
  s = await B.snapshot(page);
  await B.expectFrame(page, QUITO.lat, QUITO.lon, 'replacement: ', {renderer: 'map'});
  assert.equal(s.coverage, 'OFFLINE / OUTLINES', 'the replacement is outside the package and says so');
  assert.equal(s.regions.errors, 0);
});

/* ============================================================== layouts ========================================= */

for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
  scenario('the Map data control is reachable and the dialog fits at ' + width + ' x ' + height, {motion: 'reduced', viewport: {width, height}}, async ({page}) => {
    await page.locator('#mapData').scrollIntoViewIfNeeded();
    const box = await page.evaluate(() => {
      const b = document.getElementById('mapData').getBoundingClientRect(), p = document.querySelector('.map-panel').getBoundingClientRect(), e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return {x: b.x, y: b.y, w: b.width, h: b.height, panel: {x: p.x, y: p.y, w: p.width, h: p.height}, topmost: e && (e.id || e.closest('button') && e.closest('button').id)};
    });
    assert.ok(box.x >= box.panel.x && box.x + box.w <= box.panel.x + box.panel.w, 'inside the pane horizontally');
    assert.ok(box.y >= box.panel.y && box.y + box.h <= box.panel.y + box.panel.h, 'inside the pane vertically');
    assert.equal(box.topmost, 'mapData', 'and nothing covers it');
    await install(page, pkg(SYDNEY), {close: false});
    const dlg = await page.evaluate(() => {const r = document.getElementById('mapDataDialog').getBoundingClientRect(); return {x: r.x, y: r.y, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, scrolls: document.getElementById('mapDataDialog').scrollHeight > document.getElementById('mapDataDialog').clientHeight};});
    assert.ok(dlg.x >= 0 && dlg.r <= dlg.vw && dlg.y >= 0 && dlg.b <= dlg.vh, 'the dialog is inside the window: ' + JSON.stringify(dlg));
    await page.locator('#mapDataList button:has-text("Remove")').scrollIntoViewIfNeeded();
    assert.equal(await page.isVisible('#mapDataList button:has-text("Remove")'), true, 'its buttons can be reached');
    await page.click('#mapDataClose');
  });
}

/* ============================================================== the converter, end to end ====================== */

/** Labels are text and differ by design (the package names roads and buildings from its tiles; the bundled labels come from a separate file), so the geometry comparison runs without them. */
const noLabelsHook = () => {
  let held;
  Object.defineProperty(window, 'MapUtils', {configurable: true, enumerable: true, get: () => held, set: v => {held = v && Object.assign(v, {selectLabels: () => []});}});
};
scenario('the bundled Gainesville data, converted to a package, draws the same picture as the bundled renderer does', {motion: 'fast', init: [leafletHook, noLabelsHook]}, async ({page}, t) => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regions-equivalence-')), file = path.join(dir, 'gainesville.pmtiles');
  try {
    const r = spawnSync('python3', ['-I', path.join(B.ROOT, 'tools', 'make_pmtiles.py'), path.join(B.ROOT, 'data', 'map-data.json'), '-o', file, '--name', 'Gainesville (bundled data)', '--attribution', '(c) OpenStreetMap contributors', '--license', 'ODbL 1.0'], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    const packageBytes = fs.readFileSync(file);

    await B.analyze(page, GAINESVILLE.file);
    await regionsIdle(page);
    assert.equal((await B.snapshot(page)).layer.superseded, false);
    assert.match(await page.innerText('#coverageNote'), /12,671 local map features/);

    // The bundled picture at three zooms, kept in the page: the final five-mile view, a neighbourhood, and street level (where
    // buildings, footpaths and points are all drawn).
    const ZOOMS = [null, 15.5, 17.2];
    const go = async z => {
      await page.evaluate(zoom => {
        const map = window.__leafletMap;
        window.__home = window.__home || {center: map.getCenter(), zoom: map.getZoom()};
        map.setView(window.__home.center, zoom === null ? window.__home.zoom : zoom, {animate: false});
      }, z);
      await B.sleep(250);
    };
    await page.evaluate(() => {
      window.__grab = () => {
        const c = document.querySelector('#map canvas.trace-canvas'), copy = document.createElement('canvas');
        copy.width = c.width; copy.height = c.height;
        const g = copy.getContext('2d', {willReadFrequently: true});
        g.drawImage(c, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      window.__bundled = {};
    });
    for (const z of ZOOMS) {await go(z); await page.evaluate(zoom => {window.__bundled[String(zoom)] = window.__grab();}, z);}
    const lumaDiff = z => page.evaluate(zoom => {
      const a = window.__bundled[String(zoom)], b = window.__grab();
      const luma = (d, i) => d[i + 3] > 200 ? 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] : 0;
      const n = a.length / 4;
      // "drawn" is anything visibly brighter than the dark-red ground in either picture; "differ" is a change of more than 24 luma levels.
      let differ = 0, drawn = 0, litA = 0, litB = 0, sumAbs = 0;
      for (let p = 0; p < n; p++) {
        const la = luma(a, p * 4), lb = luma(b, p * 4), d = Math.abs(la - lb);
        sumAbs += d;
        if (la >= 30 || lb >= 30) drawn++;
        if (d > 24) differ++;
        if (la >= 60) litA++;
        if (lb >= 60) litB++;
      }
      return {pixels: n, drawn, differ, differFraction: differ / n, differOfDrawn: differ / drawn, meanAbsDifference: sumAbs / n, litBundled: litA, litPackage: litB};
    }, z);

    assert.equal((await install(page, packageBytes, {name: 'gainesville.pmtiles'})).kind, 'ok');
    await regionsIdle(page);
    const rows = {};
    for (const z of ZOOMS) {
      await go(z);
      await regionsIdle(page);
      await page.waitForFunction(() => {const l = window.MetaTrace.snapshot().layer; return l.superseded === true && l.regionTiles > 0;});
      await B.sleep(500);
      const d = await lumaDiff(z), s = await B.snapshot(page);
      rows[z === null ? 'final view (map zoom ' + s.camera.zoom.toFixed(2) + ')' : 'zoom ' + z] = {...d, regionTiles: s.layer.regionTiles, regionMs: +s.layer.regionMs.toFixed(2)};
      assert.equal(s.regions.failed, 0);
    }
    B.record('regions-equivalence.json', {environment: 'headless Chromium, software rasterisation, 1440x900', package: {bytes: packageBytes.length, converter: r.stdout.match(/"tiles": (\d+)/)[1] + ' tiles'}, note: 'the same view drawn by the bundled renderer and then by the converted package, geometry only (label selection is switched off in this page)', rows});
    // What still differs is small and explained: edge pixels move by a fraction of a pixel (the package keeps coordinates on a 4096 grid and
    // simplifies the lower zooms), and the one building the bundled data flags as highlighted is drawn plain, since a package carries no such flag.
    for (const [name, d] of Object.entries(rows)) {
      assert.ok(d.differFraction < 0.005, name + ': the two pictures differ in ' + (d.differFraction * 100).toFixed(2) + ' % of all pixels');
      assert.ok(d.differOfDrawn < 0.03, name + ': ' + (d.differOfDrawn * 100).toFixed(1) + ' % of the drawn pixels differ');
      assert.ok(d.meanAbsDifference < 1.5, name + ': mean difference ' + d.meanAbsDifference.toFixed(2) + ' luma levels');
      assert.ok(Math.abs(d.litPackage - d.litBundled) / d.litBundled < 0.12, name + ': bright pixels ' + d.litBundled + ' bundled, ' + d.litPackage + ' package');
    }
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

/* ============================== a real third-party package: the Protomaps basemap sample for Florence ============================== */

const FLORENCE = {lat: 43 + 46 / 60 + 23.16 / 3600, lon: 11 + 15 / 60 + 20.88 / 3600, file: 'gps-florence-duomo.jpg'};
const REAL_FILE = path.join(B.ROOT, 'data', 'samples', 'protomaps-basemap-firenze.pmtiles');
/** The names on screen once label selection has stopped changing (it runs on a 250 ms timer after the view or the tiles change). */
async function settledNames(page) {
  let last = '';
  for (let i = 0; i < 20; i++) {
    await B.sleep(350);
    const now = (await B.snapshot(page)).layer.labelNames;
    if (JSON.stringify(now) === last) return now;
    last = JSON.stringify(now);
  }
  return JSON.parse(last);
}

scenario('a real Protomaps basemap (Florence, from the PMTiles repository): streets, the Arno, names and businesses appear, the credit reads as text, and the frame is five miles', {motion: 'fast', init: [leafletHook]}, async ({page}) => {
  const verdict = await install(page, fs.readFileSync(REAL_FILE), {name: 'protomaps-basemap-firenze.pmtiles', keep: false});
  assert.equal(verdict.kind, 'ok');
  assert.match(verdict.text, /Added "Protomaps Basemap"/);
  assert.doesNotMatch(verdict.text, /test pattern/i, 'a real package is not described as a generated one');
  await page.click('#mapData');
  assert.match(await page.innerText('#mapDataList'), /Protomaps Basemap[\s\S]*zoom 0–15[\s\S]*92 tiles[\s\S]*© OpenStreetMap contributors/, 'the dialog shows the credit as text');
  assert.doesNotMatch(await page.innerText('#mapDataList'), /&copy;|&amp;/);
  await page.click('#mapDataClose');

  await B.analyze(page, FLORENCE.file);
  await regionsIdle(page);
  await page.waitForFunction(() => window.MetaTrace.snapshot().layer.regionTiles > 0);
  await B.sleep(600);
  const s = await B.snapshot(page);
  assert.equal(s.coverage, 'OFFLINE / STREETS');
  assert.equal(s.regions.failed, 0, 'no tile of the real archive failed to read, decode or adapt');
  assert.equal(await page.innerText('#coverageNote'), 'Streets and buildings from "Protomaps Basemap". Map data: © OpenStreetMap contributors. Coordinates come from the image.');
  assert.equal(s.view, 'map');
  await B.expectFrame(page, FLORENCE.lat, FLORENCE.lon, 'Florence: ', {renderer: 'map'});

  // The five-mile view: the road network and the names a person looks for first.
  const lines = await settledLinework(page);
  const names = await settledNames(page);
  B.record('regions-real-florence.json', {package: 'protomaps-basemap-firenze.pmtiles, Protomaps basemap 3.7.1, 6,601,156 bytes', finalView: {lineworkPixels: lines, names}});
  await B.save(page, 'real-florence-1-five-mile-view.png');
  assert.ok(lines > 4000, 'bright linework pixels in the five-mile view: ' + lines + ' (1,593 with the adapter that did not read the "pmap:" prefix: the Arno and a few outlines, and no names at all)');
  assert.ok(names.some(n => n === 'waterway: Fiume Arno'), 'the river is named: ' + names.join(' | '));
  assert.ok(names.filter(n => n.startsWith('place: ')).length >= 5, 'places are named: ' + names.join(' | '));

  // Street level: street names, then the businesses and landmarks.
  await page.evaluate(() => window.__leafletMap.setZoom(15.5, {animate: false}));
  await regionsIdle(page);
  const streets = await settledNames(page);
  await B.save(page, 'real-florence-2-street-names.png');
  assert.ok(streets.filter(n => n.startsWith('road: ')).length >= 10, 'street names at zoom 15.5: ' + streets.join(' | '));
  await page.evaluate(() => window.__leafletMap.setZoom(17.5, {animate: false}));
  await regionsIdle(page);
  const close = await settledNames(page);
  await B.save(page, 'real-florence-3-landmarks.png');
  assert.ok(close.includes('poi: Cupola del Brunelleschi') && close.includes('poi: Campanile di Giotto'), 'landmarks and businesses at zoom 17.5: ' + close.join(' | '));
  assert.equal((await B.snapshot(page)).regions.failed, 0);
});

scenario('outside the real package\'s box the same file says so: the Florence package adds nothing in Sydney and nothing is claimed', {motion: 'fast'}, async ({page}) => {
  assert.equal((await install(page, fs.readFileSync(REAL_FILE), {name: 'protomaps-basemap-firenze.pmtiles', keep: false})).kind, 'ok');
  await B.analyze(page, 'gps-sydney.jpg');
  assert.equal((await B.snapshot(page)).coverage, 'OFFLINE / OUTLINES');
  assert.match(await page.innerText('#coverageNote'), /No offline roads or buildings are installed for this area/);
  assert.equal(await page.isVisible('#coverageAdd'), true);
});
